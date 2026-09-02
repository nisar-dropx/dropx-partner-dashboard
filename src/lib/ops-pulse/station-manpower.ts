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

export type OpsStationManpowerPerson = {
  id: string;
  workerType: WorkerType;
  code: string;
  name: string;
  designation: string;
  locationId: string;
  availability: "Working" | "Completed" | "On leave" | "Roster off" | "Not reported";
  profileHref: string;
  today: {
    reported: boolean;
    lateMinutes: number;
    workMinutes: number;
    missingPunch: boolean;
    shiftName: string | null;
    shiftSource: string | null;
    inTime: string | null;
    outTime: string | null;
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
      .select("id,name")
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

  const designationById = new Map((designationsResult.data ?? []).map((designation) => [designation.id, designation.name]));
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
      return {
        id: employee.id,
        workerType: "employee" as const,
        code: employee.employee_code ?? "—",
        name: employee.full_name,
        biometricId: employee.biometric_id,
        locationId,
        designation: (assignment?.designation_id ? designationById.get(assignment.designation_id) : null)
          ?? assignment?.position_title
          ?? (employee.designation_id ? designationById.get(employee.designation_id) : null)
          ?? "Unassigned"
      };
    }),
    ...(contractorsResult.data ?? []).map((contractor) => {
      const engagement = engagementByWorker.get(`contractor:${contractor.id}`);
      const assignment = engagement ? assignmentByEngagement.get(engagement.id) : null;
      const locationId = assignment?.location_id ?? contractor.location_id;
      return {
        id: contractor.id,
        workerType: "contractor" as const,
        code: contractor.dropx_id ?? "—",
        name: contractor.full_name,
        biometricId: contractor.biometric_id,
        locationId,
        designation: (assignment?.designation_id ? designationById.get(assignment.designation_id) : null)
          ?? assignment?.position_title
          ?? contractor.designation
          ?? "Unassigned"
      };
    })
  ].filter((person): person is typeof person & { locationId: string } => Boolean(person.locationId && locationIds.has(person.locationId)));

  const employeeIds = rawPeople.filter((person) => person.workerType === "employee").map((person) => person.id);
  const contractorIds = rawPeople.filter((person) => person.workerType === "contractor").map((person) => person.id);
  const workerIds = rawPeople.map((person) => person.id);
  const [attendanceResult, rosterResult, employeeShiftsResult, contractorShiftsResult, leaveResult] = await Promise.all([
    admin.from("attendance_daily")
      .select("enrolment_id,worker_type,employee_id,contractor_id,in_time,out_time,punch_count,work_minutes,status")
      .eq("company_id", companyId).eq("punch_date", asOf).neq("status", "U").limit(5000),
    workerIds.length ? admin.from("hr_roster_entries")
      .select("worker_type,worker_id,roster_date,day_type,hr_shifts(id,name,code,start_time,end_time,grace_in_minutes,grace_out_minutes),hr_roster_plans(status)")
      .eq("company_id", companyId).eq("roster_date", asOf).in("worker_id", workerIds).limit(5000) : Promise.resolve({ data: [], error: null }),
    employeeIds.length ? admin.from("hr_employee_shift_assignments")
      .select("employee_id,effective_from,effective_to,hr_shifts(id,name,code,start_time,end_time,grace_in_minutes,grace_out_minutes)")
      .eq("company_id", companyId).in("employee_id", employeeIds).lte("effective_from", asOf).or(`effective_to.is.null,effective_to.gte.${asOf}`).order("effective_from", { ascending: false }).limit(5000) : Promise.resolve({ data: [], error: null }),
    contractorIds.length ? admin.from("hr_contractor_shift_assignments")
      .select("contractor_id,effective_from,effective_to,hr_shifts(id,name,code,start_time,end_time,grace_in_minutes,grace_out_minutes)")
      .eq("company_id", companyId).in("contractor_id", contractorIds).lte("effective_from", asOf).or(`effective_to.is.null,effective_to.gte.${asOf}`).order("effective_from", { ascending: false }).limit(5000) : Promise.resolve({ data: [], error: null }),
    employeeIds.length ? admin.from("hr_leave_requests")
      .select("employee_id").eq("company_id", companyId).eq("status", "approved").in("employee_id", employeeIds).lte("start_date", asOf).gte("end_date", asOf).limit(5000) : Promise.resolve({ data: [], error: null })
  ]);
  const detailError = attendanceResult.error ?? rosterResult.error ?? employeeShiftsResult.error ?? contractorShiftsResult.error ?? leaveResult.error;
  if (detailError) throw new Error(detailError.message);

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
    const roster = (rosterResult.data ?? []).find((row) => {
      const plan = relation(row.hr_roster_plans as Relation<{ status: string }>);
      return row.worker_type === person.workerType && row.worker_id === person.id && plan?.status === "approved";
    });
    const rosterShift = roster?.day_type === "working" ? relation(roster.hr_shifts as Relation<Shift>) : null;
    const effectiveAssignment = person.workerType === "employee"
      ? (employeeShiftsResult.data ?? []).find((row) => row.employee_id === person.id)
      : (contractorShiftsResult.data ?? []).find((row) => row.contractor_id === person.id);
    const effectiveShift = relation(effectiveAssignment?.hr_shifts as Relation<Shift>);
    const shift = rosterShift ?? effectiveShift;
    const shiftSource = rosterShift ? "Approved roster" : effectiveShift ? "Effective shift" : null;
    const attendance = attendanceByWorker.get(`${person.workerType}:${person.id}`);
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
      locationId: person.locationId,
      availability,
      profileHref: person.workerType === "employee"
        ? `https://people.dropxlogistics.com/people/${person.id}`
        : `https://people.dropxlogistics.com/people/contractors/${person.id}`,
      today: {
        reported,
        lateMinutes,
        workMinutes: Number(attendance?.work_minutes ?? 0),
        missingPunch,
        shiftName: shift ? `${shift.name} · ${shift.start_time.slice(0, 5)}-${shift.end_time.slice(0, 5)}` : null,
        shiftSource,
        inTime: attendance?.in_time ?? null,
        outTime: attendance?.out_time ?? null
      }
    };
  }).sort((left, right) => left.name.localeCompare(right.name));

  return { asOf, people };
}
