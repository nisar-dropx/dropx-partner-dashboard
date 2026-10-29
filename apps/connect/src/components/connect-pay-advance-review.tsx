"use client";

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { PayAdvanceApproval, PayAdvanceReviewDetails } from "@/lib/connect-pay-advance-approval";

const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(value);
const label = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, c => c.toUpperCase());
function date(value: string | null, monthOnly = false) {
  if (!value) return "Not recorded";
  const parsed = new Date(value.length === 7 ? `${value}-01T00:00:00Z` : value);
  if (!Number.isFinite(parsed.getTime())) return "Not recorded";
  return new Intl.DateTimeFormat("en-IN", monthOnly ? { month: "long", year: "numeric", timeZone: "Asia/Kolkata" }
    : { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(parsed);
}

export function ConnectPayAdvanceReview({ accountId, profileType, approval }: {
  accountId: string; profileType: string; approval: PayAdvanceApproval;
}) {
  const [data, setData] = useState<PayAdvanceReviewDetails | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setData(null); setError("");
    const params = new URLSearchParams({ accountId, profileType, requestId: approval.requestId });
    void fetch(`/api/connect/approvals/pay-advance?${params}`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || "Advance details could not be loaded.");
        if (!controller.signal.aborted) setData(value);
      }).catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Advance details could not be loaded.");
      });
    return () => controller.abort();
  }, [accountId, profileType, approval.requestId, attempt]);
  const previous = data?.steps.filter(step => step.status === "approved" && step.approvedAmount != null).at(-1);
  const outstandingPay = data?.capacity.outstandingPay ?? approval.outstandingPay;
  const max = data?.requestLimit ?? approval.maxEligibleAmount;
  const recovered = data?.advances.reduce((sum, a) => sum + a.recovered, 0);
  const outstanding = data?.advances.reduce((sum, a) => sum + a.outstanding, 0) ?? approval.outstandingAdvance;
  const reserved = data?.advances.reduce((sum, a) => sum + a.reserved, 0) ?? approval.reservedRecovery;
  return <section className="dx-advance-review" aria-label="Advance request details">
    <p className="dx-advance-explanation">You are reviewing a pay advance at the <strong>{approval.stepName}</strong> step. Approval records this decision; payment is confirmed separately by the bank.</p>
    <dl className="dx-approval-facts dx-advance-key-facts">
      <div><dt>Requested advance</dt><dd>{money(approval.requestedAmount)}</dd></div>
      {approval.approvedAmount != null ? <div><dt>{previous ? "Previously approved amount" : "Amount carried into this approval"}</dt><dd>{money(previous?.approvedAmount ?? approval.approvedAmount)}
        <small>{previous ? `${previous.actorName || previous.label} · ${previous.label} · ${date(previous.actedAt)}` : "See approval history below for the earlier decision."}</small>
        <small>This is an approval amount, not a paid advance.</small></dd></div> : null}
      <div><dt>Available advance for this request</dt><dd>{max == null ? "Unavailable" : money(max)}<small>Current eligibility, capped by the request's original limit.</small></dd></div>
      <div><dt>Unpaid salary / payout balance</dt><dd>{outstandingPay == null ? "Unavailable" : money(outstandingPay)}<small>Expand payroll periods below to see which months contribute.</small></dd></div>
      <div><dt>Recovery terms</dt><dd>{approval.recoveryMode === "installments" ? `${approval.installments} installments` : "One-time deduction"}</dd></div>
      {approval.neededBy ? <div><dt>Needed by</dt><dd>{new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(approval.neededBy))}</dd></div> : null}
      <div className="dx-advance-wide"><dt>Reason for request</dt><dd>{approval.reason}</dd></div>
    </dl>
    {error ? <div className="dx-advance-load-error" role="alert"><p>{error}</p><button type="button" onClick={() => setAttempt(n => n + 1)}>Retry review details</button></div>
      : !data ? <p role="status" className="dx-advance-explanation">Loading approval history, payroll periods and advance history…</p> : <>
        <details className="dx-advance-section">
          <summary><span><strong>Approval history</strong><small>{data.steps.filter(s => s.status === "approved").length} approved · {approval.stepName} pending</small></span><ChevronDown aria-hidden="true" /></summary>
          <ol className="dx-advance-timeline">
            <li><strong>Request submitted</strong><span>{data.submittedBy}</span><small>{date(data.requestedAt)}</small></li>
            {data.steps.map(step => <li key={step.id} className={step.status === "pending" ? "is-current" : ""}>
              <strong>{step.label} · {step.status === "pending" ? "Awaiting decision" : label(step.status)}</strong>
              <span>{step.actorName || "Approver not recorded"}{step.approvedAmount != null ? ` · Approved ${money(step.approvedAmount)}` : ""}</span>
              {step.actedAt ? <small>{date(step.actedAt)}</small> : null}{step.note ? <p>{step.note}</p> : null}
            </li>)}
          </ol>
        </details>
        <details className="dx-advance-section">
          <summary><span><strong>Outstanding payroll periods</strong><small>{money(data.capacity.outstandingPay)} unpaid across the periods below</small></span><ChevronDown aria-hidden="true" /></summary>
          <div className="dx-advance-section-body">
            <dl className="dx-advance-periods">{data.capacity.breakdown.map(period => <div key={period.month}><dt>{date(period.month, true)}</dt><dd>{money(period.outstanding)}</dd></div>)}</dl>
            <p>Previous and current month unpaid pay, after recorded deductions and payments. This balance is salary/payout owed to the person, not an advance owed by them.</p>
            <dl className="dx-advance-periods"><div><dt>{data.capacity.eligibilityPercent}% of unpaid pay</dt><dd>{money(data.capacity.outstandingPay * data.capacity.eligibilityPercent / 100)}</dd></div>
              <div><dt>Other pending / approved unpaid advances</dt><dd>{money(data.capacity.committedAdvance)}</dd></div>
              <div><dt>Available advance now</dt><dd>{money(data.capacity.maxEligibleAmount)}</dd></div>
              <div><dt>Maximum for this request</dt><dd>{money(data.requestLimit)}</dd></div></dl>
            <p>Other unpaid requests reduce availability. This request also keeps its original eligibility limit. Eligibility is checked again when you approve.</p>
          </div>
        </details>
      </>}
    <dl className="dx-approval-facts dx-advance-key-facts">
      <div><dt>Paid advances this month</dt><dd>{approval.monthPaidCount} · {money(approval.monthPaidAmount)}</dd></div>
      <div><dt>Outstanding advance to recover</dt><dd>{money(outstanding)}</dd></div>
      <div><dt>Scheduled payroll deductions</dt><dd>{money(reserved)}<small>Included in outstanding until recovery is confirmed.</small></dd></div>
      {recovered != null ? <div><dt>Recovered from paid advances</dt><dd>{money(recovered)}</dd></div> : null}
    </dl>
    {data ? <details className="dx-advance-section">
      <summary><span><strong>Advance payment and recovery history</strong><small>{data.advances.length} paid {data.advances.length === 1 ? "advance" : "advances"} · {money(outstanding)} outstanding</small></span><ChevronDown aria-hidden="true" /></summary>
      <div className="dx-advance-section-body">
        {!data.advances.length ? <p>No paid advances are recorded for this person. This pending request will appear here after bank-confirmed payment.</p> : data.advances.map(a => <details className="dx-advance-history-entry" key={a.id}>
          <summary><span><strong>{a.reference} · {money(a.amount)}</strong><small>{date(a.paidAt)} · {money(a.outstanding)} outstanding</small></span><ChevronDown aria-hidden="true" /></summary>
          <div className="dx-advance-section-body">
            <dl className="dx-advance-periods"><div><dt>Recovered</dt><dd>{money(a.recovered)}</dd></div><div><dt>Outstanding</dt><dd>{money(a.outstanding)}</dd></div>
              <div><dt>Scheduled deductions</dt><dd>{money(a.reserved)}</dd></div>{a.waived ? <div><dt>Waived</dt><dd>{money(a.waived)}</dd></div> : null}
              <div><dt>First recovery period</dt><dd>{date(a.firstDuePeriod, true)}</dd></div><div><dt>Recovery installments</dt><dd>{a.installments}</dd></div></dl>
            <p>{a.evidence === "bank_confirmed" ? "Bank-confirmed payment" : "Historical recorded payment"}{a.bankReference ? ` · Reference: ${a.bankReference}` : " · Bank reference not recorded"}</p>
            {a.deductions.length ? <div className="dx-advance-table-scroll"><table><thead><tr><th>Recovery period</th><th>Amount</th><th>Status</th><th>Payroll / payout</th></tr></thead><tbody>{a.deductions.map(d => <tr key={d.id}><td>{date(d.period, true)}</td><td>{money(d.amount)}</td><td>{d.status === "reserved" ? "Scheduled" : d.status === "confirmed" ? "Recovered" : label(d.status)}</td><td>{d.target === "people" ? "People payroll" : d.target === "workforce" ? "Workforce payout" : "Historical recovery"}</td></tr>)}</tbody></table></div> : <p>No payroll recovery has been recorded yet.</p>}
          </div>
        </details>)}
      </div>
    </details> : null}
  </section>;
}
