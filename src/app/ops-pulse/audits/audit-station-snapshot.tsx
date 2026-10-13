"use client";

import { useEffect, useState } from "react";
import type { AuditStationSnapshot } from "@/lib/ops-pulse/station-audit-snapshot";
import { loadAuditSnapshot } from "./actions";
import styles from "./audit-workspace.module.css";

const count = (value: number) => value.toLocaleString("en-IN");
const money = (value: number) =>
  `₹${Math.round(value).toLocaleString("en-IN")}`;
const readAt = (value: string) => {
  const time = new Date(value);
  return Number.isNaN(time.getTime())
    ? value
    : new Intl.DateTimeFormat("en-IN", {
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "Asia/Kolkata",
      }).format(time);
};
const dayLabel = (date: string, index: number) =>
  index === 0 ? "Today" : index === 1 ? "Yesterday" : date;
/** How one day's slip reads: its status once anything is recorded, otherwise whether it is late. */
const slipLabel = (slip: { status: string; uploaded: boolean; overdue: boolean }) =>
  slip.status !== "Missing slip"
    ? slip.status
    : slip.overdue
      ? "Not uploaded"
      : "Not uploaded yet";

/**
 * The station's standing before the visit: cash with executives, shipments ageing
 * at the station, packages not debriefed and the COD slip. Read on opening the
 * audit; a figure that is unavailable is shown as such, never as zero.
 */
export function StationSnapshot({ auditId }: { auditId: string }) {
  const [snapshot, setSnapshot] = useState<AuditStationSnapshot | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    setSnapshot(null);
    setNotice("");
    loadAuditSnapshot(auditId)
      .then((result) => {
        if (!active) return;
        setSnapshot(result.snapshot);
        setNotice(result.ok ? "" : result.message || "Station figures could not be loaded.");
      })
      .catch(() => {
        if (active) setNotice("Station figures could not be loaded.");
      });
    return () => {
      active = false;
    };
  }, [auditId]);
  // Closed by default so the audit window stays short; the heading says how
  // many figures need a look before anyone opens it.
  if (!snapshot)
    return (
      <details className={styles.reschedule}>
        <summary>Station figures · {notice ? "not loaded" : "loading…"}</summary>
        <p className={styles.muted} role="status">
          {notice}
        </p>
      </details>
    );
  const { cia, ageing, held, slips } = snapshot;
  // Before the day's deadline a missing slip is expected, not a finding.
  const late = (slips || []).filter((slip) => slip.overdue);
  const flags = {
    cia: Boolean(cia && cia.pendingLiability > 0),
    ageing: Boolean(ageing && ageing.overdue > 0),
    debrief: Boolean(
      (held && held.held > 0) || (cia && cia.pendingExecutives > 0),
    ),
    slip: late.length > 0,
  };
  const flagged = Object.values(flags).filter(Boolean).length;
  return (
    <details className={styles.reschedule}>
      <summary>
        Station figures · CIA, ageing, not debriefed, COD slip
        {flagged > 0 && (
          <>
            {" "}
            <mark className={styles.fast}>{flagged} to check</mark>
          </>
        )}
      </summary>
    <div
      className={styles.snapshot}
      style={{ margin: "10px 0 0" }}
      aria-label="Station figures before the audit"
    >
      <div className={flags.cia ? styles.snapshotAlert : ""}>
        <span>Cash in Associate</span>
        <strong>{cia ? money(cia.total) : "Not available"}</strong>
        <small>
          {cia
            ? `${money(cia.pendingLiability)} pending liability`
            : "No CIA snapshot for this station"}
        </small>
      </div>
      <div className={flags.ageing ? styles.snapshotAlert : ""}>
        <span>Ageing at station</span>
        <strong>{ageing ? count(ageing.total) : "Not available"}</strong>
        <small>
          {ageing
            ? `${count(ageing.overdue)} past promised date · ${count(ageing.dueToday)} due today`
            : "No ageing snapshot for this station"}
        </small>
      </div>
      <div className={flags.debrief ? styles.snapshotAlert : ""}>
        <span>Not debriefed</span>
        <strong>
          {cia
            ? `${count(cia.pendingExecutives)} executive${cia.pendingExecutives === 1 ? "" : "s"}`
            : held
              ? `${count(held.held)} packages`
              : "Not available"}
        </strong>
        <small>
          {cia ? "Reconciliation not done" : ""}
          {cia && held ? " · " : ""}
          {held
            ? `${count(held.held)} of ${count(held.assigned)} packages still out today`
            : ""}
        </small>
      </div>
      <div className={flags.slip ? styles.snapshotAlert : ""}>
        <span>COD slip</span>
        <strong>
          {slips
            ? slipLabel(late[0] || slips[0])
            : "Not in COD programme"}
        </strong>
        <small>
          {(slips || [])
            .map((slip, index) => `${dayLabel(slip.date, index)}: ${slipLabel(slip)}`)
            .join(" · ")}
        </small>
      </div>
    </div>
      <p className={styles.muted}>
        {[
          ["Ageing", ageing?.asOf],
          ["Not debriefed", held?.asOf],
          ["CIA", cia?.asOf],
        ]
          .filter((part): part is [string, string] => Boolean(part[1]))
          .map(([label, at]) => `${label} as of ${readAt(at)}`)
          .join(" · ") || "No live figures are available for this station."}
      </p>
    </details>
  );
}
