/**
 * Approved leave on the DropX One attendance calendar.
 *
 * Approving leave writes nothing to attendance_daily or the roster, so without
 * this the calendar showed an approved CL/SL/comp-off day as an empty or absent
 * day. The attendance route stamps each approved leave day with the leave
 * type's attendance code, and the calendar then colours it the same way as any
 * configured leave: paid types (CL, SL, week-off/holiday comp-off) in the
 * paid-leave colour, unpaid types (LOP) in the leave colour.
 */
export type ApprovedLeave = {
  startDate: string;
  endDate: string;
  attendanceCode: string;
  attendanceLabel: string | null;
  name: string;
};

function nextDate(date: string) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

/** One entry per calendar day in [fromDate, toDate] covered by an approved leave. */
export function approvedLeaveDays(leaves: ApprovedLeave[], fromDate: string, toDate: string) {
  const days = new Map<string, ApprovedLeave>();
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
