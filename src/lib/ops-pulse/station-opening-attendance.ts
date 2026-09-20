import { loadDailyWorkerSnapshot } from "@/lib/biometric/attendance";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { isPeopleDesignation, openingProfileLabel, peopleProfileReference, peopleOpeningPunches, physicalPunchLocation, type OpeningPunch, type PhysicalPunch, type StationOpeningAttendance } from "./station-opening-punches";

type DailyOpening = {
  enrolment_id: string;
  employee_id: string | null;
  field_executive_id: string | null;
  worker_name: string | null;
  employee_code: string | null;
  in_time: string;
  punch_in_location_id: string | null;
  punch_in_station_code: string | null;
  work_mode: string | null;
};

type AttendanceOpening = PhysicalPunch & {
  enrolment_id: string;
  employee_id: string | null;
  field_executive_id: string | null;
  profile_type: string | null;
  account_id: string | null;
  punch_time: string;
};

async function paged<T>(query: (offset: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>) {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const result = await query(offset);
    if (result.error) throw new Error(result.error.message);
    const page = (result.data ?? []) as T[];
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

const inValues = (values: string[]) => `(${values.map((value) => JSON.stringify(value)).join(",")})`;
const chunks = (values: string[]) => Array.from({ length: Math.ceil(values.length / 200) }, (_, index) => values.slice(index * 200, index * 200 + 200));

export async function loadStationOpeningAttendance(
  companyId: string,
  sourceDate: string,
  locations: { id: string; station_code: string }[],
  windows: Map<string, { start: string; end: string }>
) {
  if (!supabaseAdmin || !locations.length) return new Map<string, StationOpeningAttendance>();
  const db = supabaseAdmin;
  const locationIds = locations.map((row) => row.id);
  const locationByCode = new Map(locations.map((row) => [row.station_code, row.id]));
  const devices = await db.from("biometric_devices").select("id,device_serial,location_id")
    .eq("company_id", companyId).in("location_id", locationIds);
  if (devices.error) throw new Error(devices.error.message);
  // Include inactive devices: their historical punches still identify a site.
  const deviceLocations = new Map<string, string>();
  const serialLocations = new Map<string, string>();
  for (const device of devices.data ?? []) {
    if (!device.location_id) continue;
    deviceLocations.set(device.id, device.location_id);
    if (device.device_serial) serialLocations.set(device.device_serial, device.location_id);
  }
  const scopes = [`and(source.eq.app_gps,geofence_status.eq.inside,location_id.in.${inValues(locationIds)})`];
  if (deviceLocations.size) scopes.push(`device_id.in.${inValues([...deviceLocations.keys()])}`);
  if (serialLocations.size) scopes.push(`and(device_id.is.null,device_serial.in.${inValues([...serialLocations.keys()])})`);

  const [punches, daily] = await Promise.all([
    paged<AttendanceOpening>((offset) => db.from("attendance_punches")
      .select("enrolment_id,employee_id,field_executive_id,profile_type,account_id,punch_time,device_id,device_serial,location_id,source,geofence_status")
      .eq("company_id", companyId).eq("punch_date", sourceDate).eq("calculated", true)
      .ilike("punch_label", "In%").or(scopes.join(","))
      .order("punch_time").order("id").range(offset, offset + 999)),
    paged<DailyOpening>((offset) => db.from("attendance_daily")
      .select("enrolment_id,employee_id,field_executive_id,worker_name,employee_code,in_time,punch_in_location_id,punch_in_station_code,work_mode")
      .eq("company_id", companyId).eq("punch_date", sourceDate).not("in_time", "is", null)
      .or(`punch_in_location_id.in.${inValues(locationIds)},and(punch_in_location_id.is.null,punch_in_station_code.in.${inValues([...locationByCode.keys()])})`)
      .order("in_time").order("id").range(offset, offset + 999))
  ]);
  const dailyByEnrolment = new Map(daily.map((row) => [row.enrolment_id, row]));
  const candidates: OpeningPunch[] = [];
  for (const punch of punches) {
    const snapshot = dailyByEnrolment.get(punch.enrolment_id);
    if (snapshot?.work_mode === "wfh") continue;
    const locationId = physicalPunchLocation(punch, deviceLocations, serialLocations);
    if (!locationId) continue;
    candidates.push({
      locationId, time: punch.punch_time, enrolmentId: punch.enrolment_id,
      employeeId: punch.employee_id, fieldExecutiveId: punch.field_executive_id,
      profileType: punch.profile_type, accountId: punch.account_id,
      name: snapshot?.worker_name, workerCode: snapshot?.employee_code
    });
  }
  // Retain approved manual/legacy opening records only when their physical
  // punch location is known. Never fall back to assigned location_id/station_code.
  for (const row of daily) {
    if (row.work_mode === "wfh") continue;
    const locationId = row.punch_in_location_id ?? locationByCode.get(row.punch_in_station_code ?? "");
    if (!locationId) continue;
    // Reuse the identity on the actual event when a daily snapshot duplicates it.
    if (candidates.some((punch) => punch.locationId === locationId && punch.enrolmentId === row.enrolment_id
      && Date.parse(punch.time) === Date.parse(row.in_time))) continue;
    candidates.push({ locationId, time: row.in_time, enrolmentId: row.enrolment_id,
      employeeId: row.employee_id, fieldExecutiveId: row.field_executive_id,
      name: row.worker_name, workerCode: row.employee_code });
  }
  // Resolve every candidate's profile before selecting the first People punch.
  // Daily rows can already have a name while still missing their profile link.
  const unresolved = candidates.filter((punch) => !punch.profileType || (!punch.accountId && !punch.employeeId));
  for (const ids of chunks([...new Set(unresolved.map((punch) => punch.enrolmentId))])) {
    const enrolments = await db.from("biometric_enrolments")
      .select("enrolment_id,profile_type,account_id,employee_id,field_executive_id,effective_from,effective_to")
      .eq("company_id", companyId).in("enrolment_id", ids)
      .lte("effective_from", sourceDate).or(`effective_to.is.null,effective_to.gte.${sourceDate}`).order("effective_from", { ascending: false });
    if (enrolments.error) throw new Error(enrolments.error.message);
    for (const punch of unresolved.filter((row) => ids.includes(row.enrolmentId))) {
      const enrolment = (enrolments.data ?? []).find((row) => row.enrolment_id === punch.enrolmentId);
      if (!punch.profileType) {
        punch.profileType = enrolment?.profile_type ?? (punch.employeeId ? "employee" : punch.fieldExecutiveId ? "field_executive" : null);
        punch.accountId = enrolment?.account_id ?? punch.accountId;
        punch.employeeId = enrolment?.employee_id ?? punch.employeeId;
        punch.fieldExecutiveId = enrolment?.field_executive_id ?? punch.fieldExecutiveId;
      } else if (enrolment?.profile_type === punch.profileType) {
        punch.accountId ??= enrolment.account_id;
      }
    }
  }
  const [designationResult, categoryResult] = await Promise.all([
    db.from("designations").select("id,code,name,designation_category_id,onboarding_categories").eq("company_id", companyId),
    db.from("designation_categories").select("id,people_module").eq("company_id", companyId)
  ]);
  if (designationResult.error) throw new Error(designationResult.error.message);
  if (categoryResult.error) throw new Error(categoryResult.error.message);
  const categories = new Map((categoryResult.data ?? []).map((row) => [row.id, row.people_module]));
  const designations = designationResult.data ?? [];
  const references = candidates.flatMap((punch) => { const ref = peopleProfileReference(punch); return ref ? [ref] : []; });
  const people = new Map<string, { name: string | null; code: string | null }>();
  const profileLabels = new Map<string, string>();
  await Promise.all((["employees", "contractors"] as const).map(async (table) => {
    for (const ids of chunks([...new Set(references.filter((ref) => ref.table === table).map((ref) => ref.id))])) {
      const result = await db.from(table).select(table === "employees" ? "id,full_name,employee_code,designation_id" : "id,full_name,dropx_id,designation")
        .eq("company_id", companyId).in("id", ids);
      if (result.error) throw new Error(result.error.message);
      for (const profile of (result.data ?? []) as unknown as { id: string; full_name: string | null; employee_code?: string | null; dropx_id?: string | null; designation_id?: string | null; designation?: string | null }[]) {
        const designation = table === "employees" ? designations.find((row) => row.id === profile.designation_id)
          : designations.find((row) => [row.code, row.name].some((value) => value && value.trim().toLowerCase() === profile.designation?.trim().toLowerCase()));
        if (designation) profileLabels.set(`${table}:${profile.id}`, `${designation.name} (${designation.code})`);
        if (designation && isPeopleDesignation(categories.get(designation.designation_category_id) as string | null, designation.onboarding_categories, table)) {
          people.set(`${table}:${profile.id}`, { name: profile.full_name, code: profile.employee_code ?? profile.dropx_id ?? null });
        }
      }
    }
  }));
  for (const punch of candidates) {
    const ref = peopleProfileReference(punch);
    const person = ref ? people.get(`${ref.table}:${ref.id}`) : null;
    punch.isPeopleProfile = Boolean(person);
    punch.profileLabel = person ? "People profile" : (ref && profileLabels.get(`${ref.table}:${ref.id}`)) || openingProfileLabel(punch.profileType);
    if (person) {
      punch.name = person.name;
      punch.workerCode = person.code;
    }
  }
  const openings = peopleOpeningPunches(candidates, windows);
  const exceptions = [...openings.values()].flatMap((opening) => opening.firstOtherPunch ? [opening.firstOtherPunch] : []);
  await Promise.all(exceptions.map(async (punch) => {
    // Show the actual designation (DA, ODCD, etc.) without treating it as People.
    const table = punch.profileType === "contractor" ? "contractors"
      : ["workforce", "field_executive"].includes(punch.profileType ?? "") ? "workforce" : null;
    if (table && (punch.accountId || punch.fieldExecutiveId)) {
      const profile = await db.from(table).select("full_name,dropx_id,designation")
        .eq("company_id", companyId).eq("id", punch.accountId ?? punch.fieldExecutiveId!).maybeSingle();
      if (profile.error) throw new Error(profile.error.message);
      if (profile.data) {
        const profileData = profile.data;
        punch.name = profileData.full_name ?? punch.name;
        punch.workerCode = profileData.dropx_id ?? punch.workerCode;
        const designation = designations.find((row) => [row.code, row.name].some((value) => value && value.trim().toLowerCase() === profileData.designation?.trim().toLowerCase()));
        punch.profileLabel = designation?.code && designation.code !== "DA"
          ? `${designation.name} (${designation.code})` : openingProfileLabel(punch.profileType, profile.data.designation);
      }
    }
    if (!punch.name) {
      const worker = await loadDailyWorkerSnapshot({ companyId,
        employeeId: peopleProfileReference(punch)?.table === "employees" ? peopleProfileReference(punch)?.id : null, fieldExecutiveId: punch.fieldExecutiveId,
        profileType: punch.profileType, accountId: punch.accountId });
      punch.name = worker.workerName;
      punch.workerCode = worker.workerCode ?? punch.workerCode;
    }
  }));
  return openings;
}
