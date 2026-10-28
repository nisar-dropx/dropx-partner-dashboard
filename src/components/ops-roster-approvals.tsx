"use client";

import { useState, useTransition } from "react";
import { Check, Eye, RotateCcw, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { decideOpsRoster, loadOpsRosterApprovalPreview, type OpsRosterApprovalPreview } from "@/app/ops-pulse/rostering/actions";
import type { OpsRosterApproval } from "@/lib/ops-pulse/rostering";
import styles from "./ops-roster-planner.module.css";

function date(value: string) {
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

function dayLabel(value: string) {
  return new Intl.DateTimeFormat("en-IN", { weekday: "short", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

function RosterPreviewModal({
  preview,
  loading,
  error,
  onClose
}: {
  preview: OpsRosterApprovalPreview | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  return (
    <div className={styles.rosterModalBackdrop} role="presentation" onClick={onClose}>
      <div
        className={styles.rosterModal}
        role="dialog"
        aria-modal="true"
        aria-label="Station roster preview"
        onClick={(event) => event.stopPropagation()}
      >
        <header className={styles.rosterModalHead}>
          <div>
            <small>Submitted station roster</small>
            <strong>{preview ? `${preview.stationCode} · v${preview.revisionNo}` : "Loading roster"}</strong>
            {preview ? <p>{date(preview.periodStart)} – {date(preview.periodEnd)}</p> : null}
          </div>
          <button type="button" className="button secondary compact" onClick={onClose}>Close</button>
        </header>
        {loading ? <p className={styles.rosterModalStatus}>Loading the station week…</p> : null}
        {error ? <p className={styles.rosterModalStatus} role="alert">{error}</p> : null}
        {preview && !loading ? (
          <div className={styles.rosterModalGridWrap}>
            <table className={styles.rosterModalGrid}>
              <thead>
                <tr>
                  <th>Person</th>
                  {preview.dates.map((day) => (
                    <th key={day}>
                      <span>{dayLabel(day)}</span>
                      <strong>{dateLabel(day)}</strong>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.people.length ? preview.people.map((person) => (
                  <tr key={`${person.workerType}:${person.workerId}`}>
                    <th>
                      <strong>{person.name}</strong>
                      <small>{person.code}{person.designation ? ` · ${person.designation}` : ""}</small>
                    </th>
                    {person.days.map((cell) => (
                      <td key={cell.date} className={cell.dayType === "weekly_off" ? styles.rosterModalOff : cell.dayType === "working" ? styles.rosterModalWorking : styles.rosterModalBlank}>
                        {cell.dayType === "weekly_off" ? <><strong>Week Off</strong><small>Rest day</small></> : null}
                        {cell.dayType === "working" ? <><strong>{cell.shiftCode ?? "Shift"}</strong><small>{cell.shiftLabel}</small></> : null}
                        {cell.dayType === "blank" ? <small>—</small> : null}
                      </td>
                    ))}
                  </tr>
                )) : (
                  <tr>
                    <td colSpan={preview.dates.length + 1}>No assignments on this submitted roster.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function OpsRosterApprovals({ approvals }: { approvals: OpsRosterApproval[] }) {
  const router = useRouter();
  const [noteById, setNoteById] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const [previewPlanId, setPreviewPlanId] = useState<string | null>(null);
  const [preview, setPreview] = useState<OpsRosterApprovalPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  function decide(approval: OpsRosterApproval, decision: "approved" | "returned" | "rejected") {
    startTransition(async () => {
      const result = await decideOpsRoster({ planId: approval.planId, stepId: approval.stepId, decision, note: noteById[approval.stepId] ?? "" });
      setMessage({ tone: result.ok ? "success" : "error", text: result.message });
      if (result.ok) router.refresh();
    });
  }

  function openPreview(planId: string) {
    setPreviewPlanId(planId);
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    void loadOpsRosterApprovalPreview(planId).then((result) => {
      setPreviewLoading(false);
      if (!result.ok) {
        setPreviewError(result.message);
        return;
      }
      setPreview(result.preview);
    }).catch(() => {
      setPreviewLoading(false);
      setPreviewError("The roster could not be loaded.");
    });
  }

  return <section className={styles.approvals}>
    {message ? <div className={`message-panel ${message.tone === "error" ? "error" : "success"}`} role="status">{message.text}</div> : null}
    {approvals.map((approval) => <article key={approval.stepId}>
      <div className={styles.approvalSummary}>
        <span className={styles.approvalStation}>{approval.stationCode}</span>
        <div><h3>{approval.stationName || "Station roster"}</h3><p>{date(approval.periodStart)} – {date(approval.periodEnd)} · version {approval.revisionNo}</p></div>
        <span className={styles.stage}>Level {approval.stageNo} · {approval.stageType.replaceAll("_", " ")}</span>
      </div>
      <div className={styles.approvalFacts}>
        <span><small>Submitted by</small><strong>{approval.submittedBy}</strong></span>
        <span><small>People</small><strong>{approval.peopleCount}</strong></span>
        <span><small>Assignments</small><strong>{approval.assignmentCount}</strong></span>
        <span><small>Status</small><strong>Needs your action</strong></span>
      </div>
      <div className={styles.approvalActions}>
        <button type="button" className="button secondary compact" disabled={isPending || previewLoading} onClick={() => openPreview(approval.planId)}><Eye size={14} /> View roster</button>
        <input value={noteById[approval.stepId] ?? ""} onChange={(event) => setNoteById((current) => ({ ...current, [approval.stepId]: event.target.value }))} placeholder="Decision note (required for return/reject)" />
        <button type="button" className="button secondary compact" disabled={isPending} onClick={() => decide(approval, "returned")}><RotateCcw size={14} /> Return</button>
        <button type="button" className="button secondary compact" disabled={isPending} onClick={() => decide(approval, "rejected")}><X size={14} /> Reject</button>
        <button type="button" className="button primary compact" disabled={isPending} onClick={() => decide(approval, "approved")}><Check size={14} /> Approve</button>
      </div>
    </article>)}
    {!approvals.length ? <div className={styles.emptyApprovals}><Check size={22} /><strong>No roster approval needs your action.</strong><span>New submissions will appear here when the configured workflow reaches you.</span></div> : null}
    {previewPlanId ? (
      <RosterPreviewModal
        preview={preview}
        loading={previewLoading}
        error={previewError}
        onClose={() => { setPreviewPlanId(null); setPreview(null); setPreviewError(null); }}
      />
    ) : null}
  </section>;
}
