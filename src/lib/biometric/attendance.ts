import { supabaseAdmin } from "../supabase-admin";

export type AttendanceReportType =
  | "performance"
  | "in_out"
  | "present"
  | "absent"
  | "late_in"
  | "early_out"
  | "mis_punch";

export type AttendanceReportRow = {
  enrolmentId: string;
  workerCode: string;
  workerName: string;
  workerType: string;
  locationId: string | null;
  location: string;
  designation: string;
  shiftName: string;
  shiftCode: string;
  shiftSource: string;
  scheduledStart: string;
  scheduledEnd: string;
  scheduledMinutes: number;
  punchDate: string;
  inTime: string;
  outTime: string;
  punchTimes: string[];
  workHours: string;
  punchCount: number;
  status: string;
  attendanceStatus: string;
  lateMinutes: number;
  earlyOutMinutes: number;
  remark: string;
  deviceSerial: string;
  labels: Record<string, string>;
};

type PunchRow = {
  enrolment_id: string;
  punch_date: string;
  punch_time: string;
  punch_label: string;
  device_serial: string | null;
  calculated: boolean;
};

type BiometricWorkerLookupRow = {
  id: string;
  biometric_id: string | null;
  designation?: string | null;
  designation_id?: string | null;
  dropx_id?: string | null;
  employee_code?: string | null;
  full_name: string | null;
  location_id: string | null;
};

type BiometricWorkerLookup = BiometricWorkerLookupRow & {
  profileType: "employee" | "field_executive" | "contractor" | "vendor" | "worker" | "helper" | "picker";
};

type DailyRow = {
  enrolment_id: string;
  worker_type: string | null;
  punch_date: string;
  in_time: string | null;
  out_time: string | null;
  punch_count: number | null;
  work_minutes: number | null;
  status: string | null;
  remark: string | null;
  employee_id: string | null;
  field_executive_id: string | null;
  location_id: string | null;
  employee_code: string | null;
  station_code: string | null;
  worker_name: string | null;
};

type EmployeeLookupRow = {
  id: string;
  employee_code: string | null;
  full_name: string | null;
  designation_id: string | null;
  org_position_id?: string | null;
};

type ExecutiveLookupRow = {
  id: string;
  dropx_id: string | null;
  full_name: string | null;
  designation: string | null;
};

type DesignationLookupRow = {
  id: string;
  code: string | null;
  name: string | null;
};

type LocationLookupRow = {
  id: string;
  station_code: string | null;
  station_name: string | null;
};

type DailyWorkerSnapshot = {
  workerCode: string | null;
  workerName: string | null;
  stationCode: string | null;
};

function isMissingColumnError(error: { message?: string; code?: string } | null | undefined) {
  if (!error) return false;
  const message = error.message?.toLowerCase() ?? "";
  return error.code === "42703" || message.includes("does not exist") || message.includes("schema cache");
}

function normalizeDailyRows(rows: Partial<DailyRow>[]): DailyRow[] {
  return rows.map((row) => ({
    enrolment_id: String(row.enrolment_id ?? ""),
    worker_type: row.worker_type ?? null,
    punch_date: String(row.punch_date ?? ""),
    in_time: row.in_time ?? null,
    out_time: row.out_time ?? null,
    punch_count: row.punch_count ?? 0,
    work_minutes: row.work_minutes ?? 0,
    status: row.status ?? "P",
    remark: row.remark ?? null,
    employee_id: row.employee_id ?? null,
    field_executive_id: row.field_executive_id ?? null,
    location_id: row.location_id ?? null,
    employee_code: row.employee_code ?? null,
    station_code: row.station_code ?? null,
    worker_name: row.worker_name ?? null
  })).filter((row) => row.enrolment_id && row.punch_date);
}

function normalizeBiometricId(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().replace(/^0+(?=\d)/, "");
  return normalized || "0";
}

function biometricIdVariants(values: string[]) {
  return Array.from(new Set(values.flatMap((value) => {
    const raw = String(value ?? "").trim();
    const normalized = normalizeBiometricId(raw);
    return [raw, normalized, normalized.padStart(6, "0"), normalized.padStart(8, "0")].filter(Boolean);
  })));
}

