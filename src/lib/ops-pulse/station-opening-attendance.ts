import { loadDailyWorkerSnapshot } from "@/lib/biometric/attendance";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { firstOpeningPunches, physicalPunchLocation, type OpeningPunch, type PhysicalPunch } from "./station-opening-punches";

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

export async function loadStationOpeningAttendance(
  companyId: string,
  sourceDate: string,
  locations: { id: string; station_code: string }[],
  windows: Map<string, { start: string; end: string }>
) {
  if (!supabaseAdmin || !locations.length) return new Map<string, OpeningPunch>();
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
    candidates.push({ locationId, time: row.in_time, enrolmentId: row.enrolment_id,
      employeeId: row.employee_id, fieldExecutiveId: row.field_executive_id,
      name: row.worker_name, workerCode: row.employee_code });
  }
  const openings = firstOpeningPunches(candidates, windows);
  const missingNames = [...openings.values()].filter((punch) => !punch.name);
  if (missingNames.length) {
    const enrolments = await db.from("biometric_enrolments")
      .select("enrolment_id,profile_type,account_id,employee_id,field_executive_id,effective_from,effective_to")
      .eq("company_id", companyId).in("enrolment_id", [...new Set(missingNames.map((row) => row.enrolmentId))])
      .lte("effective_from", sourceDate).or(`effective_to.is.null,effective_to.gte.${sourceDate}`).order("effective_from", { ascending: false });
    if (enrolments.error) throw new Error(enrolments.error.message);
    await Promise.all(missingNames.map(async (punch) => {
      const enrolment = (enrolments.data ?? []).find((row) => row.enrolment_id === punch.enrolmentId);
      const worker = await loadDailyWorkerSnapshot({ companyId,
        employeeId: punch.employeeId ?? enrolment?.employee_id,
        fieldExecutiveId: punch.fieldExecutiveId ?? enrolment?.field_executive_id,
        profileType: punch.profileType ?? enrolment?.profile_type,
        accountId: punch.accountId ?? enrolment?.account_id });
      punch.name = worker.workerName;
      punch.workerCode = worker.workerCode ?? punch.workerCode;
    }));
  }
  return openings;
}
