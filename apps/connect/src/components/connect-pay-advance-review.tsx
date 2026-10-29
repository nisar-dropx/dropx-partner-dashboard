"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { PayAdvanceApproval, PayAdvanceReviewDetails } from "@/lib/connect-pay-advance-approval";

const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);
const label = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, c => c.toUpperCase());
function date(value: string | null, monthOnly = false) {
  if (!value) return "Not recorded";
  const parsed = new Date(value.length === 7 ? `${value}-01T00:00:00Z` : value);
  if (!Number.isFinite(parsed.getTime())) return "Not recorded";
  return new Intl.DateTimeFormat("en-IN", monthOnly ? { month: "long", year: "numeric", timeZone: "Asia/Kolkata" }
    : { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(parsed);
}

export function ConnectPayAdvanceReview({ accountId, profileType, approval, children }: {
  accountId: string; profileType: string; approval: PayAdvanceApproval; children?: ReactNode;
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
  const max = data?.requestLimit ?? (approval.stepType === "finance" ? approval.maxEligibleAmount
    : Math.min(approval.requestedAmount, approval.maxEligibleAmount ?? approval.requestedAmount));
  const recovered = data?.advances.reduce((sum, a) => sum + a.recovered, 0);
  const outstanding = data?.advances.reduce((sum, a) => sum + a.outstanding, 0) ?? approval.outstandingAdvance;
  const reserved = data?.advances.reduce((sum, a) => sum + a.reserved, 0) ?? approval.reservedRecovery;
  return <section className="dx-advance-review" aria-label="Advance request details">
    <p className="dx-advance-reason"><strong>Reason</strong> {approval.reason || "Not provided"}</p>
    <dl className="dx-advance-metrics">
      <div><dt>Available limit</dt><dd>{max == null ? "Unavailable" : money(max)}</dd></div>
      <div><dt>Paid this month</dt><dd>{money(approval.monthPaidAmount)} <small>({approval.monthPaidCount} {approval.monthPaidCount === 1 ? "time" : "times"})</small></dd></div>
      <div><dt>Advance to recover</dt><dd>{money(outstanding)}</dd></div>
    </dl>
    {approval.neededBy ? <p className="dx-advance-explanation">Needed by {new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(approval.neededBy))}</p> : null}
    <div className="dx-advance-decision">{children}</div>
    {error ? <div className="dx-advance-load-error" role="alert"><p>{error}</p><button type="button" onClick={() => setAttempt(n => n + 1)}>Retry review details</button></div>
      : !data ? <p role="status" className="dx-advance-explanation">Loading history…</p> : <div className="dx-advance-details">
        <details className="dx-advance-section">
          <summary><span><strong>Approvals</strong><small>{previous ? `${money(previous.approvedAmount!)} approved · ${previous.actorName || previous.label}` : "No earlier approval"}</small></span><ChevronDown aria-hidden="true" /></summary>
          <p className="dx-advance-history-hint">Current step: {approval.stepName} · Awaiting decision. Payment follows bank confirmation.</p>
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
          <summary><span><strong>Payroll periods &amp; eligibility</strong><small>{outstandingPay == null ? "Balance unavailable" : `${money(outstandingPay)} unpaid salary / payout`}</small></span><ChevronDown aria-hidden="true" /></summary>
          <div className="dx-advance-section-body">
            <dl className="dx-advance-periods">{data.capacity.breakdown.map(period => <div key={period.month}><dt>{date(period.month, true)}</dt><dd>{money(period.outstanding)}</dd></div>)}</dl>
            <p>Salary / payout owed after recorded deductions and payments.</p>
            <dl className="dx-advance-periods"><div><dt>{data.capacity.eligibilityPercent}% of unpaid pay</dt><dd>{money(data.capacity.outstandingPay * data.capacity.eligibilityPercent / 100)}</dd></div>
              <div><dt>Other pending / approved unpaid advances</dt><dd>{money(data.capacity.committedAdvance)}</dd></div>
              <div><dt>Available advance now</dt><dd>{money(data.capacity.maxEligibleAmount)}</dd></div>
              <div><dt>Maximum for this request</dt><dd>{money(data.requestLimit)}</dd></div></dl>
            <p>Available limit accounts for other unpaid requests and this approval step’s cap. Rechecked on approval.</p>
          </div>
        </details>
    <details className="dx-advance-section">
      <summary><span><strong>Advance history</strong><small>{data.advances.length ? `${data.advances.length} paid · ${money(recovered ?? 0)} recovered` : "No paid advances"}</small></span><ChevronDown aria-hidden="true" /></summary>
      <div className="dx-advance-section-body">
        <dl className="dx-advance-periods">
          <div><dt>Requested recovery</dt><dd>{approval.recoveryMode === "installments" ? `${approval.installments} installments` : "One-time deduction"}</dd></div>
          <div><dt>Outstanding advance</dt><dd>{money(outstanding)}</dd></div>
          <div><dt>Scheduled deductions</dt><dd>{money(reserved)}</dd></div>
        </dl>
        {reserved > 0 ? <p>Scheduled deductions remain outstanding until recovery is confirmed.</p> : null}
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
    </details></div>}
  </section>;
}
