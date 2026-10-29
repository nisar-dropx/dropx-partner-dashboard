"use client";
import { RecoveryDetailButton } from "./connect-loss-recovery-detail";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  decodePayoutDisputeReason,
  isCompleteCalendarMonth,
  PAYOUT_DISPUTE_AREAS,
  payoutMonthForPeriod,
  payoutMonthLabel,
  type AssociatePayoutDispute,
  type PayoutDisputeArea,
  type PayoutReviewState,
} from "@/lib/payout-dispute";
import type {
  PublishedPayoutAttendanceRange,
  PublishedPayoutDeduction,
  PublishedPayoutEarning,
} from "@/lib/published-payout-breakdown";
import styles from "./associate-payouts.module.css";
import {payoutEarningGroups,payoutUnit} from "@/lib/payout-display";

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
  disputes: AssociatePayoutDispute[];
  lines: Row[];
  earnings: PublishedPayoutEarning[];
  deductionLines: PublishedPayoutDeduction[];
  attendanceSource: string;
  attendanceRanges: PublishedPayoutAttendanceRange[];
};

const money = (value: unknown) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(Number(value ?? 0));
const paiseMoney = (value: number) => money(value / 100);
const quantity = (value: unknown) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(Number(value ?? 0));
const localDate = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(`${value}T00:00:00+05:30`));
const localTime = (value: string) => new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
function periodLabel(from: string, to: string) {
  const start = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  return isCompleteCalendarMonth(from, to)
    ? new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(start)
    : `${localDate(from)} – ${localDate(to)}`;
}

