/**
 * Approved leave on the DropX One attendance calendar.
 *
 * Approving leave writes nothing to attendance_daily or the roster, so without
 * this the calendar showed an approved CL/SL/comp-off day as an empty or absent
 * day. The attendance route stamps each approved leave day with the leave
 * type's attendance code, and the calendar then colours it the same way as any
 * configured leave: paid types (CL, SL, week-off/holiday comp-off) in the
 * paid-leave colour, unpaid types (LOP) in the leave colour.
 *
 * Pending ("applied") leave is tracked separately so the day picker can show
 * what was requested without treating it as payroll leave until approval.
 */
export type ApprovedLeave = {
  startDate: string;
  endDate: string;
  attendanceCode: string;
  attendanceLabel: string | null;
  name: string;
};

export type AppliedLeave = ApprovedLeave & {
  status: "pending" | "approved";
};

function nextDate(date: string) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function leaveDaysInRange<T extends ApprovedLeave>(leaves: T[], fromDate: string, toDate: string) {
  const days = new Map<string, T>();
  for (const leave of leaves) {
    if (!leave.attendanceCode) continue;
    const first = leave.startDate > fromDate ? leave.startDate : fromDate;
    const last = leave.endDate < toDate ? leave.endDate : toDate;
    for (let date = first; date <= last; date = nextDate(date)) {
      if (!days.has(date)) days.set(date, leave);
    }
  }
  return days;
}

/** One entry per calendar day in [fromDate, toDate] covered by an approved leave. */
export function approvedLeaveDays(leaves: ApprovedLeave[], fromDate: string, toDate: string) {
  return leaveDaysInRange(leaves, fromDate, toDate);
}

/** Pending or approved leave covering each day — preferred entry is pending first if both exist. */
export function appliedLeaveDays(leaves: AppliedLeave[], fromDate: string, toDate: string) {
  const ordered = [...leaves].sort((left, right) => {
    if (left.status === right.status) return 0;
    return left.status === "pending" ? -1 : 1;
  });
  return leaveDaysInRange(ordered, fromDate, toDate);
}
