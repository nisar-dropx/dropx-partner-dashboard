/** Connect calendar day classification. HRMS payroll reads attendance_daily + leave types, not this helper. */
export const ATTENDANCE_PAY_DAY_TYPES = [
  "present",
  "present_wfh",
  "half_day",
  "paid_leave",
  "unpaid_leave",
  "week_off",
  "paid_holiday",
  "absent",
  "needs_review",
  "no_record"
] as const;

export type AttendancePayDayType = (typeof ATTENDANCE_PAY_DAY_TYPES)[number];

export type AttendanceCalendarClass =
  | "full"
  | "half"
  | "absent"
  | "review"
  | "leave"
  | "paid-leave"
  | "wfh"
  | "week-off"
  | "holiday"
  | "off"
  | "on-shift";

type LeaveTypeHint = {
  attendance_code?: string | null;
  attendance_label?: string | null;
  is_paid?: boolean | null;
};

function normalized(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase().replaceAll("_", " ");
}

export function resolveAttendancePayDayType(input: {
  status?: string | null;
  statusLabel?: string | null;
  attendanceStatus?: string | null;
  workMode?: string | null;
  leaveType?: LeaveTypeHint | null;
  isPaidLeave?: boolean | null;
}): AttendancePayDayType {
  const status = String(input.status ?? "").trim().toUpperCase();
  const label = normalized(input.statusLabel || input.attendanceStatus || "");
  const workMode = normalized(input.workMode);
  const configuredPaid = input.leaveType
    ? input.leaveType.is_paid === true
    : input.isPaidLeave === true;
  const configuredUnpaid = input.leaveType
    ? input.leaveType.is_paid === false
    : input.isPaidLeave === false;
  const hasLeaveType = Boolean(input.leaveType?.attendance_code) || input.isPaidLeave != null;

  if (workMode === "wfh" || /work from home|\bwfh\b/.test(label)) return "present_wfh";
  if (hasLeaveType && configuredUnpaid) return "unpaid_leave";
  if (hasLeaveType && configuredPaid) return "paid_leave";
  if (status === "WO" || /weekly off|week off|rest day/.test(label)) return "week_off";
  if (status === "H" || /\bholiday\b|\bpaid holiday\b/.test(label)) return "paid_holiday";
  if (status === "HD" || /half day/.test(label)) return "half_day";
  if (status === "A" || /absent/.test(label)) return "absent";
  if (/needs review|missing/.test(label)) return "needs_review";
  if (!status && !label) return "no_record";
  if (status === "P" || /full day|present/.test(label)) return "present";
  return "no_record";
}

export function calendarClassForPayDayType(
  payDayType: AttendancePayDayType,
  options: { shiftOpen?: boolean; today?: boolean } = {}
): AttendanceCalendarClass {
  if (options.today && options.shiftOpen && (payDayType === "present" || payDayType === "present_wfh" || payDayType === "no_record")) {
    return "on-shift";
  }
  switch (payDayType) {
    case "present":
      return "full";
    case "present_wfh":
    case "paid_leave":
      // WFH shares paid-leave color on the calendar; detail panel still says WFH.
      return "paid-leave";
    case "half_day":
      return "half";
    case "unpaid_leave":
      return "leave";
    case "week_off":
    case "paid_holiday":
      // Week off and paid holiday share one rest-day color; labels differ on click.
      return "week-off";
    case "absent":
      return "absent";
    case "needs_review":
      return "review";
    default:
      return "off";
  }
}
