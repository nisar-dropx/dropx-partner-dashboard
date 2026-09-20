"use client";

import { useState, useTransition } from "react";
import { Check, RotateCcw, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { decideOpsRoster } from "@/app/ops-pulse/rostering/actions";
import type { OpsRosterApproval } from "@/lib/ops-pulse/rostering";
import styles from "./ops-roster-planner.module.css";

function date(value: string) {
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

export function OpsRosterApprovals({ approvals }: { approvals: OpsRosterApproval[] }) {
  const router = useRouter();
  const [noteById, setNoteById] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  function decide(approval: OpsRosterApproval, decision: "approved" | "returned" | "rejected") {
    startTransition(async () => {
      const result = await decideOpsRoster({ planId: approval.planId, stepId: approval.stepId, decision, note: noteById[approval.stepId] ?? "" });
      setMessage({ tone: result.ok ? "success" : "error", text: result.message });
      if (result.ok) router.refresh();
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
        <Link className="button secondary compact" href={`/rostering?station=${encodeURIComponent(approval.stationCode)}`}>View roster</Link>
        <input value={noteById[approval.stepId] ?? ""} onChange={(event) => setNoteById((current) => ({ ...current, [approval.stepId]: event.target.value }))} placeholder="Decision note (required for return/reject)" />
        <button type="button" className="button secondary compact" disabled={isPending} onClick={() => decide(approval, "returned")}><RotateCcw size={14} /> Return</button>
        <button type="button" className="button secondary compact" disabled={isPending} onClick={() => decide(approval, "rejected")}><X size={14} /> Reject</button>
        <button type="button" className="button primary compact" disabled={isPending} onClick={() => decide(approval, "approved")}><Check size={14} /> Approve</button>
      </div>
    </article>)}
    {!approvals.length ? <div className={styles.emptyApprovals}><Check size={22} /><strong>No roster approval needs your action.</strong><span>New submissions will appear here when the configured workflow reaches you.</span></div> : null}
  </section>;
}
