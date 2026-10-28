"use client";
import { useEffect, useState } from "react";
import type { Recovery } from "@/lib/ops-pulse/nl-loss-policy";
import styles from "./nl-loss.module.css";

export function lossUpdateTime(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Date(value).toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true, timeZone: "Asia/Kolkata",
  }) + " IST";
}
type Snapshot = Partial<Recovery> | null;
type Event = { id: string; actor_name: string; created_at: string; before_value: Snapshot; after_value: Snapshot };
const money = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(n);
function SnapshotDetails({ value, title }: { value: Snapshot; title: string }) {
  return <div><b>{title}</b>{!value ? <p>No saved plan</p> : <>
    <p>{value.is_deleted ? "Plan removed" : value.outcome_label || "Recovery update"}{value.approval_status ? ` · ${value.approval_status.replaceAll("_", " ")}` : ""}</p>
    {value.deduction_month ? <p>Payroll month: {value.deduction_month} · {value.recovery_mode === "installments" ? "Recurring debit" : "Full debit"}</p> : null}
    {value.allocations?.map(p => <p key={p.ref}>{p.full_name} ({p.employee_code}) · {money(p.amount)}{p.installments?.length ? ` · ${p.installments.length} instalments` : ""}</p>)}
    {value.remarks ? <p>Remarks: {value.remarks}</p> : null}
    {value.approval_note ? <p>Approval note: {value.approval_note}</p> : null}
    {value.recovery_details?.reason ? <p>Reason: {value.recovery_details.reason}</p> : null}
    {value.recovery_details?.details ? <p>Details: {value.recovery_details.details}</p> : null}
  </>}</div>;
}
export function LossShipmentHistory({ month, caseKey, tid }: { month: string; caseKey: string; tid: string }) {
  const [events, setEvents] = useState<Event[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState(""), [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let disposed = false;
    setLoading(true); setError("");
    const timeout = setTimeout(() => controller.abort(), 30000);
    void (async () => {
      try {
        const q = new URLSearchParams({ month, case: caseKey });
        const res = await fetch(`/api/ops-pulse/losses/recovery/history?${q}`, { cache: "no-store", signal: controller.signal });
        const data = await res.json(); if (!res.ok) throw Error(data.error || "History could not be loaded.");
        if (!disposed) setEvents(data.history);
      } catch (e) { if (!disposed) setError(controller.signal.aborted ? "History took too long to load. Please retry." : e instanceof Error ? e.message : "History could not be loaded."); }
      finally { clearTimeout(timeout); if (!disposed) setLoading(false); }
    })();
    return () => { disposed = true; clearTimeout(timeout); controller.abort(); };
  }, [month, caseKey, retry]);
  return <section className={styles.shipmentHistory} aria-label={`Recovery update history for ${tid}`}>
    <h3>Recovery update history · {tid}</h3><small>Latest first · all times IST · expand an update to compare before and after.</small>
    {loading ? <p role="status">Loading shipment history…</p> : error ? <p role="alert">{error} <button type="button" onClick={() => setRetry(n => n + 1)}>Retry</button></p> : !events.length ? <p>No recorded recovery updates for this shipment.</p> : <div className={styles.shipmentHistoryScroll}><table>
      <thead><tr><th>Date & time (IST)</th><th>Updated by</th><th>Update / changes</th></tr></thead>
      <tbody>{events.map(event => <tr key={event.id}>
        <td><time dateTime={event.created_at}>{lossUpdateTime(event.created_at)}</time></td><td>{event.actor_name || "Actor not recorded"}</td>
        <td><details><summary>{event.after_value?.is_deleted ? "Plan removed" : !event.before_value || event.before_value.is_deleted ? "Plan created" : "Plan updated"} · {event.after_value?.outcome_label || "Recovery"}{event.after_value?.approval_status ? ` · ${event.after_value.approval_status.replaceAll("_", " ")}` : ""}</summary>
          <div className={styles.historyComparison}><SnapshotDetails title="Before" value={event.before_value}/><SnapshotDetails title="After" value={event.after_value}/></div>
        </details></td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}