function friendlyField(value: string | null) {
  if (!value) return "Approved payout value";
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function signedPaise(value: number) {
  if (value > 0) return `+ ${paiseMoney(value)}`;
  if (value < 0) return `− ${paiseMoney(Math.abs(value))}`;
  return paiseMoney(0);
}

function DisputeProgress({ dispute }: { dispute: AssociatePayoutDispute }) {
  const steps = ["Initial approval", "Final approval", "Payout correction", "Completed"];
  const rejected = dispute.status === "rejected";
  return <>
    <div className={`${styles.workflowStatus} ${dispute.workflow.blocked ? styles.workflowBlocked : ""}`}>
      <strong>{dispute.workflow.label}</strong>
      <p>{dispute.workflow.detail}</p>
      {dispute.processing?.processedAt ? <small>Correction completed {localTime(dispute.processing.processedAt)} IST</small>
        : dispute.processing?.claimedAt ? <small>Processing started {localTime(dispute.processing.claimedAt)} IST</small> : null}
    </div>
    {!rejected && !dispute.legacyResolutionUnverified ? <ol className={styles.workflowProgress} aria-label="Dispute progress">
      {steps.map((label, index) => {
        const step = index + 1;
        const complete = dispute.workflow.terminal || step < dispute.workflow.step;
        const current = !dispute.workflow.terminal && step === dispute.workflow.step;
        return <li key={label} className={complete ? styles.workflowComplete : current ? styles.workflowCurrent : ""} aria-current={current ? "step" : undefined}>
          <span aria-hidden="true">{complete ? "✓" : step}</span><small>{label}</small>
        </li>;
      })}
    </ol> : null}
  </>;
}

function DisputeCorrection({ dispute }: { dispute: AssociatePayoutDispute }) {
  const correction = dispute.correction;
  if (!correction) return null;
  const hasValues = correction.currentValue !== null || correction.proposedValue !== null;
  const hasTotals = correction.beforeNetPaise !== null || correction.afterNetPaise !== null || correction.deltaPaise !== null;
  if (!hasValues && !hasTotals) return null;
  return <section className={styles.correction} aria-label="Approved payout correction">
    <small>Approved correction</small>
    <h4>{friendlyField(correction.targetField)}</h4>
    {hasValues ? <p>
      <span>{correction.currentValue ?? "Not recorded"}</span>
      <b aria-label="changed to">→</b>
      <strong>{correction.proposedValue ?? "Not recorded"}</strong>
    </p> : null}
    {correction.note ? <p className={styles.correctionNote}>{correction.note}</p> : null}
    {hasTotals ? <div className={styles.correctionTotals}>
      {correction.beforeNetPaise !== null ? <div><small>Earlier net payout</small><strong>{paiseMoney(correction.beforeNetPaise)}</strong></div> : null}
      {correction.afterNetPaise !== null ? <div><small>{correction.netChangeVerified ? "Revised net payout" : "Expected revised net payout"}</small><strong>{paiseMoney(correction.afterNetPaise)}</strong></div> : null}
      {correction.deltaPaise !== null ? <div><small>{correction.netChangeVerified ? "Payout difference" : "Expected difference"}</small><strong className={correction.deltaPaise < 0 ? styles.negative : ""}>{signedPaise(correction.deltaPaise)}</strong></div> : null}
    </div> : null}
  </section>;
}

function DisputePayment({ dispute }: { dispute: AssociatePayoutDispute }) {
  const payment = dispute.payment;
  if (!payment) return null;
  return <section className={styles.disputePayment} aria-label="Payment status for this correction">
    <small>Payment status</small>
    <div>
      {payment.status ? <p><span>Status</span><strong>{payment.status}</strong></p> : null}
      {payment.paidAmountPaise !== null ? <p><span>Already paid</span><strong>{paiseMoney(payment.paidAmountPaise)}</strong></p> : null}
      {payment.additionalBalancePaise !== null ? <p><span>Additional balance</span><strong>{paiseMoney(payment.additionalBalancePaise)}</strong></p> : null}
      {payment.reference ? <p><span>Bank reference</span><strong>{payment.reference}</strong></p> : null}
      {payment.date ? <p><span>Payment date</span><strong>{localTime(payment.date)} IST</strong></p> : null}
    </div>
  </section>;
}

export function AssociatePayouts({ accountId, profileType, month, onMonthLockChange }: { accountId: string; profileType: string; month: string; onMonthLockChange?: (locked: boolean) => void }) {
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState("");
  const [showDisputes, setShowDisputes] = useState(false);
  const [notice, setNotice] = useState("");
  const [disputeAreas, setDisputeAreas] = useState<PayoutDisputeArea[]>([]);
  const loadGeneration = useRef(0);
  const disputeSectionRef = useRef<HTMLElement>(null);
  const query = new URLSearchParams({ accountId, profileType }).toString();

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setLoadError("");
    try {
      const response = await fetch(`/api/connect/payout-review?${query}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok || !Array.isArray(body.payouts)) throw new Error("Payout lookup failed");
      if (generation !== loadGeneration.current) return;
      setPayouts(body.payouts);
      setLoadError("");
    } catch {
      if (generation !== loadGeneration.current) return;
      setLoadError("We couldn’t load your published payouts. Please select Retry. If this continues, contact the Workforce team.");
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    setPayouts([]);
    setSelected("");
    setShowDisputes(false);
    setDisputeAreas([]);
    setNotice("");
    setLoadError("");
    setActionError("");
  }, [query]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    setSelected("");
    setShowDisputes(false);
    setDisputeAreas([]);
    setNotice("");
    setActionError("");
  }, [month]);

  useEffect(() => {
    onMonthLockChange?.(loading || busy);
    return () => onMonthLockChange?.(false);
  }, [busy, loading, onMonthLockChange]);

  useEffect(() => {
    if (!showDisputes) return;
    const frame = window.requestAnimationFrame(() => {
      disputeSectionRef.current?.focus({ preventScroll: true });
      disputeSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [showDisputes]);

  async function send(event: React.FormEvent<HTMLFormElement>, payout: Payout) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (!disputeAreas.length) {
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
          operation: "create",
          publicationId: payout.publicationId,
          categories: disputeAreas,
          reason: data.get("reason"),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      form.reset();
      setDisputeAreas([]);
      setNotice("Dispute sent to Workforce for review.");
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

  function toggleDisputeSection() {
    setShowDisputes((current) => !current);
  }

  const visibleEarnings = (payout?.earnings ?? []).filter((line) => line.amount !== 0 || line.rate !== null || line.units !== null);
  const visibleDeductions = (payout?.deductionLines ?? []).filter((line) => line.amount !== 0);
  const shipmentLosses = visibleDeductions.filter(line => line.code === "LOSS_RECOVERY" || line.recoveryKey);
  const otherDeductions = visibleDeductions.filter(line => line.code !== "LOSS_RECOVERY" && !line.recoveryKey);
  const shipmentLossTotal = Math.round(shipmentLosses.reduce((sum, line) => sum + line.amount, 0) * 100) / 100;

  return <section className={styles.card} aria-busy={loading}>
    <header className={styles.heading}>
      <div><small>Published by Workforce</small><h2>Monthly payout</h2><p>Your confirmed pay, allowances and deductions for the selected period.</p></div>
      <button type="button" onClick={() => void load()} disabled={loading}>{loadError ? "Retry" : "Refresh"}</button>
    </header>
    {loadError ? <p className={styles.error} role="alert">{loadError}</p> : null}
    {actionError ? <p className={styles.error} role="alert">{actionError}</p> : null}
    {notice ? <p className={styles.success} role="status">{notice}</p> : null}
    {loading ? <p role="status">Loading published payouts…</p> : loadError ? null : !payout ? <div className={styles.empty} role="status">
      <strong>Payout not published yet</strong>
      <p>No payout is available for {payoutMonthLabel(month)} yet. It will appear here once published by Workforce. For ongoing earnings, use the Live earnings tab.</p>
    </div> : <>
      {monthPayouts.length > 1 ? <label className={styles.period}>Pay period
        <select value={payout.id} onChange={(event) => { setSelected(event.target.value); setShowDisputes(false); setDisputeAreas([]); }}>
          {monthPayouts.map((item) => <option key={item.id} value={item.id}>{periodLabel(item.from, item.to)} · {item.station || "Station not recorded"} · {item.status}</option>)}
        </select>
      </label> : null}
      <div className={styles.total}>
        <div><small>{periodLabel(payout.from, payout.to)} · {payout.status}</small><span>Net payable</span><strong>{money(payout.net)}</strong></div>
        {payout.payoutSlipAvailable ? <a href={`/api/connect/payout-slip?${query}&runId=${encodeURIComponent(payout.id)}`} target="_blank" rel="noreferrer">View PDF</a> : null}
      </div>
      <p className={`${styles.reviewMessage} ${payout.canDispute ? styles.reviewOpen : ""}`}>{reviewMessage}</p>
      <div className={styles.summaryTotals} aria-label="Payout totals">
        <div><small>Gross earnings</small><strong>{money(payout.gross)}</strong></div>
        <div><small>Gross deductions</small><strong className={payout.deductions ? styles.negative : ""}>{payout.deductions ? `− ${money(payout.deductions)}` : money(0)}</strong></div>
      </div>

      {(payout.days > 0 || payout.attendanceSource || payout.attendanceRanges.length > 0) ? <section className={styles.section}>
        <div className={styles.sectionHeading}><div><small>Attendance</small><h3>Attendance used for this payout</h3></div></div>
        <div className={styles.attendance}>
          <div><small>Work days</small><strong>{quantity(payout.days)}</strong>{payout.attendanceSource ? <span>{payout.attendanceSource}</span> : null}</div>
          {payout.attendanceRanges.map((range) => <div key={`${range.basis}|${range.effectiveFrom}|${range.effectiveTo}`}>
            <small>Uploaded work {range.basis}</small><strong>{quantity(range.quantity)}</strong><span>{localDate(range.effectiveFrom)} – {localDate(range.effectiveTo)}</span>
          </div>)}
        </div>
      </section> : null}

      <section className={styles.section} aria-label="Published earnings breakdown">
        {payoutEarningGroups(visibleEarnings).map(group=><section className={styles.payGroup} key={group.title}>
          <header><h3>{group.title}</h3><strong>{money(group.lines.reduce((n,l)=>n+l.amount,0))}</strong></header>
          {group.lines.map((line,index)=><article className={styles.payLine} key={`${line.code}:${index}`}>
            <div><strong>{line.label}</strong><p>{line.basis==='per_month'?'Monthly salary':line.basis==='per_day'?'Daily pay':line.basis==='per_hour'?'Hourly pay':line.units!==null?`${quantity(line.units)} ${payoutUnit(line)}${payoutUnit(line)==='km'?'':'s'}`:'Additional pay'}{line.rate!==null?` · ${money(line.rate)} / ${payoutUnit(line)}`:''}</p>{line.excludedUnits? <small>{quantity(line.excludedUnits)} units excluded under your rate agreement</small>:null}</div>
            <strong>{money(line.amount)}</strong>
          </article>)}
        </section>)}
        {!visibleEarnings.some(l=>l.amount!==0)?<p className={styles.emptyLine}>No earnings were included in this payout.</p>:null}
        {visibleEarnings.some(l=>l.amount===0)?<details className={styles.zeroActivity}><summary>Activity with no separate payment</summary><p>These counts are recorded in the statement but do not add to this payout.</p>{visibleEarnings.filter(l=>l.amount===0).map((line,index)=><div key={`${line.code}:${index}`}><span>{line.label}{line.units!==null?` · ${quantity(line.units)} ${payoutUnit(line)}${payoutUnit(line)==='km'?'':'s'}`:''}</span><strong>{money(0)}</strong></div>)}</details>:null}
      </section>

      {visibleDeductions.length ? <section className={styles.section}>
        <div className={styles.sectionHeading}><div><small>Deductions</small><h3>Deduction heads</h3></div><strong className={styles.negative}>− {money(payout.deductions)}</strong></div>
        <div className={styles.tableWrap}>
          <table className={`${styles.breakdownTable} ${styles.deductionTable}`} aria-label="Deduction heads breakdown">
            <thead><tr><th scope="col">Deduction</th><th scope="col">Amount</th></tr></thead>
            <tbody>{otherDeductions.map((line) => <tr key={line.code}><th scope="row">{line.label}</th><td>− {money(line.amount)}</td></tr>)}
              {shipmentLosses.length ? <tr><th scope="row"><details><summary>Shipment loss · {shipmentLosses.length}</summary>
                {shipmentLosses.map((line, index) => <div key={line.recoveryKey || index}><span>{line.label} · {money(line.amount)}</span>{line.recoveryKey ? <RecoveryDetailButton accountId={accountId} profileType={profileType} recoveryKey={line.recoveryKey} amount={line.amount} payrollLabel="published payout"/> : null}</div>)}
              </details></th><td>− {money(shipmentLossTotal)}</td></tr> : null}
            </tbody>
            <tfoot><tr><th scope="row">Gross deductions</th><td>− {money(payout.deductions)}</td></tr></tfoot>
          </table>
        </div>
      </section> : null}

      <div className={styles.total} aria-label="Final net payable">
        <div><small>Gross earnings minus gross deductions</small><span>Net payable</span><strong>{money(payout.net)}</strong></div>
      </div>

      <section className={styles.section}>
        <div className={styles.sectionHeading}><div><small>Bank destination</small><h3>Payment information</h3></div></div>
        {payout.bankDestinationAvailable ? <div className={styles.tableWrap}>
          <table className={`${styles.breakdownTable} ${styles.bankTable}`} aria-label="Bank details">
            <tbody>
              <tr><th scope="row">Bank account</th><td>{payout.bankAccount || "Not recorded"}</td></tr>
              <tr><th scope="row">IFSC</th><td>{payout.ifsc || "Not recorded"}</td></tr>
            </tbody>
          </table>
        </div> : <p className={styles.emptyLine}>Bank details are not available for this payout.</p>}
      </section>

      {(payout.canDispute || payout.disputes.length) ? <div className={styles.disputeToggle}>
        <div><strong>{payout.canDispute ? "Something looks incorrect?" : "Dispute history"}</strong><small>{payout.canDispute ? "Raise one dispute and select every affected payment area." : `${payout.disputes.length} dispute${payout.disputes.length === 1 ? "" : "s"} recorded for this payout.`}</small></div>
        <button type="button" aria-expanded={showDisputes} aria-controls="payout-dispute-section" onClick={toggleDisputeSection}>{showDisputes ? "Close" : payout.canDispute ? "Raise dispute" : "View disputes"}</button>
      </div> : null}

      {showDisputes ? <section ref={disputeSectionRef} id="payout-dispute-section" className={styles.disputes} tabIndex={-1} aria-labelledby="payout-dispute-heading">
        <header className={styles.disputeHeading}><small>Payout review</small><h3 id="payout-dispute-heading">{payout.canDispute ? "Raise a dispute" : "Dispute history"}</h3></header>
        {payout.canDispute ? <form onSubmit={(event) => void send(event, payout)} className={styles.form}>
          <div className={styles.disputeIdentity}><div><small>Month / pay period</small><strong>{periodLabel(payout.from, payout.to)}</strong></div><div><small>Employee code</small><strong>{payout.dropxId}</strong></div><div><small>Name</small><strong>{payout.name}</strong></div><div><small>Station</small><strong>{payout.station || "—"}</strong></div></div>
          <fieldset className={styles.areas}><legend>Select dispute for *</legend><div>
            {PAYOUT_DISPUTE_AREAS.map((area) => <label key={area.value}><input type="checkbox" name="categories" value={area.value} checked={disputeAreas.includes(area.value)} onChange={(event) => setDisputeAreas((current) => event.target.checked ? [...current, area.value] : current.filter((item) => item !== area.value))}/><span>{area.label}</span></label>)}
          </div></fieldset>
          <label>Your dispute *<textarea name="reason" required minLength={10} maxLength={1800} placeholder="Mention the date, amount or count, what is incorrect, and what you expected." /></label>
          <button disabled={busy}>{busy ? "Sending…" : "Send dispute"}</button>
        </form> : <p>{reviewMessage} Contact Workforce if a later correction is required.</p>}

        <section className={styles.history}>{payout.canDispute ? <h3>Dispute history</h3> : null}
          {payout.disputes.map((dispute: AssociatePayoutDispute) => {
            const decoded = decodePayoutDisputeReason(dispute.reason);
            return <article key={dispute.id} className={styles.disputeRecord}><header><div><b>{decoded.areas.length ? decoded.areas.join(" · ") : String(dispute.category).replaceAll("_", " ")}</b><small>Raised {localTime(dispute.created_at)} IST</small></div></header>
              {decoded.reason ? <p>{decoded.reason}</p> : null}
              <DisputeProgress dispute={dispute} />
              <DisputeCorrection dispute={dispute} />
              {dispute.resolution ? <section className={styles.disputeDecision} aria-label="Final dispute decision"><small>Final decision</small><p>{dispute.resolution}</p></section> : null}
              {dispute.timeline.length ? <section className={styles.disputeTimeline} aria-label="Dispute comments">
                <small>Updates and comments</small>
                <ol>{dispute.timeline.map((event, index) => <li key={`${event.createdAt}:${index}`}>
                  <div><strong>{event.label}</strong><time>{event.createdAt ? `${localTime(event.createdAt)} IST` : ""}</time></div>
                  <p>{event.comment}</p>
                </li>)}</ol>
              </section> : null}
              <DisputePayment dispute={dispute} />
            </article>;
          })}
          {!payout.disputes.length ? <p>No disputes raised for this month.</p> : null}
        </section>
      </section> : null}
    </>}
  </section>;
}
