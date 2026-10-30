"use client";
import { useState, type ReactNode } from "react";
import { LossShipmentHistory, lossUpdateTime } from "./loss-shipment-history";
import styles from "./nl-loss.module.css";

/** A compact worklist row. Only the selected row expands into its existing editor. */
export function LossCaseRow({ station, tid, approximate, reason, value, date, updatedBy, historyCase, status, open, onTrack, onToggle }: {
  station: string; tid: string; approximate?: boolean; reason: string; value: string; date?: string; updatedBy?: string; historyCase?: {month: string; caseKey: string};
  status: ReactNode; open: boolean; onTrack: () => void; onToggle: () => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  return <><div className={styles.caseTop}>
    <div className={styles.caseId}>{!approximate ? <button type="button" onClick={onTrack} aria-label={`Track ${tid} in SCC`}>{station} · {tid} ↗</button> : <strong>{station} · ≈ {tid}</strong>}{historyCase ? <button type="button" className={styles.historyButton} aria-label={`History for ${tid}`} aria-expanded={historyOpen} onClick={() => setHistoryOpen(v => !v)}>History</button> : null}</div>
    <button type="button" className={styles.compactCaseToggle} aria-label={`${open ? "Close" : "Open"} ${tid} details`} aria-expanded={open} onClick={onToggle}>
      <span className={styles.caseReason} title={reason}>{reason}</span>
      <span className={styles.caseDate} title={lossUpdateTime(date)}>{date ? <><b>{updatedBy || "Actor not recorded"}</b><time dateTime={date}>{lossUpdateTime(date)}</time></> : "—"}</span>
      <strong>{value}</strong><span className={styles.caseStatus}>{status}</span><span>{open ? "−" : "+"}</span>
    </button>
  </div>{historyOpen && historyCase ? <LossShipmentHistory key={date || ""} {...historyCase} tid={tid}/> : null}</>;
}
export function LossCaseColumns({ readOnly = false }: { readOnly?: boolean } = {}) {
  return <div className={styles.caseColumns} aria-hidden="true"><span>Station · TID</span><div><span>Reason / period</span><span>Last updated by · date / time (IST)</span><span>Value</span><span>{readOnly ? "Status · view details" : "Status · click to update"}</span><span/></div></div>;
}
