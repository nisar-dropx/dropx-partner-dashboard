"use client";

import { useEffect, useState } from "react";
import { auditDay, auditLocalTime, auditResponseLabel, auditStatusLabel, isFastAudit } from "@/lib/ops-pulse/station-audit-planning";
import { auditProgress, auditReportRangeError, summarizeAuditProgress } from "@/lib/ops-pulse/station-audit-progress";
import type { StationAudit, StationAuditWorkspace } from "@/lib/ops-pulse/station-audits";
import { auditActor } from "./audit-detail";
import styles from "./audit-workspace.module.css";

export function AuditRangeReport({ audits, workspace, range, error, loading, auditorName, onRange, onOpen }: {
  audits: StationAudit[]; workspace: StationAuditWorkspace;
  range: { from: string; to: string }; error: string; loading: boolean;
  auditorName: (audit: StationAudit) => string;
  onRange: (from: string, to: string) => void; onOpen: (audit: StationAudit) => void;
}) {
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [validation, setValidation] = useState(error);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { setFrom(range.from); setTo(range.to); setValidation(error); }, [range.from, range.to, error]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
  const summary = summarizeAuditProgress(audits, now);
  const rows = [...audits].sort((a, b) => Number(auditProgress(b, now).overdue) - Number(auditProgress(a, now).overdue) || a.scheduled_for.localeCompare(b.scheduled_for));
  return <section className={styles.reportPanel} aria-label="Audit completion report">
    <div className={styles.reportHeader}>
      <div><h2>Audit completion report</h2><p>Scheduled {range.from} to {range.to} · inclusive, IST. Current status, including unfinished audits.</p></div>
      <form className={styles.reportDates} onSubmit={(event) => {
        event.preventDefault(); const problem = auditReportRangeError(from, to); setValidation(problem);
        if (!problem) onRange(from, to);
      }}>
        <label>From<input aria-label="Report from date" type="date" required value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label>To<input aria-label="Report to date" type="date" required value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <button className="button primary" disabled={loading}>{loading ? "Loading…" : "Apply date range"}</button>
      </form>
    </div>
    {validation && <p role="alert" className={styles.notice}>{validation}</p>}
    {(from !== range.from || to !== range.to) && <p className={styles.notice}>Apply your dates to update the report and Excel download.</p>}
    <div className={styles.summary}>
      <div className={styles.metric}><span>Audits in this view</span><strong>{summary.total}</strong><small>Selected dates and filters</small></div>
      <div className={styles.metric}><span>Completed & closed</span><strong className={styles.complete}>{summary.completed}</strong><small>{summary.completionRate === null ? "No audits in this range" : `${(summary.completionRate * 100).toFixed(1)}% completion`}</small></div>
      <div className={styles.metric}><span>Not completed</span><strong>{summary.incomplete}</strong><small>{summary.notSubmitted} not submitted · {summary.submitted - summary.completed} in follow-up</small></div>
      <div className={styles.metric}><span>Overdue audits</span><strong className={styles.pending}>{summary.overdue}</strong><small>Scheduled time passed; not submitted</small></div>
    </div>
    <p className={styles.reportHint}>{summary.responsePending} station responses pending · {summary.waitingReview} awaiting review · {summary.upcoming} not yet due. Excel includes overview, station and auditor summaries, follow-up list and detailed records.</p>
    <div className={styles.tableScroll}>
      <table className={styles.reportTable}>
        <thead><tr><th>Station / audit</th><th>Scheduled · IST</th><th>Assigned auditor</th><th>Completion / status</th><th>Submission / station response</th><th>Next action</th><th>Report</th></tr></thead>
        <tbody>{rows.map((audit) => {
          const p = auditProgress(audit, now);
          return <tr key={audit.id}>
            <td><strong>{audit.stations?.station_code}</strong><small>{audit.ops_audit_types?.name || workspace.auditTypes.find((type) => type.id === audit.audit_type_id)?.name}</small><small>{audit.audit_number}</small></td>
            <td>{auditDay(audit.scheduled_for)}<small>{auditLocalTime(audit.scheduled_for)}{p.overdue ? ` · ${p.daysOverdue ? `${p.daysOverdue}d overdue` : "overdue today"}` : ""}</small></td>
            <td>{auditorName(audit)}</td>
            <td><strong className={p.completed ? styles.complete : p.overdue ? styles.pending : ""}>{p.completion}</strong><small>{auditStatusLabel(audit.status_code)}</small></td>
            <td>{audit.completed_at ? <><span>{auditDay(audit.completed_at)} · {auditLocalTime(audit.completed_at)}</span><small>By {auditActor(audit, workspace, "submitted")}</small>{isFastAudit(audit) && <small className={styles.pending}>≤10 min · quality check</small>}</> : <span>Not submitted</span>}<small>{auditResponseLabel(audit, now)}</small></td>
            <td>{p.nextAction}</td>
            <td><button className="button secondary compact" onClick={() => onOpen(audit)}>{audit.completed_at ? "View report" : "View audit"}</button></td>
          </tr>;
        })}{!rows.length && <tr><td colSpan={7} className={styles.empty}>No audits match these dates and filters.</td></tr>}</tbody>
      </table>
    </div>
    <p className={styles.reportHint}>Includes scheduled audit records only. Unscheduled programme slots remain in Monthly plan. Submitted fieldwork is shown separately from final closure.</p>
  </section>;
}
