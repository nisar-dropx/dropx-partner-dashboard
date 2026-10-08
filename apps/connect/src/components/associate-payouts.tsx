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
import type {
  PublishedPayoutAttendanceRange,
  PublishedPayoutDeduction,
  PublishedPayoutEarning,
} from "@/lib/published-payout-breakdown";
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
  earnings: PublishedPayoutEarning[];
  deductionLines: PublishedPayoutDeduction[];
  attendanceSource: string;
  attendanceRanges: PublishedPayoutAttendanceRange[];
};

const money = (value: unknown) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(Number(value ?? 0));
const quantity = (value: unknown) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(Number(value ?? 0));
const localDate = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(`${value}T00:00:00+05:30`));
const localTime = (value: string) => new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
function periodLabel(from: string, to: string) {
  const start = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  return isCompleteCalendarMonth(from, to)
    ? new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(start)
    : `${localDate(from)} – ${localDate(to)}`;
}

function earningBasis(line: PublishedPayoutEarning) {
  if (line.basis === "per_month") return "Monthly amount prorated for eligible attendance";
  if (line.basis === "per_day") return "Work days × per-day rate";
  if (line.basis === "per_hour") return "Work hours × hourly rate";
  if (line.basis === "per_unit") return line.reportedUnits === undefined
    ? "Production units × rate"
    : `${quantity(line.reportedUnits)} reported · ${quantity(line.excludedUnits ?? 0)} excluded`;
  if (line.basis === "additional") return "Additional payment";
  return "Configured payment head";
}

function rateLabel(line: PublishedPayoutEarning) {
  if (line.rate === null) return "—";
  if (line.basis === "per_month") return `${money(line.rate)} / month`;
  if (line.basis === "per_day") return `${money(line.rate)} / day`;
  if (line.basis === "per_hour") return `${money(line.rate)} / hour`;
  return money(line.rate);
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

  function openDeductionDispute() {
    setDisputeAreas(["deduction"]);
    setShowDisputes(true);
  }

  const visibleEarnings = (payout?.earnings ?? []).filter((line) => line.amount !== 0 || line.rate !== null || line.units !== null);
  const visibleDeductions = (payout?.deductionLines ?? []).filter((line) => line.amount !== 0);

  return <section className={styles.card}>
    <header className={styles.heading}>
      <div><small>Published by Workforce</small><h2>Monthly payout</h2><p>Your finalized attendance, payment heads and deductions in one view.</p></div>
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
        <div><small>Net payable</small><strong>{money(payout.net)}</strong></div>
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

      <section className={styles.section}>
        <div className={styles.sectionHeading}><div><small>Earnings</small><h3>Payment heads</h3></div><strong>{money(payout.gross)}</strong></div>
        <div className={styles.paymentLines}>
          {visibleEarnings.map((line, index) => {
            const unitLabel = line.basis === "per_hour" ? "Work hours" : line.basis === "per_day" ? "Work days" : line.basis === "per_month" ? "Eligible days" : "Units";
            const unitValue = line.basis === "per_month" ? payout.days : line.units;
            return <div className={styles.paymentLine} key={`${line.code}|${line.basis}|${line.rate ?? "none"}|${index}`}>
              <div className={styles.lineIdentity}><strong>{line.label}</strong><small>{earningBasis(line)}</small></div>
              {unitValue !== null ? <div><small>{unitLabel}</small><strong>{quantity(unitValue)}</strong></div> : null}
              {line.rate !== null ? <div><small>{line.basis === "per_month" ? "Monthly amount" : "Rate"}</small><strong>{rateLabel(line)}</strong></div> : null}
              <div className={styles.lineAmount}><small>{line.basis === "per_month" ? "Payable amount" : "Amount"}</small><strong>{money(line.amount)}</strong></div>
            </div>;
          })}
          {!visibleEarnings.length ? <p className={styles.emptyLine}>No payment heads were included in this payout.</p> : null}
        </div>
        <div className={styles.sectionTotal}><span>Gross earnings</span><strong>{money(payout.gross)}</strong></div>
      </section>

      {visibleDeductions.length ? <section className={styles.section}>
        <div className={styles.sectionHeading}><div><small>Deductions</small><h3>Deduction heads</h3></div>{payout.canDispute ? <button type="button" onClick={openDeductionDispute}>Dispute a deduction</button> : null}</div>
        <div className={styles.deductionLines}>
          {visibleDeductions.map((line) => <div key={line.code}><span>{line.label}</span><strong>− {money(line.amount)}</strong></div>)}
        </div>
        <div className={`${styles.sectionTotal} ${styles.deductionTotal}`}><span>Gross deductions</span><strong>− {money(payout.deductions)}</strong></div>
      </section> : null}

      <div className={styles.total} aria-label="Final net payable">
        <div><small>Gross earnings minus gross deductions</small><span>Net payable</span><strong>{money(payout.net)}</strong></div>
      </div>

      <section className={styles.section}>
        <div className={styles.sectionHeading}><div><small>Payout details</small><h3>Payment information</h3></div></div>
        <div className={styles.identitySummary}><div><small>Employee code</small><strong>{payout.dropxId}</strong></div><div><small>Name</small><strong>{payout.name}</strong></div><div><small>Station</small><strong>{payout.station || "—"}</strong></div>{payout.bankDestinationAvailable ? <div><small>Bank account</small><strong>{payout.bankAccount} · {payout.ifsc || "IFSC not recorded"}</strong></div> : null}</div>
        <small>Provider IDs: {payout.providerIds.join(", ") || "Training / attendance"}</small>
        {payout.paymentReference ? <p>Payment reference: {payout.paymentReference} · {payout.paymentDate}</p> : null}
      </section>

      {(payout.canDispute || payout.disputes.length) ? <div className={styles.disputeToggle}>
        <div><strong>{payout.canDispute ? "Something looks incorrect?" : "Dispute history"}</strong><small>{payout.canDispute ? "Raise one dispute and select every affected payment area." : `${payout.disputes.length} dispute${payout.disputes.length === 1 ? "" : "s"} recorded for this payout.`}</small></div>
        <button type="button" aria-expanded={showDisputes} onClick={() => setShowDisputes((current) => !current)}>{showDisputes ? "Close" : payout.canDispute ? "Raise dispute" : "View disputes"}</button>
      </div> : null}

      {showDisputes ? <section className={styles.disputes}>
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
            return <article key={dispute.id}><header><div><b>{decoded.areas.length ? decoded.areas.join(" · ") : String(dispute.category).replaceAll("_", " ")}</b><small>Raised {localTime(dispute.created_at)} IST</small></div><strong>{String(dispute.status).replaceAll("_", " ")}</strong></header>
              {decoded.reason ? <p>{decoded.reason}</p> : null}
            </article>;
          })}
          {!payout.disputes.length ? <p>No disputes raised for this month.</p> : null}
        </section>
      </section> : null}
    </>}
  </section>;
}
