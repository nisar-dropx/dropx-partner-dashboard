import { auditDay, auditTone, validAuditDate } from "./station-audit-planning";

export type AuditProgressRow = {
  scheduled_for: string;
  status_code: string;
  started_at?: string | null;
  completed_at?: string | null;
  station_response_status?: string;
  response_due_at?: string | null;
};

/** Inclusive scheduled dates in IST; completion status is current, not a historical snapshot. */
export function auditReportRangeError(from: string, to: string) {
  if (!validAuditDate(from) || !validAuditDate(to) || from > to)
    return "Choose a valid From and To date, with From on or before To.";
  if ((Date.parse(to) - Date.parse(from)) / 86400000 >= 366)
    return "Choose up to 366 days per report.";
  return "";
}
export function inAuditReportRange(audit: AuditProgressRow, from: string, to: string) {
  const day = auditDay(audit.scheduled_for);
  return day >= from && day <= to;
}
export function auditProgress(audit: AuditProgressRow, now = Date.now()) {
  const completed = auditTone(audit) === "complete";
  const submitted = Boolean(audit.completed_at) || completed;
  const overdue = !submitted && Date.parse(audit.scheduled_for) < now;
  const responsePending = !completed && audit.station_response_status === "requested";
  const responseOverdue = responsePending && Boolean(audit.response_due_at) && Date.parse(audit.response_due_at!) < now;
  const waitingReview = !completed && (audit.status_code === "under_review" || audit.station_response_status === "submitted");
  const daysOverdue = overdue ? Math.max(0, Math.round((Date.parse(auditDay(new Date(now))) - Date.parse(auditDay(audit.scheduled_for))) / 86400000)) : 0;
  return {
    completed, submitted, overdue, responsePending, responseOverdue, waitingReview, daysOverdue,
    completion: completed ? "Completed" : submitted ? "Submitted · follow-up pending" : overdue ? "Overdue · not submitted" : "Not submitted",
    nextAction: completed ? "No action required" : !submitted ? audit.started_at ? "Auditor: finish and submit the audit" : "Auditor: carry out and submit the audit" : responsePending ? "Station: respond in OpsPulse" : waitingReview ? "Audit manager: review and close" : "Audit manager: complete follow-up",
  };
}
export function matchesAuditReportStatus(audit: AuditProgressRow, status: string, now = Date.now()) {
  const p = auditProgress(audit, now);
  if (status === "incomplete") return !p.completed;
  if (status === "overdue") return p.overdue;
  if (status === "unsubmitted") return !p.submitted;
  if (status === "followup") return p.submitted && !p.completed;
  return status === "all" || auditTone(audit) === status;
}
export function summarizeAuditProgress(audits: AuditProgressRow[], now = Date.now()) {
  const p = audits.map((a) => auditProgress(a, now));
  const completed = p.filter((a) => a.completed).length;
  return {
    total: p.length, completed, incomplete: p.length - completed,
    submitted: p.filter((a) => a.submitted).length,
    notSubmitted: p.filter((a) => !a.submitted).length,
    overdue: p.filter((a) => a.overdue).length,
    upcoming: p.filter((a) => !a.submitted && !a.overdue).length,
    responsePending: p.filter((a) => a.responsePending).length,
    responseOverdue: p.filter((a) => a.responseOverdue).length,
    waitingReview: p.filter((a) => a.waitingReview).length,
    completionRate: p.length ? completed / p.length : null,
  };
}
