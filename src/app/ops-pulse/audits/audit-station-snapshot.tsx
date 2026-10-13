"use client";

import { useEffect, useState } from "react";
import type { AuditStationSnapshot } from "@/lib/ops-pulse/station-audit-snapshot";
import { loadAuditSnapshot } from "./actions";
import styles from "./audit-workspace.module.css";

const count = (value: number) => value.toLocaleString("en-IN");
const money = (value: number) =>
  `₹${Math.round(value).toLocaleString("en-IN")}`;
const dayLabel = (date: string, index: number) =>
  index === 0 ? "Today" : index === 1 ? "Yesterday" : date;
const slipDone = new Set(["Complete", "No Cash", "Banker Not Reported"]);

/**
 * The station's standing before the visit: cash with executives, shipments ageing
 * at the station, packages not debriefed and the COD slip. Read on opening the
 * audit; a figure that is unavailable is shown as such, never as zero.
 */
export function StationSnapshot({ auditId }: { auditId: string }) {
  const [snapshot, setSnapshot] = useState<AuditStationSnapshot | null>(null);
  const [notice, setNotice] = useState("Loading station figures…");
  useEffect(() => {
    let active = true;
    setSnapshot(null);
    setNotice("Loading station figures…");
    loadAuditSnapshot(auditId)
      .then((result) => {
        if (!active) return;
        setSnapshot(result.snapshot);
        setNotice(result.ok ? "" : result.message);
      })
      .catch(() => {
        if (active) setNotice("Station figures could not be loaded.");
      });
    return () => {
      active = false;
    };
  }, [auditId]);
  if (!snapshot)
    return (
      <p className={styles.muted} style={{ margin: "8px 18px" }} role="status">
        {notice}
      </p>
    );
  const { cia, ageing, held, slips } = snapshot;
  const missing = (slips || []).filter((slip) => !slip.uploaded && !slipDone.has(slip.status));
  return (
    <div className={styles.snapshot} aria-label="Station figures before the audit">
      <div className={cia && cia.pendingLiability > 0 ? styles.snapshotAlert : ""}>
        <span>Cash in Associate</span>
        <strong>{cia ? money(cia.total) : "Not available"}</strong>
        <small>
          {cia
            ? `${money(cia.pendingLiability)} pending liability`
            : "No CIA snapshot for this station"}
        </small>
      </div>
      <div className={ageing && ageing.overdue > 0 ? styles.snapshotAlert : ""}>
        <span>Ageing at station</span>
        <strong>{ageing ? count(ageing.total) : "Not available"}</strong>
        <small>
          {ageing
            ? `${count(ageing.overdue)} past promised date · ${count(ageing.dueToday)} due today`
            : "No ageing snapshot for this station"}
        </small>
      </div>
      <div
        className={
          (held && held.held > 0) || (cia && cia.pendingExecutives > 0)
            ? styles.snapshotAlert
            : ""
        }
      >
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
      <div className={missing.length ? styles.snapshotAlert : ""}>
        <span>COD slip</span>
        <strong>
          {slips
            ? missing.length
              ? "Not uploaded"
              : slips[0].status
            : "Not in COD programme"}
        </strong>
        <small>
          {(slips || [])
            .map(
              (slip, index) =>
                `${dayLabel(slip.date, index)}: ${slip.uploaded ? slip.status : slipDone.has(slip.status) ? slip.status : "no slip"}`,
            )
            .join(" · ")}
        </small>
      </div>
    </div>
  );
}
