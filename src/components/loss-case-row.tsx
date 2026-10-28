"use client";
import type { ReactNode } from "react";
import styles from "./nl-loss.module.css";

/** A compact worklist row. Only the selected row expands into its existing editor. */
export function LossCaseRow({ station, tid, approximate, reason, value, date, status, open, onTrack, onToggle }: {
  station: string; tid: string; approximate?: boolean; reason: string; value: string; date?: string;
  status: ReactNode; open: boolean; onTrack: () => void; onToggle: () => void;
}) {
  return <div className={styles.caseTop}>
    <div className={styles.caseId}>{!approximate ? <button type="button" onClick={onTrack} aria-label={`Track ${tid} in SCC`}>{station} · {tid} ↗</button> : <strong>{station} · ≈ {tid}</strong>}</div>
    <button type="button" className={styles.compactCaseToggle} aria-label={`${open ? "Close" : "Open"} ${tid} details`} aria-expanded={open} onClick={onToggle}>
      <span className={styles.caseReason} title={reason}>{reason}</span>
      <span className={styles.caseDate} title={date}>{date ? new Date(date).toLocaleDateString("en-IN",{day:"2-digit",month:"short",timeZone:"Asia/Kolkata"}) : "—"}</span>
      <strong>{value}</strong><span className={styles.caseStatus}>{status}</span><span>{open ? "−" : "+"}</span>
    </button>
  </div>;
}
export function LossCaseColumns() {
  return <div className={styles.caseColumns} aria-hidden="true"><span>Station · TID</span><div><span>Reason / period</span><span>Updated</span><span>Value</span><span>Status · click to update</span><span/></div></div>;
}
