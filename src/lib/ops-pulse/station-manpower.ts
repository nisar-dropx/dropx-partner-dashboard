import "server-only";
import type { CodLocationRow } from "@/lib/ops-pulse/cod";
import { supabaseAdmin } from "@/lib/supabase-admin";

type Relation<T> = T | T[] | null | undefined;
type WorkerType = "employee" | "contractor";

type Shift = {
  id: string;
  name: string;
  code: string;
  start_time: string;
  end_time: string;
  grace_in_minutes: number | null;
  grace_out_minutes: number | null;
};

type WorkAssignmentRow = {
  engagement_id: string;
  location_id: string | null;
  designation_id: string | null;
  position_title: string | null;
  effective_from: string;
};

type AttendanceRow = {
  enrolment_id: string;
  worker_type: string | null;
  employee_id: string | null;
  contractor_id: string | null;
  in_time: string | null;
  out_time: string | null;
  punch_count: number | null;
  work_minutes: number | null;
  status: string | null;
};

type AttendancePunchRow = {
  enrolment_id: string;
  punch_time: string;
  punch_label: string | null;
  location_id: string | null;
  device_id: string | null;
};

export type OpsPunchLocation = {
  id: string;
  code: string;
  name: string | null;
};

export type OpsStationManpowerPerson = {
  id: string;
  workerType: WorkerType;
  code: string;
  name: string;
  designation: string;
  designationCode: string;
  locationId: string;
  availability: "Working" | "Completed" | "On leave" | "Roster off" | "Not reported";
  today: {
    reported: boolean;
    lateMinutes: number;
    workMinutes: number;
    missingPunch: boolean;
    rosterDayType: string | null;
    shiftName: string | null;
    shiftStartTime: string | null;
    shiftEndTime: string | null;
    shiftSource: string | null;
    inTime: string | null;
    outTime: string | null;
    expectedLocation: OpsPunchLocation;
    inLocation: OpsPunchLocation | null;
    outLocation: OpsPunchLocation | null;
    hasLocationMismatch: boolean;
  };
};

export type OpsStationManpowerResult = {
  asOf: string;
  people: OpsStationManpowerPerson[];
};

function relation<T>(value: Relation<T>): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function biometricVariants(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) return [];
  const normalized = raw.replace(/^0+(?=\d)/, "") || "0";
  return [...new Set([raw, normalized, normalized.padStart(6, "0"), normalized.padStart(8, "0")])];
}

function biometricKey(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  return raw ? raw.replace(/^0+(?=\d)/, "") || "0" : "";
}

function shortDesignation(value: string | null | undefined) {
  const words = String(value ?? "").trim().replace(/[()./-]+/g, " ").split(/\s+/).filter(Boolean);
  if (!words.length) return "—";
  return words.filter((word) => !/^(and|of|the)$/i.test(word)).map((word) => word[0]).join("").toUpperCase().slice(0, 6) || "—";
}

function indiaPunchMinutes(value: string | null | undefined, punchDate: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Asia/Kolkata"
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  const localDate = `${part("year")}-${part("month")}-${part("day")}`;
  const base = Date.parse(`${punchDate}T00:00:00Z`);
  const local = Date.parse(`${localDate}T00:00:00Z`);
  const dayOffset = Number.isNaN(base) || Number.isNaN(local) ? 0 : Math.round((local - base) / 86400000);
  return Number(part("hour")) * 60 + Number(part("minute")) + dayOffset * 1440;
}

