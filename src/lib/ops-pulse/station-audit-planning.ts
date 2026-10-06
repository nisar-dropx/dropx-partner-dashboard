/** Calendar and programme rules shared by the server, exports and audit workspace. */
export type PlanningType = {
  cadence_unit: string;
  required_count: number;
  scheduling_config: Record<string, unknown>;
};
export type AuditTiming = {
  status_code: string;
  started_at?: string | null;
  completed_at?: string | null;
};
export function validAuditDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T12:00:00Z`)) &&
    new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value
  );
}
export function auditDay(value: string | Date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}
export function auditLocalTime(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}
export function auditTimestamp(date: string, time: string) {
  if (!validAuditDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw new Error("Choose a valid audit date and time.");
  return new Date(`${date}T${time}:00+05:30`).toISOString();
}
export function addAuditDays(day: string, amount: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
export function auditWeek(day: string) {
  const date = new Date(`${day}T12:00:00Z`);
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return `${date.getUTCFullYear()}-W${String(Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)).padStart(2, "0")}`;
}
export function auditMonthRange(month: string) {
  if (!validAuditDate(`${month}-01`)) throw new Error("Choose a valid month.");
  const from = `${month}-01`;
  const last = new Date(`${from}T12:00:00Z`);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  const to = last.toISOString().slice(0, 10);
  const calendarFrom = addAuditDays(
    from,
    -((new Date(`${from}T12:00:00Z`).getUTCDay() + 6) % 7),
  );
  return { from, to, calendarFrom, calendarTo: addAuditDays(calendarFrom, 41) };
}
export function auditSlots(type: PlanningType) {
  const raw = type.scheduling_config.period_slots;
  const configured = (Array.isArray(raw) ? raw : []).filter(
    (s): s is Record<string, unknown> =>
      Boolean(s && typeof s === "object" && "code" in s),
  );
  return Array.from(
    { length: Math.max(1, Math.min(31, Number(type.required_count) || 1)) },
    (_, i) => {
      const slot = configured[i];
      return {
        code: String(slot?.code || (i === 0 ? "standard" : `audit_${i + 1}`)),
        label: String(slot?.label || `Audit ${i + 1}`),
        startDay: Number(slot?.start_day) || 1,
        endDay: Number(slot?.end_day) || 31,
      };
    },
  );
}
export function auditCycle(
  type: PlanningType,
  date: string,
  selectedSlot?: string,
) {
  if (!validAuditDate(date)) throw new Error("Choose a valid audit date.");
  const slots = auditSlots(type);
  const day = Number(date.slice(-2));
  const slot =
    selectedSlot ||
    slots.find((s) => day >= s.startDay && day <= s.endDay)?.code ||
    slots[0].code;
  if (!slots.some((row) => row.code === slot))
    throw new Error("Choose a programme slot configured in Audit Master.");
  const chosen = slots.find((row) => row.code === slot)!;
  if (
    type.cadence_unit !== "weekly" &&
    (day < chosen.startDay || day > chosen.endDay)
  )
    throw new Error(
      `${chosen.label}: choose a date from day ${chosen.startDay} to ${Math.min(chosen.endDay, Number(auditMonthRange(date.slice(0, 7)).to.slice(-2)))}.`,
    );
  return {
    cycleKey:
      type.cadence_unit === "weekly" ? auditWeek(date) : date.slice(0, 7),
    periodSlot: slot,
  };
}
export function auditPlanColumns(type: PlanningType, month: string) {
  const range = auditMonthRange(month);
  const slots = auditSlots(type);
  if (type.cadence_unit !== "weekly")
    return slots.map((slot, index) => ({
      ...slot,
      cycleKey: month,
      key: `${month}:${slot.code}`,
      label: `Audit ${index + 1}`,
      hint: `${slot.startDay}–${Math.min(slot.endDay, Number(range.to.slice(-2)))} ${new Intl.DateTimeFormat("en-IN", { month: "short" }).format(new Date(`${month}-01T12:00:00Z`))}`,
      date: `${month}-${String(Math.min(slot.startDay, Number(range.to.slice(-2)))).padStart(2, "0")}`,
      endDate: `${month}-${String(Math.min(slot.endDay, Number(range.to.slice(-2)))).padStart(2, "0")}`,
    }));
  const columns = [];
  let monday = range.calendarFrom;
  for (
    let week = 1;
    monday <= range.to;
    week++, monday = addAuditDays(monday, 7)
  ) {
    for (const slot of slots)
      columns.push({
        ...slot,
        cycleKey: auditWeek(monday),
        key: `${auditWeek(monday)}:${slot.code}`,
        label: `Week ${week}${slots.length > 1 ? ` · ${slot.label}` : ""}`,
        hint: `${monday.slice(5)} – ${addAuditDays(monday, 6).slice(5)}`,
        date: monday < range.from ? range.from : monday,
        endDate: addAuditDays(monday, 6),
      });
  }
  return columns;
}
export function auditDuration(audit: AuditTiming) {
  if (!audit.started_at || !audit.completed_at) return null;
  const elapsed = Date.parse(audit.completed_at) - Date.parse(audit.started_at);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed / 60000 : null;
}
export function isFastAudit(audit: AuditTiming) {
  const duration = auditDuration(audit);
  return duration !== null && duration <= 10;
}
export function auditTone(audit: AuditTiming) {
  if (["closed", "completed"].includes(audit.status_code)) return "complete";
  if (audit.status_code === "scheduled") return "scheduled";
  return "pending";
}
export function auditStatusLabel(status: string) {
  return (
    (
      {
        scheduled: "Scheduled",
        in_progress: "In progress",
        awaiting_station_response: "Station response pending",
        under_review: "Review pending",
        closed: "Completed",
        completed: "Completed",
      } as Record<string, string>
    )[status] || status.replaceAll("_", " ")
  );
}
/** Surprise audit schedules are never exposed to non-manager users. */
export function stationCanSeeAudit(
  audit: AuditTiming & { station_response_status?: string },
) {
  return (
    Boolean(audit.completed_at) &&
    (audit.status_code === "closed" ||
      audit.status_code === "under_review" ||
      (audit.status_code === "awaiting_station_response" &&
        audit.station_response_status === "requested"))
  );
}

export function isMyAudit(
  audit: { assigned_to: string | null; assignment_verified?: boolean },
  userId: string,
) {
  return audit.assignment_verified === true && audit.assigned_to === userId;
}
/** Auditors are grouped by linked user; the typed name on an unconfirmed audit is not an identity. */
export function auditAssigneeKey(audit: {
  assigned_to: string | null;
  assignment_verified?: boolean;
}) {
  if (!audit.assigned_to) return "unassigned";
  return audit.assignment_verified === true ? audit.assigned_to : "unconfirmed";
}
export function auditQueueBucket(
  audit: AuditTiming & { scheduled_for: string },
  today = auditDay(),
) {
  if (audit.completed_at) return "followup";
  const day = auditDay(audit.scheduled_for);
  if (day < today) return "overdue";
  if (day === today) return "today";
  if (day <= addAuditDays(today, 2)) return "next2";
  if (day <= addAuditDays(today, 7)) return "week";
  return "later";
}
export function auditResponseLabel(
  audit: {
    completed_at?: string | null;
    station_response_status: string;
    response_due_at?: string | null;
  },
  now = Date.now(),
) {
  if (!audit.completed_at) return "After audit";
  if (audit.station_response_status === "requested")
    return audit.response_due_at && Date.parse(audit.response_due_at) < now
      ? "Overdue response"
      : "Awaiting station";
  return (
    (
      {
        submitted: "Responded · review pending",
        accepted: "Response accepted",
        not_requested: "No response required",
      } as Record<string, string>
    )[audit.station_response_status] || "Not requested"
  );
}