export function istDate(value: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Kolkata",
    year: "numeric"
  }).formatToParts(value);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function addIsoDateDays(date: string, days: number) {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function istDateTime(date: string, time: string) {
  const normalizedTime = String(time || "00:00:00").slice(0, 8);
  return new Date(`${date}T${normalizedTime}+05:30`);
}

type ShiftWindow = {
  startTime: string;
  endTime: string;
  breakMinutes: number;
};

type ShiftDefinition = {
  id?: string | null;
  code?: string | null;
  name?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  break_minutes?: number | null;
  grace_in_minutes?: number | null;
  grace_out_minutes?: number | null;
};

type ShiftSchedule = {
  shift: ShiftDefinition | null;
  source: "Roster" | "Unassigned";
  dayType: string;
};

function isoWeekday(value: string) {
  const weekday = new Date(`${value}T00:00:00Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

type AttendanceRules = {
  attendance_grace_minutes?: number | null;
  below_half_day_treatment?: string | null;
  full_day_minutes?: number | null;
  full_day_percent?: number | null;
  half_day_minutes?: number | null;
  half_day_percent?: number | null;
  no_punch_treatment?: string | null;
  odd_punch_treatment?: string | null;
  partial_day_treatment?: string | null;
  single_punch_treatment?: string | null;
  unassigned_shift_treatment?: string | null;
  work_duration_basis?: string | null;
};

export async function loadWorkerShiftWindow({
  accountId,
  companyId,
  employeeId,
  fieldExecutiveId,
  profileType,
  workDate
}: {
  accountId?: string | null;
  companyId: string;
  employeeId?: string | null;
  fieldExecutiveId?: string | null;
  profileType?: string | null;
  workDate: string;
}): Promise<ShiftWindow | null> {
  if (!supabaseAdmin) return null;
  const isEmployee = profileType === "employee" || Boolean(employeeId);
  const workerId = isEmployee ? employeeId : (accountId ?? fieldExecutiveId);
  if (!workerId) return null;

  const roster = await supabaseAdmin
    .from("hr_roster_entries")
    .select("day_type, hr_shifts(start_time, end_time, break_minutes), hr_roster_plans(status)")
    .eq("company_id", companyId)
    .eq("worker_id", workerId)
    .eq("roster_date", workDate)
    .limit(5);
  if (!roster.error) {
    for (const row of roster.data ?? []) {
      const planValue = row.hr_roster_plans as { status?: string | null } | { status?: string | null }[] | null;
      const plan = Array.isArray(planValue) ? planValue[0] : planValue;
      const shiftValue = row.hr_shifts as { start_time?: string | null; end_time?: string | null; break_minutes?: number | null } | { start_time?: string | null; end_time?: string | null; break_minutes?: number | null }[] | null;
      const shift = Array.isArray(shiftValue) ? shiftValue[0] : shiftValue;
      if (plan?.status === "approved" && row.day_type === "working" && shift?.start_time && shift.end_time) {
        return { startTime: shift.start_time, endTime: shift.end_time, breakMinutes: Math.max(0, Number(shift.break_minutes ?? 0)) };
      }
    }
  }

  const plans = await supabaseAdmin
    .from("hr_roster_plans")
    .select("id,effective_from,superseded_at")
    .eq("company_id", companyId)
    .eq("status", "approved")
    .eq("roster_kind", "recurring_weekly")
    .lte("effective_from", workDate)
    .order("effective_from", { ascending: false })
    .limit(50);
  if (plans.error) return null;
  const activePlan = (plans.data ?? []).find((plan) => !plan.superseded_at || workDate < plan.superseded_at);
  if (!activePlan) return null;
  const weekly = await supabaseAdmin
    .from("hr_roster_entries")
    .select("day_type,roster_date,hr_shifts(start_time,end_time,break_minutes)")
    .eq("company_id", companyId)
    .eq("plan_id", activePlan.id)
    .eq("worker_id", workerId);
  if (weekly.error) return null;
  const entry = (weekly.data ?? []).find((row) => isoWeekday(row.roster_date) === isoWeekday(workDate));
  const shiftValue = entry?.hr_shifts as { start_time?: string | null; end_time?: string | null; break_minutes?: number | null } | { start_time?: string | null; end_time?: string | null; break_minutes?: number | null }[] | null | undefined;
  const shift = Array.isArray(shiftValue) ? shiftValue[0] : shiftValue;
  return entry?.day_type === "working" && shift?.start_time && shift.end_time
    ? { startTime: shift.start_time, endTime: shift.end_time, breakMinutes: Math.max(0, Number(shift.break_minutes ?? 0)) }
    : null;
}

/**
 * Resolves the logical attendance workday for a punch. A post-midnight punch
 * is kept with the prior open shift only while the company's configurable
 * overnight and maximum-work-span limits both allow it.
 */
export async function resolveAttendanceWorkDate({
  accountId,
  companyId,
  employeeId,
  enrolmentId,
  fieldExecutiveId,
  profileType,
  punchTime
}: {
  accountId?: string | null;
  companyId: string;
  employeeId?: string | null;
  enrolmentId: string;
  fieldExecutiveId?: string | null;
  profileType?: string | null;
  punchTime: Date;
}) {
  if (!supabaseAdmin) return istDate(punchTime);
  const calendarDate = istDate(punchTime);
  const previousDate = addIsoDateDays(calendarDate, -1);
  const settings = await supabaseAdmin
    .from("hr_company_settings")
    .select("overnight_shift_pairing_enabled, overnight_pairing_window_minutes, maximum_daily_minutes")
    .eq("company_id", companyId)
    .maybeSingle();
  if (settings.error || settings.data?.overnight_shift_pairing_enabled === false) return calendarDate;

  const currentDayPunches = await supabaseAdmin
    .from("attendance_punches")
    .select("id")
    .eq("company_id", companyId)
    .eq("enrolment_id", enrolmentId)
    .eq("punch_date", calendarDate)
    .eq("calculated", true)
    .limit(1);
  if (currentDayPunches.error || (currentDayPunches.data?.length ?? 0) > 0) return calendarDate;

  const previousPunches = await supabaseAdmin
    .from("attendance_punches")
    .select("punch_time")
    .eq("company_id", companyId)
    .eq("enrolment_id", enrolmentId)
    .eq("punch_date", previousDate)
    .eq("calculated", true)
    .order("punch_time", { ascending: true });
  if (previousPunches.error || !previousPunches.data?.length) {
    return calendarDate;
  }

  const firstPunch = new Date(previousPunches.data[0].punch_time);
  const elapsedMinutes = (punchTime.getTime() - firstPunch.getTime()) / 60000;
  const maximumDailyMinutes = Math.max(1, Number(settings.data?.maximum_daily_minutes ?? 960));
  if (elapsedMinutes <= 0 || elapsedMinutes > maximumDailyMinutes) return calendarDate;

  const shift = await loadWorkerShiftWindow({
    accountId,
    companyId,
    employeeId,
    fieldExecutiveId,
    profileType,
    workDate: previousDate
  });
  // Overnight pairing is roster-authoritative. Without an approved roster
  // shift, the scan remains on its actual calendar date for review.
  if (!shift) return calendarDate;

  const shiftStart = istDateTime(previousDate, shift.startTime);
  let shiftEnd = istDateTime(previousDate, shift.endTime);
  if (shiftEnd <= shiftStart) shiftEnd = istDateTime(calendarDate, shift.endTime);
  const pairingWindowMinutes = Math.max(0, Number(settings.data?.overnight_pairing_window_minutes ?? 180));
  const latestScheduledCheckout = shiftEnd.getTime() + pairingWindowMinutes * 60000;
  return punchTime.getTime() <= latestScheduledCheckout ? previousDate : calendarDate;
}

export function formatTime(value: string | Date | null | undefined) {
  if (!value) return "--:--";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata"
  }).format(date);
}

export function formatDuration(minutes: number | null | undefined) {
  const safeMinutes = Math.max(0, Number(minutes ?? 0));
  const hours = Math.floor(safeMinutes / 60);
  const mins = safeMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

export function punchLabel(position: number) {
  const safePosition = Math.max(1, Math.trunc(position));
  const pair = Math.ceil(safePosition / 2);
  return safePosition % 2 === 1 ? `In${pair}` : `Out${pair}`;
}

function relationFirst<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function formatClock(value: string | null | undefined) {
  return value ? value.slice(0, 5) : "--:--";
}

function clockMinutes(value: string | null | undefined) {
  const [hours, minutes] = String(value ?? "").split(":").map(Number);
  return Number.isFinite(hours) && Number.isFinite(minutes) ? hours * 60 + minutes : null;
}

function scheduledDuration(shift: ShiftDefinition | null) {
  const start = clockMinutes(shift?.start_time);
  const end = clockMinutes(shift?.end_time);
  if (start == null || end == null) return 0;
  const elapsed = end <= start ? end + 1440 - start : end - start;
  return Math.max(0, elapsed - Math.max(0, Number(shift?.break_minutes ?? 0)));
}

function treatmentLabel(value: string | null | undefined, fallback: string) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "absent") return "Absent";
  if (normalized === "half_day" || normalized === "half day") return "Half Day";
  if (normalized === "full_day" || normalized === "full day") return "Full Day";
  if (normalized === "present") return "Present";
  if (normalized === "review" || normalized === "needs_review") return "Needs Review";
  return fallback;
}

function attendanceDayStatus({
  dayType,
  punchCount,
  rules,
  scheduledMinutes,
  status,
  workMinutes
}: {
  dayType: string;
  punchCount: number;
  rules: AttendanceRules;
  scheduledMinutes: number;
  status: string;
  workMinutes: number;
}) {
  if (dayType && dayType !== "working" && dayType !== "unassigned") {
    const dayLabel = dayType.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
    return punchCount > 0 ? `Present (${dayLabel})` : dayLabel;
  }
  if (status === "A" || punchCount === 0) return treatmentLabel(rules.no_punch_treatment, "Absent");
  if (punchCount === 1) return treatmentLabel(rules.single_punch_treatment, "Needs Review");
  if (punchCount % 2 === 1 && rules.odd_punch_treatment !== "first_last") {
    return treatmentLabel(rules.odd_punch_treatment, "Needs Review");
  }

  const percentageBasis = String(rules.work_duration_basis ?? "").toLowerCase().includes("percent");
  const fullThreshold = percentageBasis && scheduledMinutes > 0
    ? Math.round(scheduledMinutes * Math.max(0, Number(rules.full_day_percent ?? 100)) / 100)
    : Math.max(1, Number(rules.full_day_minutes ?? 540));
  const halfThreshold = percentageBasis && scheduledMinutes > 0
    ? Math.round(scheduledMinutes * Math.max(0, Number(rules.half_day_percent ?? 50)) / 100)
    : Math.max(1, Number(rules.half_day_minutes ?? 270));
  if (workMinutes >= fullThreshold) return "Full Day";
  if (workMinutes >= halfThreshold) return treatmentLabel(rules.partial_day_treatment, "Half Day");
  return treatmentLabel(rules.below_half_day_treatment, "Absent");
}

function attendanceVariance({
  inTime,
  outTime,
  punchDate,
  rules,
  shift
}: {
  inTime: string | null;
  outTime: string | null;
  punchDate: string;
  rules: AttendanceRules;
  shift: ShiftDefinition | null;
}) {
  if (!shift?.start_time || !shift.end_time) return { earlyOutMinutes: 0, lateMinutes: 0 };
  const scheduledStart = istDateTime(punchDate, shift.start_time);
  let scheduledEnd = istDateTime(punchDate, shift.end_time);
  if (scheduledEnd <= scheduledStart) scheduledEnd = istDateTime(addIsoDateDays(punchDate, 1), shift.end_time);
  const actualIn = inTime ? new Date(inTime) : null;
  const actualOut = outTime ? new Date(outTime) : null;
  const companyGrace = Math.max(0, Number(rules.attendance_grace_minutes ?? 0));
  const inGrace = Math.max(companyGrace, Math.max(0, Number(shift.grace_in_minutes ?? 0)));
  const outGrace = Math.max(companyGrace, Math.max(0, Number(shift.grace_out_minutes ?? 0)));
  return {
    lateMinutes: actualIn && !Number.isNaN(actualIn.getTime())
      ? Math.max(0, Math.floor((actualIn.getTime() - scheduledStart.getTime()) / 60000) - inGrace)
      : 0,
    earlyOutMinutes: actualOut && !Number.isNaN(actualOut.getTime())
      ? Math.max(0, Math.floor((scheduledEnd.getTime() - actualOut.getTime()) / 60000) - outGrace)
      : 0
  };
}

async function loadAttendanceScheduleContext({
  companyId,
  fromDate,
  toDate,
  workers
}: {
  companyId: string;
  fromDate: string;
  toDate: string;
  workers: Array<{ profileId: string; profileType: BiometricWorkerLookup["profileType"] }>;
}) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const workerIds = Array.from(new Set(workers.map((worker) => worker.profileId).filter(Boolean)));
  const shiftColumns = "id, code, name, start_time, end_time, break_minutes, grace_in_minutes, grace_out_minutes";

  const [settingsResult, rosterResult, recurringPlanResult] = await Promise.all([
    supabaseAdmin
      .from("hr_company_settings")
      .select("attendance_grace_minutes, below_half_day_treatment, full_day_minutes, full_day_percent, half_day_minutes, half_day_percent, no_punch_treatment, odd_punch_treatment, partial_day_treatment, single_punch_treatment, unassigned_shift_treatment, work_duration_basis")
      .eq("company_id", companyId)
      .maybeSingle(),
    workerIds.length
      ? supabaseAdmin
        .from("hr_roster_entries")
        .select(`worker_id, roster_date, day_type, hr_shifts(${shiftColumns}), hr_roster_plans!inner(status,roster_kind)`)
        .eq("company_id", companyId)
        .eq("hr_roster_plans.status", "approved")
        .eq("hr_roster_plans.roster_kind", "dated")
        .gte("roster_date", fromDate)
        .lte("roster_date", toDate)
        .in("worker_id", workerIds)
      : Promise.resolve({ data: [], error: null }),
    supabaseAdmin
      .from("hr_roster_plans")
      .select("id,effective_from,superseded_at")
      .eq("company_id", companyId)
      .eq("status", "approved")
      .eq("roster_kind", "recurring_weekly")
      .lte("effective_from", toDate)
      .order("effective_from", { ascending: false })
  ]);
  if (settingsResult.error) throw new Error(settingsResult.error.message);
  if (rosterResult.error) throw new Error(rosterResult.error.message);
  if (recurringPlanResult.error) throw new Error(recurringPlanResult.error.message);

  type RosterRow = {
    worker_id: string;
    roster_date: string;
    day_type: string | null;
    hr_shifts: ShiftDefinition | ShiftDefinition[] | null;
    hr_roster_plans: { status?: string | null } | Array<{ status?: string | null }> | null;
  };
  type WeeklyRosterRow = {
    plan_id: string;
    worker_id: string;
    roster_date: string;
    day_type: string | null;
    hr_shifts: ShiftDefinition | ShiftDefinition[] | null;
  };
  const rosterByWorkerDate = new Map<string, ShiftSchedule>();
  ((rosterResult.data ?? []) as unknown as RosterRow[]).forEach((row) => {
    if (relationFirst(row.hr_roster_plans)?.status !== "approved") return;
    rosterByWorkerDate.set(`${row.worker_id}:${row.roster_date}`, {
      dayType: row.day_type ?? "working",
      shift: relationFirst(row.hr_shifts),
      source: "Roster"
    });
  });
  const recurringPlans = (recurringPlanResult.data ?? []).map((plan) => ({
    id: plan.id,
    effectiveFrom: String(plan.effective_from),
    supersededAt: plan.superseded_at ? String(plan.superseded_at) : null
  }));
  const recurringPlanIds = recurringPlans.map((plan) => plan.id);
  const weeklyEntriesResult = recurringPlanIds.length && workerIds.length
    ? await supabaseAdmin
      .from("hr_roster_entries")
      .select(`plan_id,worker_id,roster_date,day_type,hr_shifts(${shiftColumns})`)
      .eq("company_id", companyId)
      .in("plan_id", recurringPlanIds)
      .in("worker_id", workerIds)
    : { data: [], error: null };
  if (weeklyEntriesResult.error) throw new Error(weeklyEntriesResult.error.message);
  const weeklyByPlanWorkerDay = new Map<string, WeeklyRosterRow>();
  ((weeklyEntriesResult.data ?? []) as unknown as WeeklyRosterRow[]).forEach((entry) => {
    weeklyByPlanWorkerDay.set(`${entry.plan_id}:${entry.worker_id}:${isoWeekday(entry.roster_date)}`, entry);
  });

  return {
    rules: (settingsResult.data ?? {}) as AttendanceRules,
    scheduleFor(profileId: string | null, punchDate: string): ShiftSchedule {
      if (!profileId) return { dayType: "unassigned", shift: null, source: "Unassigned" };
      const roster = rosterByWorkerDate.get(`${profileId}:${punchDate}`);
      if (roster) return roster;
      const activePlan = recurringPlans.find((plan) => plan.effectiveFrom <= punchDate && (!plan.supersededAt || punchDate < plan.supersededAt));
      const weekly = activePlan ? weeklyByPlanWorkerDay.get(`${activePlan.id}:${profileId}:${isoWeekday(punchDate)}`) : null;
      return weekly
        ? { dayType: weekly.day_type ?? "working", shift: relationFirst(weekly.hr_shifts), source: "Roster" }
        : { dayType: "unassigned", shift: null, source: "Unassigned" };
    }
  };
}

function summarizeFirstInLastOut(punchTimes: string[]) {
  if (punchTimes.length < 2) {
    return { lastOutTime: null, workMinutes: 0 };
  }

  const firstInTime = new Date(punchTimes[0]);
  const lastOutTime = new Date(punchTimes[punchTimes.length - 1]);
  if (Number.isNaN(firstInTime.getTime()) || Number.isNaN(lastOutTime.getTime()) || lastOutTime < firstInTime) {
    return { lastOutTime: null, workMinutes: 0 };
  }

  return {
    lastOutTime: punchTimes[punchTimes.length - 1],
    workMinutes: Math.round((lastOutTime.getTime() - firstInTime.getTime()) / 60000)
  };
}

async function loadDailyWorkerSnapshot({
  companyId,
  employeeId,
  fieldExecutiveId,
  profileType,
  accountId,
  fallbackLocationId
}: {
  companyId: string;
  employeeId?: string | null;
  fallbackLocationId?: string | null;
  fieldExecutiveId?: string | null;
  profileType?: string | null;
  accountId?: string | null;
}): Promise<DailyWorkerSnapshot> {
  if (!supabaseAdmin) return { stationCode: null, workerCode: null, workerName: null };

  let workerCode: string | null = null;
  let workerName: string | null = null;
  let locationId = fallbackLocationId ?? null;

  if (employeeId) {
    const employee = await supabaseAdmin
      .from("employees")
      .select("employee_code, full_name, location_id")
      .eq("company_id", companyId)
      .eq("id", employeeId)
      .maybeSingle();
    if (!employee.error && employee.data) {
      workerCode = employee.data.employee_code ?? null;
      workerName = employee.data.full_name ?? null;
      locationId = employee.data.location_id ?? locationId;
    }
  } else if (accountId && ["field_executive", "contractor", "vendor", "worker"].includes(profileType ?? "")) {
    const table = profileType === "contractor"
      ? "contractors"
      : profileType === "vendor"
        ? "vendors"
        : profileType === "worker"
          ? "workers"
          : "workforce";
    const candidateTables = profileType === "worker"
      ? [table, "workforce_helpers", "workforce_pickers"] as const
      : [table] as const;
    for (const candidateTable of candidateTables) {
      const profile = await supabaseAdmin
        .from(candidateTable)
        .select("dropx_id, full_name, location_id")
        .eq("company_id", companyId)
        .eq("id", accountId)
        .maybeSingle();
      if (!profile.error && profile.data) {
        workerCode = profile.data.dropx_id ?? null;
        workerName = profile.data.full_name ?? null;
        locationId = profile.data.location_id ?? locationId;
        break;
      }
    }
  } else if (fieldExecutiveId) {
    const contractor = await supabaseAdmin
      .from("contractors")
      .select("dropx_id, full_name, location_id")
      .eq("company_id", companyId)
      .eq("id", fieldExecutiveId)
      .maybeSingle();
    if (!contractor.error && contractor.data) {
      workerCode = contractor.data.dropx_id ?? null;
      workerName = contractor.data.full_name ?? null;
      locationId = contractor.data.location_id ?? locationId;
    } else {
      const executive = await supabaseAdmin
        .from("workforce")
        .select("dropx_id, full_name, location_id")
        .eq("company_id", companyId)
        .eq("id", fieldExecutiveId)
        .maybeSingle();
      if (!executive.error && executive.data) {
        workerCode = executive.data.dropx_id ?? null;
        workerName = executive.data.full_name ?? null;
        locationId = executive.data.location_id ?? locationId;
      }
    }
  }

  if (!locationId) return { stationCode: null, workerCode, workerName };

  const station = await supabaseAdmin
    .from("stations")
    .select("station_code")
    .eq("company_id", companyId)
    .eq("id", locationId)
    .maybeSingle();

  return {
    stationCode: station.error ? null : station.data?.station_code ?? null,
    workerCode,
    workerName
  };
}

export async function rebuildAttendanceDay(companyId: string, enrolmentId: string, punchDate: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");

  const { data, error } = await supabaseAdmin
    .from("attendance_punches")
    .select("id, punch_time")
    .eq("company_id", companyId)
    .eq("enrolment_id", enrolmentId)
    .eq("punch_date", punchDate)
    .eq("calculated", true)
    .order("punch_time", { ascending: true });
  if (error) throw new Error(error.message);

  const punches = data ?? [];
  // Freeze punch times before order updates so rebuild never picks up approval/server "now".
  const punchTimes = punches.map((punch) => punch.punch_time).filter(Boolean) as string[];
  for (let index = 0; index < punches.length; index += 1) {
    const order = index + 1;
    const preservedTime = punches[index].punch_time;
    await supabaseAdmin
      .from("attendance_punches")
      .update({
        punch_order: order,
        punch_label: punchLabel(order),
        ...(preservedTime ? { punch_time: preservedTime } : {})
      })
      .eq("id", punches[index].id);
  }

  const first = punchTimes[0] ? new Date(punchTimes[0]) : null;
  const summary = summarizeFirstInLastOut(punchTimes);
  const remark = punches.length === 0
    ? "No punch"
    : punches.length === 1
      ? "Single punch"
      : null;

  const latestPunch = await supabaseAdmin
    .from("attendance_punches")
    .select("worker_type, employee_id, field_executive_id, profile_type, account_id, location_id")
    .eq("company_id", companyId)
    .eq("enrolment_id", enrolmentId)
    .eq("punch_date", punchDate)
    .eq("calculated", true)
    .order("punch_time", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestPunch.error) throw new Error(latestPunch.error.message);

  const workerSnapshot = await loadDailyWorkerSnapshot({
    companyId,
    employeeId: latestPunch.data?.employee_id ?? null,
    fallbackLocationId: latestPunch.data?.location_id ?? null,
    fieldExecutiveId: latestPunch.data?.field_executive_id ?? null,
    profileType: latestPunch.data?.profile_type ?? null,
    accountId: latestPunch.data?.account_id ?? null
  });

  const basePayload = {
    company_id: companyId,
    enrolment_id: enrolmentId,
    worker_type: latestPunch.data?.worker_type ?? null,
    employee_id: latestPunch.data?.employee_id ?? null,
    field_executive_id: latestPunch.data?.field_executive_id ?? null,
    location_id: latestPunch.data?.location_id ?? null,
    punch_date: punchDate,
    in_time: first?.toISOString() ?? null,
    out_time: summary.lastOutTime,
    punch_count: punches.length,
    work_minutes: summary.workMinutes,
    status: punches.length ? "P" : "A",
    remark,
    updated_at: new Date().toISOString()
  };

  const enrichedPayload = {
    ...basePayload,
    employee_code: workerSnapshot.workerCode,
    station_code: workerSnapshot.stationCode,
    worker_name: workerSnapshot.workerName
  };

  const firstUpsert = await supabaseAdmin
    .from("attendance_daily")
    .upsert(enrichedPayload, { onConflict: "company_id,enrolment_id,punch_date" });

  if (isMissingColumnError(firstUpsert.error)) {
    const fallbackUpsert = await supabaseAdmin
      .from("attendance_daily")
      .upsert(basePayload, { onConflict: "company_id,enrolment_id,punch_date" });
    if (fallbackUpsert.error) throw new Error(fallbackUpsert.error.message);
    return;
  }

  if (firstUpsert.error) throw new Error(firstUpsert.error.message);
}

type HistoricalRawPunchRow = {
  id: string;
  device_id: string | null;
  device_serial: string;
  enrolment_id: string | null;
  punch_time: string;
};

export async function backfillHistoricalPunches({
  accountId,
  companyId,
  employeeId,
  enrolmentId,
  fieldExecutiveId,
  isActive,
  locationId,
  profileType,
  workerStatus,
  workerType
}: {
  accountId: string;
  companyId: string;
  employeeId: string | null;
  enrolmentId: string;
  fieldExecutiveId: string | null;
  isActive: boolean;
  locationId: string;
  profileType: string;
  workerStatus: string;
  workerType: string;
}) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");

  const enrolmentIds = biometricIdVariants([enrolmentId]);
  const rawEventIds: string[] = [];
  const rawPunches: HistoricalRawPunchRow[] = [];
  const pageSize = 500;

  for (let from = 0; ; from += pageSize) {
    const alerts = await supabaseAdmin
      .from("biometric_alerts")
      .select("raw_event_id")
      .eq("company_id", companyId)
      .eq("alert_type", "unknown_enrolment")
      .in("enrolment_id", enrolmentIds)
      .not("raw_event_id", "is", null)
      .is("resolved_at", null)
      .range(from, from + pageSize - 1);
    if (alerts.error) throw new Error(alerts.error.message);

    const page = (alerts.data ?? [])
      .map((alert) => alert.raw_event_id)
      .filter((id): id is string => Boolean(id));
    rawEventIds.push(...page);
    if (page.length < pageSize) break;
  }

  const uniqueRawEventIds = Array.from(new Set(rawEventIds));
  for (let offset = 0; offset < uniqueRawEventIds.length; offset += 100) {
    const ids = uniqueRawEventIds.slice(offset, offset + 100);
    const result = await supabaseAdmin
      .from("biometric_raw_events")
      .select("id, device_id, device_serial, enrolment_id, punch_time")
      .eq("company_id", companyId)
      .in("id", ids)
      .ilike("event_type", "timelog")
      .not("punch_time", "is", null);
    if (result.error) throw new Error(result.error.message);
    rawPunches.push(...((result.data ?? []) as HistoricalRawPunchRow[]));
  }
  rawPunches.sort((left, right) =>
    new Date(left.punch_time).getTime() - new Date(right.punch_time).getTime()
  );

  if (!rawPunches.length) return 0;

  const affectedDates = new Set<string>();
  for (let offset = 0; offset < rawPunches.length; offset += pageSize) {
    const page = rawPunches.slice(offset, offset + pageSize);
    const rows = page.map((rawPunch) => {
      const punchDate = istDate(new Date(rawPunch.punch_time));
      affectedDates.add(punchDate);
      return {
        company_id: companyId,
        raw_event_id: rawPunch.id,
        device_id: rawPunch.device_id,
        enrolment_id: enrolmentId,
        worker_type: workerType,
        profile_type: profileType,
        account_id: accountId,
        employee_id: employeeId,
        field_executive_id: fieldExecutiveId,
        location_id: locationId,
        device_serial: rawPunch.device_serial,
        punch_time: rawPunch.punch_time,
        punch_date: punchDate,
        punch_order: 1,
        punch_label: punchLabel(1),
        worker_status: workerStatus,
        calculated: isActive
      };
    });

    const insert = await supabaseAdmin
      .from("attendance_punches")
      .upsert(rows, {
        // A previously unknown enrolment already has a non-calculated Review
        // punch under this logical key. Update that retained punch with the
        // resolved profile and calculation state when the mapping is created.
        ignoreDuplicates: false,
        onConflict: "company_id,device_serial,enrolment_id,punch_time"
      });
    if (insert.error) throw new Error(insert.error.message);
  }

  if (isActive) {
    for (const punchDate of Array.from(affectedDates).sort()) {
      await rebuildAttendanceDay(companyId, enrolmentId, punchDate);
    }
  }

  const processedRawEventIds = rawPunches.map((rawPunch) => rawPunch.id);
  for (let offset = 0; offset < processedRawEventIds.length; offset += 100) {
    const resolve = await supabaseAdmin
      .from("biometric_alerts")
      .update({ resolved_at: new Date().toISOString() })
      .eq("company_id", companyId)
      .eq("alert_type", "unknown_enrolment")
      .in("raw_event_id", processedRawEventIds.slice(offset, offset + 100))
      .is("resolved_at", null);
    if (resolve.error) throw new Error(resolve.error.message);
  }

  return rawPunches.length;
}

function reportMatchesType(row: AttendanceReportRow, type: AttendanceReportType) {
  if (type === "present") return row.status === "P";
  if (type === "absent") return row.attendanceStatus === "Absent";
  if (type === "late_in") return row.lateMinutes > 0 || row.remark.toLowerCase().includes("late");
  if (type === "early_out") return row.earlyOutMinutes > 0 || row.remark.toLowerCase().includes("early out");
  if (type === "mis_punch") return row.punchCount < 2 || !row.outTime || row.remark.toLowerCase().includes("single") || row.remark.toLowerCase().includes("missing");
  return true;
}

export async function loadAttendanceReportRows({
  companyId,
  date,
  enrolmentIds: requestedEnrolmentIds,
  fromDate,
  locationIds,
  reportType,
  toDate
}: {
  companyId: string;
  date?: string;
  enrolmentIds?: string[];
  fromDate?: string;
  locationIds?: string[];
  reportType: AttendanceReportType;
  toDate?: string;
}) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  if (Array.isArray(locationIds) && locationIds.length === 0) return [];
  const admin = supabaseAdmin;

  const baseSelect = `
    enrolment_id,
    worker_type,
    punch_date,
    in_time,
    out_time,
    punch_count,
    work_minutes,
    status,
    remark,
    employee_id,
    field_executive_id,
    location_id,
    employee_code,
    station_code,
    worker_name
  `;
  const fallbackSelect = `
    enrolment_id,
    punch_date,
    in_time,
    out_time,
    punch_count,
    work_minutes,
    status,
    remark
  `;
  const runDailyQuery = async (selectColumns: string, includeLocationFilter: boolean) => {
    let query = admin
      .from("attendance_daily")
      .select(selectColumns)
      .eq("company_id", companyId)
      .order("punch_date", { ascending: false })
      .order("enrolment_id", { ascending: true });

    if (fromDate && toDate) {
      query = query.gte("punch_date", fromDate).lte("punch_date", toDate);
    } else if (date) {
      query = query.eq("punch_date", date);
    }

    const enrolmentVariants = biometricIdVariants(requestedEnrolmentIds ?? []);
    if (enrolmentVariants.length) query = query.in("enrolment_id", enrolmentVariants);

    if (includeLocationFilter && locationIds?.length) query = query.in("location_id", locationIds);
    return query;
  };

  let dailyResult = await runDailyQuery(baseSelect, true);
  if (isMissingColumnError(dailyResult.error)) {
    dailyResult = await runDailyQuery(fallbackSelect, false);
  }
  if (dailyResult.error) throw new Error(dailyResult.error.message);

  const dailyRows = normalizeDailyRows((dailyResult.data ?? []) as Partial<DailyRow>[]);
  const employeeIds = Array.from(new Set(dailyRows.map((row) => row.employee_id).filter(Boolean))) as string[];
  const executiveIds = Array.from(new Set(dailyRows.map((row) => row.field_executive_id).filter(Boolean))) as string[];
  const dailyLocationIds = Array.from(new Set(dailyRows.map((row) => row.location_id).filter(Boolean))) as string[];
  const enrolmentIds = Array.from(new Set(dailyRows.map((row) => row.enrolment_id)));
  const biometricVariants = biometricIdVariants(enrolmentIds);
  const [employeeResult, executiveResult, locationResult, biometricEmployeeResult, biometricExecutiveResult, biometricContractorResult, biometricVendorResult, biometricWorkerResult, biometricHelperResult, biometricPickerResult] = await Promise.all([
    employeeIds.length
      ? supabaseAdmin
        .from("employees")
        .select("id, employee_code, full_name, designation_id, org_position_id")
        .eq("company_id", companyId)
        .in("id", employeeIds)
      : Promise.resolve({ data: [], error: null }),
    executiveIds.length
      ? supabaseAdmin
        .from("workforce")
        .select("id, dropx_id, full_name, designation")
        .eq("company_id", companyId)
        .in("id", executiveIds)
      : Promise.resolve({ data: [], error: null }),
    dailyLocationIds.length
      ? supabaseAdmin
        .from("stations")
        .select("id, station_code, station_name")
        .eq("company_id", companyId)
        .in("id", dailyLocationIds)
      : Promise.resolve({ data: [], error: null }),
    biometricVariants.length
      ? supabaseAdmin
        .from("employees")
        .select("id, employee_code, full_name, biometric_id, designation_id, location_id, org_position_id")
        .eq("company_id", companyId)
        .in("biometric_id", biometricVariants)
      : Promise.resolve({ data: [], error: null }),
    biometricVariants.length
      ? supabaseAdmin
        .from("workforce")
        .select("id, dropx_id, full_name, biometric_id, designation, location_id")
        .eq("company_id", companyId)
        .in("biometric_id", biometricVariants)
      : Promise.resolve({ data: [], error: null }),
    biometricVariants.length
      ? supabaseAdmin
        .from("contractors")
        .select("id, dropx_id, full_name, biometric_id, designation, location_id")
        .eq("company_id", companyId)
        .in("biometric_id", biometricVariants)
      : Promise.resolve({ data: [], error: null }),
    biometricVariants.length
      ? supabaseAdmin
        .from("vendors")
        .select("id, dropx_id, full_name, biometric_id, designation, location_id")
        .eq("company_id", companyId)
        .in("biometric_id", biometricVariants)
      : Promise.resolve({ data: [], error: null }),
    biometricVariants.length
      ? supabaseAdmin
        .from("helpers")
        .select("id, dropx_id, full_name, biometric_id, designation, location_id")
        .eq("company_id", companyId)
        .in("biometric_id", biometricVariants)
      : Promise.resolve({ data: [], error: null }),
    biometricVariants.length
      ? supabaseAdmin
        .from("workforce_helpers")
        .select("id, dropx_id, full_name, biometric_id, designation, location_id")
        .eq("company_id", companyId)
        .in("biometric_id", biometricVariants)
      : Promise.resolve({ data: [], error: null }),
    biometricVariants.length
      ? supabaseAdmin
        .from("workforce_pickers")
        .select("id, dropx_id, full_name, biometric_id, designation, location_id")
        .eq("company_id", companyId)
        .in("biometric_id", biometricVariants)
      : Promise.resolve({ data: [], error: null })
  ]);
  if (employeeResult.error) throw new Error(employeeResult.error.message);
  if (executiveResult.error) throw new Error(executiveResult.error.message);
  if (locationResult.error) throw new Error(locationResult.error.message);
  if (biometricEmployeeResult.error) throw new Error(biometricEmployeeResult.error.message);
  if (biometricExecutiveResult.error) throw new Error(biometricExecutiveResult.error.message);
  if (biometricContractorResult.error) throw new Error(biometricContractorResult.error.message);
  if (biometricVendorResult.error) throw new Error(biometricVendorResult.error.message);
  if (biometricWorkerResult.error) throw new Error(biometricWorkerResult.error.message);
  if (biometricHelperResult.error) throw new Error(biometricHelperResult.error.message);
  if (biometricPickerResult.error) throw new Error(biometricPickerResult.error.message);

  const employeesById = new Map(((employeeResult.data ?? []) as EmployeeLookupRow[]).map((employee) => [employee.id, employee]));
  const executivesById = new Map(((executiveResult.data ?? []) as ExecutiveLookupRow[]).map((executive) => [executive.id, executive]));
  const locationsById = new Map(((locationResult.data ?? []) as LocationLookupRow[]).map((location) => [location.id, location]));
  const biometricWorkers: BiometricWorkerLookup[] = [
    ...((biometricEmployeeResult.data ?? []) as BiometricWorkerLookupRow[]).map((row) => ({ ...row, profileType: "employee" as const })),
    ...((biometricContractorResult.data ?? []) as BiometricWorkerLookupRow[]).map((row) => ({ ...row, profileType: "contractor" as const })),
    ...((biometricVendorResult.data ?? []) as BiometricWorkerLookupRow[]).map((row) => ({ ...row, profileType: "vendor" as const })),
    ...((biometricWorkerResult.data ?? []) as BiometricWorkerLookupRow[]).map((row) => ({ ...row, profileType: "worker" as const })),
    ...((biometricHelperResult.data ?? []) as BiometricWorkerLookupRow[]).map((row) => ({ ...row, profileType: "helper" as const })),
    ...((biometricPickerResult.data ?? []) as BiometricWorkerLookupRow[]).map((row) => ({ ...row, profileType: "picker" as const })),
    ...((biometricExecutiveResult.data ?? []) as BiometricWorkerLookupRow[]).map((row) => ({ ...row, profileType: "field_executive" as const }))
  ];
  const biometricWorkersById = new Map<string, BiometricWorkerLookup>();
  biometricWorkers.forEach((worker) => {
    const key = normalizeBiometricId(worker.biometric_id);
    if (!biometricWorkersById.has(key)) biometricWorkersById.set(key, worker);
  });
  const designationIds = Array.from(new Set([
    ...Array.from(employeesById.values()).map((employee) => employee.designation_id),
    ...biometricWorkers.map((worker) => worker.designation_id)
  ].filter(Boolean))) as string[];
  const designationResult = designationIds.length
    ? await supabaseAdmin.from("designations").select("id, code, name").in("id", designationIds)
    : { data: [], error: null };
  if (designationResult.error) throw new Error(designationResult.error.message);
  const designationsById = new Map(((designationResult.data ?? []) as DesignationLookupRow[]).map((designation) => [designation.id, designation]));

  const punchFilterDates = Array.from(new Set(dailyRows.map((row) => row.punch_date)));
  let punchesByKey = new Map<string, PunchRow[]>();

  if (enrolmentIds.length && punchFilterDates.length) {
    let punchQuery = supabaseAdmin
      .from("attendance_punches")
      .select("enrolment_id, punch_date, punch_time, punch_label, device_serial, calculated")
      .eq("company_id", companyId)
      .eq("calculated", true)
      .in("enrolment_id", enrolmentIds)
      .in("punch_date", punchFilterDates)
      .order("punch_time", { ascending: true });
    if (locationIds?.length) punchQuery = punchQuery.in("location_id", locationIds);
    const punchResult = await punchQuery;
    if (punchResult.error && !isMissingColumnError(punchResult.error)) throw new Error(punchResult.error.message);
    punchesByKey = ((punchResult.data ?? []) as PunchRow[]).reduce((map, punch) => {
      const key = `${punch.enrolment_id}:${punch.punch_date}`;
      const rows = map.get(key) ?? [];
      rows.push(punch);
      map.set(key, rows);
      return map;
    }, new Map<string, PunchRow[]>());
  }

  const reportWorkers = dailyRows.map((row) => {
    const biometricWorker = biometricWorkersById.get(normalizeBiometricId(row.enrolment_id));
    const profileType = row.employee_id || row.worker_type === "employee"
      ? "employee" as const
      : biometricWorker?.profileType ?? "field_executive" as const;
    return {
      profileId: row.employee_id ?? biometricWorker?.id ?? row.field_executive_id ?? "",
      profileType
    };
  }).filter((worker) => worker.profileId);
  const scheduleContext = await loadAttendanceScheduleContext({
    companyId,
    fromDate: fromDate ?? date ?? punchFilterDates.at(-1) ?? istDate(new Date()),
    toDate: toDate ?? date ?? punchFilterDates[0] ?? istDate(new Date()),
    workers: reportWorkers
  });
  const categoryLabel = (profileType: BiometricWorkerLookup["profileType"]) => {
    if (profileType === "employee") return "Employees";
    if (profileType === "field_executive") return "Field Executives";
    if (profileType === "contractor") return "Independent Contractor";
    if (profileType === "vendor") return "Vendors";
    if (profileType === "helper") return "Helpers";
    if (profileType === "picker") return "Pickers";
    return "Workers";
  };

  return dailyRows.map((row) => {
    const employee = row.employee_id ? employeesById.get(row.employee_id) : null;
    const executive = row.field_executive_id ? executivesById.get(row.field_executive_id) : null;
    const designation = employee?.designation_id ? designationsById.get(employee.designation_id) : null;
    const biometricWorker = biometricWorkersById.get(normalizeBiometricId(row.enrolment_id));
    const biometricDesignation = biometricWorker?.designation_id
      ? designationsById.get(biometricWorker.designation_id)
      : null;
    const station = row.location_id ? locationsById.get(row.location_id) : null;
    const punches = punchesByKey.get(`${row.enrolment_id}:${row.punch_date}`) ?? [];
    const labels = Object.fromEntries(punches.map((punch) => [punch.punch_label, formatTime(punch.punch_time)]));
    const firstDevice = punches.find((punch) => punch.device_serial)?.device_serial ?? "";
    const profileType = row.employee_id || row.worker_type === "employee"
      ? "employee" as const
      : biometricWorker?.profileType ?? "field_executive" as const;
    const profileId = row.employee_id ?? biometricWorker?.id ?? row.field_executive_id ?? null;
    const schedule = scheduleContext.scheduleFor(profileId, row.punch_date);
    const scheduledMinutes = scheduledDuration(schedule.shift);
    const variance = attendanceVariance({
      inTime: row.in_time,
      outTime: row.out_time,
      punchDate: row.punch_date,
      rules: scheduleContext.rules,
      shift: schedule.shift
    });
    const attendanceStatus = attendanceDayStatus({
      dayType: schedule.dayType,
      punchCount: Number(row.punch_count ?? 0),
      rules: scheduleContext.rules,
      scheduledMinutes,
      status: row.status ?? "P",
      workMinutes: Number(row.work_minutes ?? 0)
    });
    const reportRow: AttendanceReportRow = {
      enrolmentId: row.enrolment_id,
      workerCode: employee?.employee_code ?? executive?.dropx_id ?? biometricWorker?.employee_code ?? biometricWorker?.dropx_id ?? row.employee_code ?? row.enrolment_id,
      workerName: employee?.full_name ?? executive?.full_name ?? biometricWorker?.full_name ?? row.worker_name ?? "Unknown",
      workerType: categoryLabel(profileType),
      locationId: row.location_id ?? biometricWorker?.location_id ?? null,
      location: station?.station_code ?? row.station_code ?? "-",
      designation: designation?.name ?? designation?.code ?? executive?.designation ?? biometricDesignation?.name ?? biometricDesignation?.code ?? biometricWorker?.designation ?? "-",
      shiftName: schedule.shift?.name ?? schedule.shift?.code ?? (schedule.dayType !== "unassigned" && schedule.dayType !== "working" ? schedule.dayType.replaceAll("_", " ") : "Unassigned"),
      shiftCode: schedule.shift?.code ?? "",
      shiftSource: schedule.source,
      scheduledStart: formatClock(schedule.shift?.start_time),
      scheduledEnd: formatClock(schedule.shift?.end_time),
      scheduledMinutes,
      punchDate: row.punch_date,
      inTime: formatTime(row.in_time),
      outTime: formatTime(row.out_time),
      punchTimes: punches.map((punch) => formatTime(punch.punch_time)),
      workHours: formatDuration(row.work_minutes),
      punchCount: Number(row.punch_count ?? 0),
      status: row.status ?? "P",
      attendanceStatus,
      lateMinutes: variance.lateMinutes,
      earlyOutMinutes: variance.earlyOutMinutes,
      remark: row.remark ?? "",
      deviceSerial: firstDevice,
      labels
    };
    return reportRow;
  }).filter((row) => (locationIds === undefined || (row.locationId !== null && locationIds.includes(row.locationId))) && reportMatchesType(row, reportType));
}