function shiftStartMinutes(value: string | null | undefined) {
  const match = String(value ?? "").match(/^(\d{2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function isoWeekday(value: string) {
  const day = new Date(`${value}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

export async function loadOpsStationManpower(
  companyId: string,
  locations: CodLocationRow[],
  asOf: string
): Promise<OpsStationManpowerResult> {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  if (!locations.length) return { asOf, people: [] };
  const admin = supabaseAdmin;
  const locationIds = new Set(locations.map((location) => location.id));

  const [employeesResult, contractorsResult, engagementsResult, designationsResult] = await Promise.all([
    admin.from("employees")
      .select("id,employee_code,full_name,biometric_id,location_id,designation_id")
      .eq("company_id", companyId).eq("is_active", true).is("deleted_at", null).limit(5000),
    admin.from("contractors")
      .select("id,dropx_id,full_name,biometric_id,location_id,designation")
      .eq("company_id", companyId).eq("is_active", true).is("deleted_at", null).limit(5000),
    admin.from("hr_engagements")
      .select("id,worker_type,employee_id,contractor_id")
      .eq("company_id", companyId).eq("status", "active").limit(5000),
    admin.from("designations")
      .select("id,name,code")
      .eq("company_id", companyId).eq("is_active", true).limit(1000)
  ]);
  const initialError = employeesResult.error ?? contractorsResult.error ?? engagementsResult.error ?? designationsResult.error;
  if (initialError) throw new Error(initialError.message);

  const engagements = engagementsResult.data ?? [];
  const engagementIds = engagements.map((engagement) => engagement.id);
  const assignmentsResult = engagementIds.length ? await admin.from("hr_work_assignments")
    .select("engagement_id,location_id,designation_id,position_title,effective_from")
    .eq("company_id", companyId).eq("is_primary", true)
    .in("engagement_id", engagementIds)
    .lte("effective_from", asOf)
    .or(`effective_to.is.null,effective_to.gte.${asOf}`)
    .order("effective_from", { ascending: false })
    .limit(5000) : { data: [], error: null };
  if (assignmentsResult.error) throw new Error(assignmentsResult.error.message);

  const designationById = new Map((designationsResult.data ?? []).map((designation) => [designation.id, { name: designation.name, code: designation.code }]));
  const assignmentByEngagement = new Map<string, WorkAssignmentRow>();
  for (const assignment of (assignmentsResult.data ?? []) as WorkAssignmentRow[]) {
    if (!assignmentByEngagement.has(assignment.engagement_id)) assignmentByEngagement.set(assignment.engagement_id, assignment);
  }
  const engagementByWorker = new Map<string, typeof engagements[number]>();
  for (const engagement of engagements) {
    const workerId = engagement.worker_type === "employee" ? engagement.employee_id : engagement.contractor_id;
    if (workerId) engagementByWorker.set(`${engagement.worker_type}:${workerId}`, engagement);
  }

  const rawPeople = [
    ...(employeesResult.data ?? []).map((employee) => {
      const engagement = engagementByWorker.get(`employee:${employee.id}`);
      const assignment = engagement ? assignmentByEngagement.get(engagement.id) : null;
      const locationId = assignment?.location_id ?? employee.location_id;
      const designation = (assignment?.designation_id ? designationById.get(assignment.designation_id)?.name : null)
        ?? assignment?.position_title
        ?? (employee.designation_id ? designationById.get(employee.designation_id)?.name : null)
        ?? "Unassigned";
      const designationCode = (assignment?.designation_id ? designationById.get(assignment.designation_id)?.code : null)
        ?? (employee.designation_id ? designationById.get(employee.designation_id)?.code : null)
        ?? shortDesignation(designation);
      return {
        id: employee.id,
        workerType: "employee" as const,
        code: employee.employee_code ?? "—",
        name: employee.full_name,
        biometricId: employee.biometric_id,
        locationId,
        designation,
        designationCode
      };
    }),
    ...(contractorsResult.data ?? []).map((contractor) => {
      const engagement = engagementByWorker.get(`contractor:${contractor.id}`);
      const assignment = engagement ? assignmentByEngagement.get(engagement.id) : null;
      const locationId = assignment?.location_id ?? contractor.location_id;
      const designation = (assignment?.designation_id ? designationById.get(assignment.designation_id)?.name : null)
        ?? assignment?.position_title
        ?? contractor.designation
        ?? "Unassigned";
      const designationCode = (assignment?.designation_id ? designationById.get(assignment.designation_id)?.code : null)
        ?? shortDesignation(designation);
      return {
        id: contractor.id,
        workerType: "contractor" as const,
        code: contractor.dropx_id ?? "—",
        name: contractor.full_name,
        biometricId: contractor.biometric_id,
        locationId,
        designation,
        designationCode
      };
    })
  ].filter((person): person is typeof person & { locationId: string } => Boolean(person.locationId && locationIds.has(person.locationId)));

  const employeeIds = rawPeople.filter((person) => person.workerType === "employee").map((person) => person.id);
  const workerIds = rawPeople.map((person) => person.id);
  const enrolmentIds = [...new Set(rawPeople.flatMap((person) => biometricVariants(person.biometricId)))];
  const [attendanceResult, punchResult, datedRosterResult, weeklyPlansResult, leaveResult] = await Promise.all([
    admin.from("attendance_daily")
      .select("enrolment_id,worker_type,employee_id,contractor_id,in_time,out_time,punch_count,work_minutes,status")
      .eq("company_id", companyId).eq("punch_date", asOf).neq("status", "U").limit(5000),
    enrolmentIds.length ? admin.from("attendance_punches")
      .select("enrolment_id,punch_time,punch_label,location_id,device_id")
      .eq("company_id", companyId).eq("punch_date", asOf).eq("calculated", true)
      .in("enrolment_id", enrolmentIds).order("punch_time", { ascending: true }).limit(5000) : Promise.resolve({ data: [], error: null }),
    workerIds.length ? admin.from("hr_roster_entries")
      .select("worker_type,worker_id,roster_date,day_type,hr_shifts(id,name,code,start_time,end_time,grace_in_minutes,grace_out_minutes),hr_roster_plans!inner(status,roster_kind,effective_from,superseded_at,revision_no)")
      .eq("company_id", companyId).eq("roster_date", asOf).in("worker_id", workerIds).eq("hr_roster_plans.status", "approved").eq("hr_roster_plans.roster_kind", "dated").limit(5000) : Promise.resolve({ data: [], error: null }),
    admin.from("hr_roster_plans")
      .select("id,status,roster_kind,effective_from,superseded_at,revision_no")
      .eq("company_id", companyId).eq("status", "approved").eq("roster_kind", "recurring_weekly").in("location_id", locations.map((location) => location.id)).lte("effective_from", asOf).limit(1000),
    employeeIds.length ? admin.from("hr_leave_requests")
      .select("employee_id").eq("company_id", companyId).eq("status", "approved").in("employee_id", employeeIds).lte("start_date", asOf).gte("end_date", asOf).limit(5000) : Promise.resolve({ data: [], error: null })
  ]);
  const detailError = attendanceResult.error ?? punchResult.error ?? datedRosterResult.error ?? weeklyPlansResult.error ?? leaveResult.error;
  if (detailError) throw new Error(detailError.message);
  const punchRows = (punchResult.data ?? []) as AttendancePunchRow[];
  const punchDeviceIds = [...new Set(punchRows.map((punch) => punch.device_id).filter((id): id is string => Boolean(id)))];
  const punchDevicesResult = punchDeviceIds.length ? await admin.from("biometric_devices")
    .select("id,location_id")
    .eq("company_id", companyId).in("id", punchDeviceIds).limit(5000) : { data: [], error: null };
  if (punchDevicesResult.error) throw new Error(punchDevicesResult.error.message);
  const deviceLocationById = new Map((punchDevicesResult.data ?? []).map((device) => [device.id, device.location_id]));
  const punchLocationIds = [...new Set([
    ...punchRows.map((punch) => punch.location_id),
    ...(punchDevicesResult.data ?? []).map((device) => device.location_id)
  ].filter((id): id is string => Boolean(id)))];
  const externalPunchLocationsResult = punchLocationIds.length ? await admin.from("stations")
    .select("id,station_code,station_name")
    .eq("company_id", companyId).in("id", punchLocationIds).limit(5000) : { data: [], error: null };
  if (externalPunchLocationsResult.error) throw new Error(externalPunchLocationsResult.error.message);
  const locationById = new Map<string, OpsPunchLocation>();
  for (const location of [...locations, ...(externalPunchLocationsResult.data ?? [])]) {
    locationById.set(location.id, { id: location.id, code: location.station_code, name: location.station_name ?? null });
  }
  const punchesByEnrolment = new Map<string, AttendancePunchRow[]>();
  for (const punch of punchRows) {
    const key = biometricKey(punch.enrolment_id);
    if (!key) continue;
    const rows = punchesByEnrolment.get(key) ?? [];
    rows.push(punch);
    punchesByEnrolment.set(key, rows);
  }
  const activeWeeklyPlans = (weeklyPlansResult.data ?? []).filter((plan) => !plan.superseded_at || asOf < plan.superseded_at);
  const activeWeeklyPlanIds = activeWeeklyPlans.map((plan) => plan.id);
  const weeklyEntriesResult = activeWeeklyPlanIds.length && workerIds.length ? await admin.from("hr_roster_entries")
    .select("plan_id,worker_type,worker_id,roster_date,day_type,hr_shifts(id,name,code,start_time,end_time,grace_in_minutes,grace_out_minutes)")
    .eq("company_id", companyId).in("plan_id", activeWeeklyPlanIds).in("worker_id", workerIds).limit(5000) : { data: [], error: null };
  if (weeklyEntriesResult.error) throw new Error(weeklyEntriesResult.error.message);
  const weeklyPlanById = new Map(activeWeeklyPlans.map((plan) => [plan.id, plan]));
  const rosterRows = [
    ...(datedRosterResult.data ?? []),
    ...(weeklyEntriesResult.data ?? []).filter((row) => isoWeekday(row.roster_date) === isoWeekday(asOf)).map((row) => ({
      ...row,
      roster_date: asOf,
      hr_roster_plans: weeklyPlanById.get(row.plan_id) ?? null
    }))
  ];

  const attendanceByWorker = new Map<string, AttendanceRow>();
  const personByBiometric = new Map<string, typeof rawPeople[number]>();
  for (const person of rawPeople) for (const variant of biometricVariants(person.biometricId)) personByBiometric.set(`${person.workerType}:${variant}`, person);
  for (const attendance of (attendanceResult.data ?? []) as AttendanceRow[]) {
    const normalizedWorkerType = String(attendance.worker_type ?? "").toLowerCase();
    const workerType: WorkerType | null = normalizedWorkerType === "employee"
      ? "employee"
      : normalizedWorkerType === "individual_contract" || (normalizedWorkerType === "contractor" && Boolean(attendance.contractor_id))
        ? "contractor"
        : null;
    // People attendance calls independent contractors `individual_contract`.
    // Legacy bare `contractor` rows without contractor_id are Workforce data.
    if (!workerType) continue;
    const workerId = workerType === "employee" ? attendance.employee_id : attendance.contractor_id;
    const biometricPerson = biometricVariants(attendance.enrolment_id).map((variant) => personByBiometric.get(`${workerType}:${variant}`)).find(Boolean);
    const key = workerId ? `${workerType}:${workerId}` : biometricPerson ? `${biometricPerson.workerType}:${biometricPerson.id}` : "";
    if (key) attendanceByWorker.set(key, attendance);
  }
  const leaveEmployeeIds = new Set((leaveResult.data ?? []).map((leave) => leave.employee_id));

  const people = rawPeople.map((person): OpsStationManpowerPerson => {
    const roster = rosterRows.filter((row) => {
      const plan = relation(row.hr_roster_plans as Relation<{ status: string; roster_kind: string | null; effective_from: string | null; superseded_at: string | null; revision_no: number | null }>);
      return row.worker_type === person.workerType && row.worker_id === person.id && plan?.status === "approved"
        && (!plan.effective_from || plan.effective_from <= asOf)
        && (!plan.superseded_at || asOf < plan.superseded_at);
    }).sort((left, right) => {
      const leftPlan = relation(left.hr_roster_plans as Relation<{ roster_kind: string | null; effective_from: string | null; revision_no: number | null }>);
      const rightPlan = relation(right.hr_roster_plans as Relation<{ roster_kind: string | null; effective_from: string | null; revision_no: number | null }>);
      const datedOrder = Number(rightPlan?.roster_kind === "dated") - Number(leftPlan?.roster_kind === "dated");
      return datedOrder || Number(rightPlan?.revision_no ?? 0) - Number(leftPlan?.revision_no ?? 0) || String(rightPlan?.effective_from ?? "").localeCompare(String(leftPlan?.effective_from ?? ""));
    })[0];
    const rosterShift = roster?.day_type === "working" ? relation(roster.hr_shifts as Relation<Shift>) : null;
    const shift = rosterShift;
    const shiftSource = rosterShift ? "Active approved roster" : null;
    const attendance = attendanceByWorker.get(`${person.workerType}:${person.id}`);
    const punches = punchesByEnrolment.get(biometricKey(attendance?.enrolment_id ?? person.biometricId)) ?? [];
    const sameInstant = (left: string | null | undefined, right: string) => Boolean(left) && new Date(left!).getTime() === new Date(right).getTime();
    const inPunch = punches.find((punch) => sameInstant(attendance?.in_time, punch.punch_time)) ?? punches[0] ?? null;
    const outPunch = attendance?.out_time
      ? punches.find((punch) => sameInstant(attendance.out_time, punch.punch_time)) ?? punches[punches.length - 1] ?? null
      : null;
    const expectedLocation = locationById.get(person.locationId) ?? { id: person.locationId, code: "Assigned location", name: null };
    // Legacy biometric rows store the person's assigned location on the punch.
    // The device mapping is the physical punch location and therefore wins for
    // biometric evidence. App/GPS punches have no device and use location_id.
    const evidenceLocationId = (punch: AttendancePunchRow | null) => punch
      ? (punch.device_id ? deviceLocationById.get(punch.device_id) : null) ?? punch.location_id
      : null;
    const inLocationId = evidenceLocationId(inPunch);
    const outLocationId = evidenceLocationId(outPunch);
    const inLocation = inLocationId ? locationById.get(inLocationId) ?? { id: inLocationId, code: "Unknown location", name: null } : null;
    const outLocation = outLocationId ? locationById.get(outLocationId) ?? { id: outLocationId, code: "Unknown location", name: null } : null;
    const hasLocationMismatch = Boolean(
      (inLocation && inLocation.id !== person.locationId)
      || (outLocation && outLocation.id !== person.locationId)
      || (inLocation && outLocation && inLocation.id !== outLocation.id)
    );
    const actualStart = indiaPunchMinutes(attendance?.in_time, asOf);
    const scheduledStart = shiftStartMinutes(shift?.start_time);
    const lateMinutes = actualStart !== null && scheduledStart !== null
      ? Math.max(0, actualStart - scheduledStart - Number(shift?.grace_in_minutes ?? 0))
      : 0;
    const reported = Boolean(attendance?.in_time);
    const missingPunch = reported && (Number(attendance?.punch_count ?? 0) < 2 || !attendance?.out_time);
    const onLeave = person.workerType === "employee" && leaveEmployeeIds.has(person.id);
    const availability = onLeave ? "On leave"
      : !reported && roster?.day_type === "weekly_off" ? "Roster off"
        : !reported ? "Not reported"
          : missingPunch ? "Working" : "Completed";
    return {
      id: person.id,
      workerType: person.workerType,
      code: person.code,
      name: person.name,
      designation: person.designation,
      designationCode: person.designationCode,
      locationId: person.locationId,
      availability,
      today: {
        reported,
        lateMinutes,
        workMinutes: Number(attendance?.work_minutes ?? 0),
        missingPunch,
        rosterDayType: roster?.day_type ? String(roster.day_type) : null,
        shiftName: shift ? `${shift.name} · ${shift.start_time.slice(0, 5)}-${shift.end_time.slice(0, 5)}` : null,
        shiftStartTime: shift?.start_time ?? null,
        shiftEndTime: shift?.end_time ?? null,
        shiftSource,
        inTime: attendance?.in_time ?? null,
        outTime: attendance?.out_time ?? null,
        expectedLocation,
        inLocation,
        outLocation,
        hasLocationMismatch
      }
    };
  }).sort((left, right) => left.name.localeCompare(right.name));

  return { asOf, people };
}
