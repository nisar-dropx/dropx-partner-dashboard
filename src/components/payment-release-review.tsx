"use client";
import { useEffect, useState } from "react";
import type { PaymentReleaseReview } from "@/lib/payment-release-types";
import styles from "./payment-release.module.css";

type Options = { stations: { id: string; station_code: string; station_name: string }[]; runs: { id: string; label: string; period_start: string }[]; canApprove: boolean };
const money = (value: number) => `₹${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
export function PaymentReleaseReviewPanel({ initialStation = "", initialMonth = "", initialScope = "workforce" }: { initialStation?: string; initialMonth?: string; initialScope?: string }) {
  const [options, setOptions] = useState<Options | null>(null);
  const [station, setStation] = useState(initialStation);
  const [month, setMonth] = useState(initialMonth || new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()).slice(0, 7));
  const [scope, setScope] = useState(initialScope);
  const [review, setReview] = useState<PaymentReleaseReview | null>(null);
  const [reason, setReason] = useState("");
  const [owner, setOwner] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { let active = true; fetch("/api/payments/loss-clearance?options=1").then(async response => {
    const data = await response.json(); if (!response.ok) throw Error(data.error);
    if (active) setOptions(data);
  }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, []);
  useEffect(() => { setReview(null); setConfirmed(false); setReason(""); }, [station, month, scope]);
  async function load() {
    setBusy(true); setError(""); setConfirmed(false);
    try {
      const response = await fetch(`/api/payments/loss-clearance?${new URLSearchParams({ station, month, scope })}`);
      const data = await response.json(); if (!response.ok) throw Error(data.error); setReview(data);
    } catch (e) { setError(e instanceof Error ? e.message : "Review failed."); setReview(null); }
    finally { setBusy(false); }
  }
  const exception = Boolean(review && (review.pendingCount || review.missingDeductionCount));
  async function decide(action: string) {
    if (!review) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/payments/loss-clearance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ station, month, scope, action, fingerprint: review.fingerprint, reason: reason.trim(), owner, followUp }) });
      const data = await response.json(); if (!response.ok) throw Error(data.error); setReview(data); setConfirmed(false);
    } catch (e) { setError(e instanceof Error ? e.message : "Approval failed."); }
    finally { setBusy(false); }
  }
  return <section className={styles.workspace} aria-label="Loss clearance review">
    <h2>Loss clearance</h2>
    <p>Review NL and SLP losses before releasing salary. Approval applies to this station, salary month and payroll source. Changed loss or payroll details require a new review.</p>
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
      <label>Salary month<input type="month" value={month} onChange={e => setMonth(e.target.value)} disabled={busy} /></label>
      <label>Station<select value={station} onChange={e => setStation(e.target.value)} disabled={busy}><option value="">Select station</option>{options?.stations.map(s => <option key={s.id} value={s.id}>{s.station_code} · {s.station_name}</option>)}</select></label>
      <label>Payroll source<select value={scope} onChange={e => { setScope(e.target.value); const run = options?.runs.find(r => `people:${r.id}` === e.target.value); if (run) setMonth(run.period_start.slice(0, 7)); }} disabled={busy}>
        <option value="workforce">Workforce payouts</option><option value="helpers">Helper payouts</option>
        {options?.runs.map(r => <option key={r.id} value={`people:${r.id}`}>People · {r.label}</option>)}
      </select></label>
      <button type="button" disabled={busy || !station} onClick={load}>{busy ? "Checking…" : "Review loss clearance"}</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {review && <div style={{ marginTop: 20 }}>
      <strong>{review.approval ? "Payment release approved" : "Payment release awaiting approval"}</strong>
      <p>{review.sourceCount} source cases reviewed · {review.pendingCount} pending updates ({money(review.pendingAmount)}) · {review.missingDeductionCount} deductions awaiting application ({money(review.missingDeductionAmount)})</p>
      {!review.sourceCount && <p>No loss cases are recorded for this station through the selected month. The approver must verify that all expected NL and SLP files have been received.</p>}
      {exception && <details open><summary>Items requiring a decision</summary><div style={{ overflowX: "auto", maxHeight: 350 }}><table><thead><tr><th>Source / person</th><th>Shipment / recovery</th><th>Amount</th><th>Status</th></tr></thead><tbody>
        {review.pending.map(p => <tr key={`${p.month}:${p.reference}`}><td>{p.report.toUpperCase()} · {p.month}</td><td>{p.reference}</td><td>{money(p.amount)}</td><td>{p.status}</td></tr>)}
        {review.missingDeductions.map(p => <tr key={p.reference}><td>{p.worker}</td><td>{p.reference}</td><td>{money(p.amount)}</td><td>Deduction awaiting application</td></tr>)}
      </tbody></table></div></details>}
      {review.approval && <p>Approved by {review.approval.actor} · {new Date(review.approval.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST · {review.approval.mode === "exception" ? "Release with pending items" : "Cleared"}<br />{review.approval.reason}</p>}
      {options?.canApprove && <div style={{ display: "grid", gap: 10, maxWidth: 720, marginTop: 15 }}>
        <label>Review note<textarea value={reason} onChange={e => setReason(e.target.value)} minLength={10} maxLength={1500} disabled={busy} placeholder="Record the checks completed and the reason for your decision." /></label>
        {exception && <><label>Recovery owner<input value={owner} onChange={e => setOwner(e.target.value)} disabled={busy} /></label><label>Follow-up date<input type="date" value={followUp} onChange={e => setFollowUp(e.target.value)} disabled={busy} /></label></>}
        <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} disabled={busy} /> {exception ? "I authorise salary release with the listed pending amounts and have assigned their follow-up." : "I have verified NL/SLP source completeness and the deductions for this payroll."}</label>
        <div><button type="button" disabled={busy || !confirmed || reason.trim().length < 10 || (exception && (!owner.trim() || !followUp))} onClick={() => decide(exception ? "exception" : "approve")}>{exception ? "Approve release with exception" : "Approve payment release"}</button>{review.approval && <button type="button" disabled={busy || reason.trim().length < 10} onClick={() => decide("revoke")}>Withdraw release approval</button>}</div>
      </div>}
    </div>}
  </section>;
}
