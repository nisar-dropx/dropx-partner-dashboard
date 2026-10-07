"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  decodePayoutDisputeReason,
  isCompleteCalendarMonth,
  PAYOUT_DISPUTE_AREAS,
  payoutMonthForPeriod,
  payoutMonthLabel,
  type PayoutDisputeArea,
  type PayoutReviewState,
} from "@/lib/payout-dispute";
import styles from "./associate-payouts.module.css";

type Row = Record<string, any>;
type Payout = Row & {
  id: string;
  publicationId: string | null;
  name: string;
  dropxId: string;
  station: string;
  from: string;
  to: string;
  status: string;
  reviewUntil: string | null;
  reviewState: PayoutReviewState;
  canDispute: boolean;
  revisionPending: boolean;
  disputes: Row[];
  lines: Row[];
};

const money = (value: unknown) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(Number(value ?? 0));
const localDate = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(`${value}T00:00:00+05:30`));
const localTime = (value: string) => new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
function periodLabel(from: string, to: string) {
  const start = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  return isCompleteCalendarMonth(from, to)
    ? new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(start)
    : `${localDate(from)} – ${localDate(to)}`;
}

export function AssociatePayouts({ accountId, profileType, month, onMonthLockChange }: { accountId: string; profileType: string; month: string; onMonthLockChange?: (locked: boolean) => void }) {
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState("");
  const [tab, setTab] = useState("summary");
  const [notice, setNotice] = useState("");
  const [disputeAreas, setDisputeAreas] = useState<PayoutDisputeArea[]>([]);
  const loadGeneration = useRef(0);
  const query = new URLSearchParams({ accountId, profileType }).toString();

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    try {
      const response = await fetch(`/api/connect/payout-review?${query}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      if (generation !== loadGeneration.current) return;
      setPayouts(body.payouts);
      setLoadError("");
    } catch (reason) {
      if (generation !== loadGeneration.current) return;
      setLoadError(reason instanceof Error ? reason.message : "Unable to load finalized earnings.");
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    setPayouts([]);
    setSelected("");
    setTab("summary");
    setDisputeAreas([]);
    setNotice("");
    setLoadError("");
    setActionError("");
  }, [query]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    setSelected("");
    setTab("summary");
    setDisputeAreas([]);
    setNotice("");
    setActionError("");
  }, [month]);

  useEffect(() => {
    onMonthLockChange?.(loading || busy);
    return () => onMonthLockChange?.(false);
  }, [busy, loading, onMonthLockChange]);

  async function send(event: React.FormEvent<HTMLFormElement>, payout: Payout, disputeId?: string) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (!disputeId && !disputeAreas.length) {
      setActionError("Select at least one area to dispute.");
      return;
    }
    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      const response = await fetch(`/api/connect/payout-review?${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: disputeId ? "reply" : "create",
          disputeId,
          publicationId: payout.publicationId,
          categories: disputeId ? undefined : disputeAreas,
          reason: data.get("reason"),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      form.reset();
      if (!disputeId) setDisputeAreas([]);
      setNotice(disputeId ? "Reply sent." : "Dispute sent to Workforce and your station team.");
      await load();
    } catch (sendError) {
      setActionError(sendError instanceof Error ? sendError.message : "Unable to send the dispute.");
    } finally {
      setBusy(false);
    }
  }

  const monthPayouts = payouts.filter((item) => payoutMonthForPeriod(item.from, item.to) === month);
  const payout = monthPayouts.find((item) => item.id === selected) ?? monthPayouts[0];
  const reviewMessage = payout?.reviewState === "open"
    ? `Disputes accepted until ${localTime(payout.reviewUntil!)} IST.`
    : payout?.reviewState === "expired"
      ? `The dispute window closed on ${localTime(payout.reviewUntil!)} IST.`
      : payout?.reviewState === "revising"
        ? "Workforce is preparing a revised amount. Disputes reopen after it is published."
        : payout?.reviewState === "confirmed"
          ? "This payout is confirmed. Its amount and payment status remain available here."
          : "This payout is not currently open for disputes.";

  function openDeductionDispute() {
    setDisputeAreas(["deduction"]);
    setTab("disputes");
  }

  return <section className={styles.card}>
    <header className={styles.heading}>
      <div><small>Published by Workforce</small><h2>Finalized earnings</h2><p>Review the frozen pay-period calculation and raise a dispute before the deadline.</p></div>
      <button type="button" onClick={() => void load()} disabled={loading}>Refresh</button>
    </header>
    {loadError ? <p className={styles.error} role="alert">{loadError}</p> : null}
    {actionError ? <p className={styles.error} role="alert">{actionError}</p> : null}
    {notice ? <p className={styles.success} role="status">{notice}</p> : null}
    {loading ? <p>Loading finalized earnings…</p> : loadError ? null : !payout ? <div className={styles.empty}>
      <strong>No finalized earnings published for {payoutMonthLabel(month)}</strong>
      <p>Live earnings remain available in the Live earnings tab. This month appears here after Workforce freezes and publishes it for review.</p>
    </div> : <>
      {monthPayouts.length > 1 ? <label className={styles.period}>Pay period
        <select value={payout.id} onChange={(event) => { setSelected(event.target.value); setTab("summary"); setDisputeAreas([]); }}>
          {monthPayouts.map((item) => <option key={item.id} value={item.id}>{periodLabel(item.from, item.to)} · {item.station || "Station not recorded"} · {item.status}</option>)}
        </select>
      </label> : null}
      <div className={styles.total}>
        <div><small>{periodLabel(payout.from, payout.to)} · {payout.status}</small><span>Final net earnings for this period</span><strong>{money(payout.net)}</strong></div>
        {payout.payoutSlipAvailable ? <a href={`/api/connect/payout-slip?${query}&runId=${encodeURIComponent(payout.id)}`} target="_blank" rel="noreferrer">View PDF</a> : null}
      </div>
      <p className={`${styles.reviewMessage} ${payout.canDispute ? styles.reviewOpen : ""}`}>{reviewMessage}</p>
      <nav className={styles.tabs} aria-label="Finalized payout details">
        {(["summary", "deductions", "daily", "disputes"] as const).map((item) => <button type="button" key={item} aria-pressed={tab === item} onClick={() => setTab(item)}>
          {item === "disputes" ? `Disputes (${payout.disputes.length})` : item[0].toUpperCase() + item.slice(1)}
        </button>)}
      </nav>

      {tab === "summary" ? <>
        <div className={styles.counts}>
          {[["Work days", payout.days], ["Delivery", payout.counts.delivery], ["C-return", payout.counts.cReturn], ["MFN", payout.counts.mfn], ["MFN return", payout.counts.mfnReturn]].map(([label, value]) => <div key={label}><small>{label}</small><b>{value}</b></div>)}
        </div>
        <dl>{[["Base & attendance pay", payout.base], ["Incentives", payout.incentive], ["Allowances / additions", payout.additions], ["Deductions", -payout.deductions], ["Final net earnings", payout.net]].map(([label, value]) => <div key={label}>
          <dt>{label === "Deductions" ? <button type="button" onClick={() => setTab("deductions")}>Deductions →</button> : label}</dt><dd>{money(value)}</dd>
        </div>)}</dl>
        <div className={styles.identitySummary}><div><small>Employee code</small><strong>{payout.dropxId}</strong></div><div><small>Name</small><strong>{payout.name}</strong></div><div><small>Station</small><strong>{payout.station || "—"}</strong></div>{payout.bankDestinationAvailable ? <div><small>Bank account</small><strong>{payout.bankAccount} · {payout.ifsc || "IFSC not recorded"}</strong></div> : null}</div>
        <small>Provider IDs: {payout.providerIds.join(", ") || "Training / attendance"}</small>
        {payout.paymentReference ? <p>Payment reference: {payout.paymentReference} · {payout.paymentDate}</p> : null}
      </> : null}

      {tab === "deductions" ? <>
        {payout.lines.filter((line: Row) => line.adjustment < 0 || line.originalAmount < 0).map((line: Row, index: number) => <article key={index}>
          <header><b>{String(line.category).replaceAll("_", " ")}</b><strong>{money(Math.max(0, -line.adjustment))}</strong></header>
          <p>{line.reason || "Contact Workforce for the recorded basis."}</p><small>{line.date}{line.originalAmount !== null ? ` · Original deduction ${money(-line.originalAmount)}` : ""}</small>
          {payout.canDispute ? <button type="button" onClick={openDeductionDispute}>Dispute this deduction</button> : null}
        </article>)}
        {!payout.lines.some((line: Row) => line.adjustment < 0 || line.originalAmount < 0) ? <p>No deductions in this finalized month.</p> : null}
      </> : null}

      {tab === "daily" ? <div className={styles.scroll}><table><thead><tr><th>Date / ID</th><th>Delivery</th><th>C-return</th><th>MFN</th><th>MFN return</th><th>Pay</th></tr></thead><tbody>
        {payout.lines.map((line: Row, index: number) => <tr key={index}><td>{line.date}<small>{line.providerId || line.type} · {line.providerName || payout.name}</small></td><td>{line.delivery}</td><td>{line.cReturn}</td><td>{line.mfn}</td><td>{line.mfnReturn}</td><td>{money(line.net)}</td></tr>)}
      </tbody></table></div> : null}

      {tab === "disputes" ? <>
        {payout.canDispute ? <form onSubmit={(event) => void send(event, payout)} className={styles.form}>
          <div className={styles.disputeIdentity}><div><small>Month / pay period</small><strong>{periodLabel(payout.from, payout.to)}</strong></div><div><small>Employee code</small><strong>{payout.dropxId}</strong></div><div><small>Name</small><strong>{payout.name}</strong></div><div><small>Station</small><strong>{payout.station || "—"}</strong></div></div>
          <fieldset className={styles.areas}><legend>Select dispute for *</legend><div>
            {PAYOUT_DISPUTE_AREAS.map((area) => <label key={area.value}><input type="checkbox" name="categories" value={area.value} checked={disputeAreas.includes(area.value)} onChange={(event) => setDisputeAreas((current) => event.target.checked ? [...current, area.value] : current.filter((item) => item !== area.value))}/><span>{area.label}</span></label>)}
          </div></fieldset>
          <label>Your dispute *<textarea name="reason" required minLength={10} maxLength={1800} placeholder="Mention the date, amount or count, what is incorrect, and what you expected." /></label>
          <button disabled={busy}>{busy ? "Sending…" : "Send dispute"}</button>
        </form> : <p>{reviewMessage} Contact Workforce if a later correction is required.</p>}

        <section className={styles.history}><h3>Dispute history</h3>
          {payout.disputes.map((dispute: Row) => {
            const decoded = decodePayoutDisputeReason(dispute.reason);
            const events = (dispute.events ?? []).filter((event: Row) => String(event.message ?? "").trim() !== String(dispute.reason ?? "").trim());
            return <article key={dispute.id}><header><div><b>{decoded.areas.length ? decoded.areas.join(" · ") : String(dispute.category).replaceAll("_", " ")}</b><small>Raised {localTime(dispute.created_at)} IST</small></div><strong>{String(dispute.status).replaceAll("_", " ")}</strong></header>
              {decoded.reason ? <p>{decoded.reason}</p> : null}
              {events.map((event: Row) => <p key={event.id}><b>{event.actor_name}</b> · {localTime(event.created_at)} IST<br />{event.message}</p>)}
              {["open", "in_review"].includes(dispute.status) ? <form onSubmit={(event) => void send(event, payout, dispute.id)} className={styles.form}><label>Reply<textarea name="reason" required minLength={3} maxLength={2000} /></label><button disabled={busy}>Send reply</button></form> : null}
            </article>;
          })}
          {!payout.disputes.length ? <p>No disputes raised for this month.</p> : null}
        </section>
      </> : null}
    </>}
  </section>;
}
