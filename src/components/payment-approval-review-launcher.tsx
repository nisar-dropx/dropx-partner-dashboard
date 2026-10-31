"use client";

import { ExternalLink, Eye, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";

import { PaymentApprovalAdhocHistory } from "@/components/payment-approval-adhoc-history";
import { PaymentApprovalShipments } from "@/components/payment-approval-shipments";
import { PaymentCostSummary } from "@/components/payment-cost-summary";
import { PaymentVolumeContext } from "@/components/payment-volume-context";

export type PaymentApprovalReviewSummary = {
  accountHolderName: string | null;
  amountActual: number | null;
  amountEstimated: boolean;
  amountRequested: number | null;
  amountText: string;
  approvalRoutingReason: string | null;
  bankAccountNo: string | null;
  contactNo: string | null;
  currentOwner: string;
  currentRole: string;
  currentStep: number | null;
  email: string | null;
  id: string;
  ifsc: string | null;
  locationCode: string;
  locationId: string | null;
  paymentHeadCode: string | null;
  paymentHeadName: string;
  paymentMode: string | null;
  paymentPortal: string | null;
  paymentReference: string | null;
  remarks: string | null;
  requestNo: string;
  statusLabel: string;
  statusTone: string | null;
  totalSteps: number | null;
};

type ReviewAttachment = { name: string; size: number; url: string };
type ReviewAnswer = {
  answerType: string | null;
  answerValue: string | null;
  attachments: ReviewAttachment[];
  id: string;
  questionText: string;
};
type ReviewLog = {
  action: string;
  actor: string;
  comments: string | null;
  createdAt: string;
  id: string;
  role: string;
};
type ReviewDetail = {
  fuelHistory?: { rows: { provider: string; reference: string; amount: number; litres: number }[]; latestDate: string | null; error?: string } | null;
  fuel?: { vehicle_no: string; fuel_date: string; litres: number | null } | null;
  answers: ReviewAnswer[];
  attachmentCount: number;
  locationLabel: string;
  logs: ReviewLog[];
  replacement: { date: string; model: string; number: string; partner: string | null; reason: string; source: string; status: string } | null;
  shipmentCount: number | null;
  trackingCount: number;
  volumeDate: string | null;
};

function displayDateTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    hour: "2-digit",
    hour12: true,
    minute: "2-digit",
    month: "short",
    timeZone: "Asia/Kolkata",
    year: "numeric"
  });
}

function paymentMethodLabel(value: string | null) {
  if (value === "upi_payment") return "UPI Payment";
  if (value === "online_payment") return "Online Payment";
  return "Bank Transfer";
}

function hasValue(value: string | null) {
  return Boolean(value && value.trim() && value.trim() !== "-");
}

function attachmentPreviewKind(name: string) {
  const extension = name.toLowerCase().split(".").pop();
  if (extension && ["avif", "bmp", "gif", "jfif", "jpeg", "jpg", "png", "svg", "webp"].includes(extension)) return "image";
  if (extension === "pdf") return "document";
  return "unsupported";
}

export function PaymentApprovalReviewLauncher({
  canAct,
  initiallyOpen = false,
  showTrigger = true,
  summary
}: {
  canAct: boolean;
  initiallyOpen?: boolean;
  showTrigger?: boolean;
  summary: PaymentApprovalReviewSummary;
}) {
  const router = useRouter();
  const reviewRef = useRef<HTMLElement>(null);
  const attachmentRef = useRef<HTMLElement>(null);
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(initiallyOpen);
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailAttempt, setDetailAttempt] = useState(0);
  const [attachment, setAttachment] = useState<ReviewAttachment | null>(null);
  const [comments, setComments] = useState("");
  const [decisionError, setDecisionError] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!open || !mounted) return;
    const panel = attachment ? attachmentRef.current : reviewRef.current;
    if (!panel) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const shell = document.querySelector('.shell');
    const wasInert = shell?.hasAttribute('inert');
    shell?.setAttribute('inert', '');
    document.body.style.overflow = 'hidden';
    const targets = () => Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')).filter(element => element.getClientRects().length > 0);
    targets()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (attachment) setAttachment(null);
        else close();
      }
      if (event.key !== 'Tab') return;
      const elements = targets(), first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (!wasInert) shell?.removeAttribute('inert');
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [attachment, mounted, open]);

  useEffect(() => {
    if (!open || detail) return;
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError("");
    void fetch(`/api/payments/approvals/${encodeURIComponent(summary.id)}`, {
      cache: "no-store",
      signal: controller.signal
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "Additional request details are unavailable.");
        setDetailLoading(false);
        setDetail(payload as ReviewDetail);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setDetailError(error instanceof Error ? error.message : "Additional request details are unavailable.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [detail, detailAttempt, open, summary.id]);

  const displayedStep = Number(summary.currentStep) || 0;
  const displayedTotal = Math.max(Number(summary.totalSteps) || 0, displayedStep);
  const finalStep = displayedStep > 0 && displayedTotal > 0 && displayedStep >= displayedTotal;
  const details = useMemo(() => [
    ["Payment method", paymentMethodLabel(summary.paymentMode)],
    ...(hasValue(summary.accountHolderName) ? [["Account holder", summary.accountHolderName as string]] : []),
    ...(summary.paymentMode === "upi_payment" && hasValue(summary.paymentReference) ? [["UPI ID", summary.paymentReference as string]] : []),
    ...(summary.paymentMode === "online_payment" && hasValue(summary.paymentPortal) ? [["Payment portal", summary.paymentPortal as string]] : []),
    ...(summary.paymentMode === "online_payment" && hasValue(summary.paymentReference) ? [["Reference ID", summary.paymentReference as string]] : []),
    ...((summary.paymentMode ?? "account_transfer") === "account_transfer" && hasValue(summary.bankAccountNo) ? [["Bank account", summary.bankAccountNo as string]] : []),
    ...((summary.paymentMode ?? "account_transfer") === "account_transfer" && hasValue(summary.ifsc) ? [["IFSC", summary.ifsc as string]] : []),
    ...(hasValue(summary.contactNo) ? [["Contact", summary.contactNo as string]] : []),
    ...(hasValue(summary.email) ? [["Email", summary.email as string]] : [])
  ], [summary]);

  function close() {
    setAttachment(null);
    setOpen(false);
    if (!initiallyOpen) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("manage");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }

  async function decide(action: "approve" | "return" | "reject") {
    const note = comments.trim();
    if ((action === "return" || action === "reject") && !note) {
      setDecisionError(`${action === "return" ? "Return" : "Reject"} remarks are required.`);
      return;
    }
    const confirmation = action === "approve"
      ? `Approve ${summary.requestNo}? This moves the request to the next configured step.`
      : action === "reject"
        ? `Reject ${summary.requestNo}? The requester will be notified of this final decision.`
        : null;
    if (confirmation && !window.confirm(confirmation)) return;

    setDecisionError("");
    setSubmitted(true);
    setOpen(false);
    try {
      const response = await fetch(`/api/payments/approvals/${encodeURIComponent(summary.id)}`, {
        body: JSON.stringify({ action, comments: note }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH"
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "The payment decision could not be saved.");
      router.refresh();
    } catch (error) {
      setSubmitted(false);
      setDecisionError(error instanceof Error ? error.message : "The payment decision could not be saved.");
      setOpen(true);
    }
  }

  const modal = open ? (
    <div className="modal-backdrop payment-review-client-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) close(); }}>
      <section ref={reviewRef} aria-label="Review payment approval" aria-modal="true" className="modal-panel wide payment-review-client-modal" role="dialog">
        <div className="panel-head payment-review-sticky-head">
          <div>
            <h2>Review payment request</h2>
            <div className="payment-modal-reference"><span>{summary.requestNo}</span><strong className="payment-location-highlight">{detail?.locationLabel || summary.locationCode}</strong></div>
          </div>
          <button aria-label="Close review" className="icon-button" onClick={close} type="button"><X size={18} /></button>
        </div>
        <div className="panel-body">
          <div className="payment-review-summary-cards">
            <article><small>Payment head</small><strong>{summary.paymentHeadName}</strong></article>
            <article><small>{summary.amountEstimated ? "Estimated amount" : "Amount"}</small><strong>{summary.amountText}</strong></article>
            <article><small>Approval status</small><span className={`status-pill ${summary.statusTone || ""}`}>{summary.statusLabel}</span></article>
            <article><small>Current stage</small><strong>{summary.currentOwner || "Unassigned"}</strong><span>{summary.currentRole}{displayedTotal ? ` · ${displayedStep || 1} of ${displayedTotal}` : ""}</span></article>
          </div>

          <PaymentCostSummary actual={summary.amountActual} estimate={summary.amountRequested} shipments={detail?.shipmentCount ?? null} />

          {summary.approvalRoutingReason ? <details className="payment-review-additional-details payment-review-routing-note"><summary>Approval routing</summary><p>{summary.approvalRoutingReason}</p></details> : null}

          {canAct ? <section className="payment-approval-action-form payment-review-fast-actions">
            <div className="payment-approval-decision-intro"><div><strong>Decision required</strong><span>{displayedStep && displayedTotal ? `${finalStep ? "Final approval" : "Approval"} step ${displayedStep} of ${displayedTotal}` : "Additional evidence loads below without blocking your action."}</span></div><span className="status-pill warn">Awaiting your action</span></div>
            {summary.remarks?.trim() ? <p className="payment-requestor-remarks"><strong>Requester note:</strong> {summary.remarks}</p> : null}
            <label>Decision note<textarea className="field" onChange={(event) => setComments(event.target.value)} rows={2} value={comments} /><small>Optional when approving. Required when returning or rejecting.</small></label>
            {decisionError ? <p className="message-panel error" role="alert">{decisionError}</p> : null}
            <div className="payment-approval-action-buttons">
              <button className="button payment-approve-button" onClick={() => void decide("approve")} type="button">{finalStep ? "Approve final" : "Approve & continue"}</button>
              <button className="button payment-return-button" onClick={() => void decide("return")} type="button">Return for correction</button>
              <button className="button payment-reject-button" onClick={() => void decide("reject")} type="button">Reject request</button>
            </div>
          </section> : null}

          <details className="payment-review-additional-details">
            <summary><span>Payment and beneficiary details</span><small>Open only when needed</small></summary>
            <dl className="payment-review-fact-grid">{details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
          </details>

          <div className="section-divider" />
          <div className="payment-review-section-head"><div><h3>Request evidence</h3><p>Supporting details and attachments.</p></div><span>{detail ? `${detail.attachmentCount} attachments` : "Loading"}</span></div>
          {detailLoading ? <div className="payment-review-optional-loading" role="status"><span className="inline-spinner" aria-hidden="true" /><div><strong>Loading additional evidence</strong><small>You can approve, return, reject, or open another request now.</small></div></div> : null}
          {detailError ? <div className="message-panel error" role="alert"><strong>Additional evidence unavailable</strong><p>{detailError}</p><button className="button secondary compact" onClick={() => { setDetailError(""); setDetailAttempt((value) => value + 1); }} type="button">Retry details</button></div> : null}
          {detail?.replacement ? <div className="message-panel"><strong>{detail.replacement.reason}</strong><p>{detail.replacement.number} · {detail.replacement.model} · Replacement date: {detail.replacement.date}</p></div> : null}
          {detail?.answers.length ? <div className="table-wrap payment-review-answers"><table><tbody>{detail.answers.map((answer) => <tr key={answer.id}><th>{answer.questionText}</th><td>{answer.attachments.length ? <span className="payment-attachment-list">{answer.attachments.map((file) => <span className="payment-attachment-cell" key={file.url}><span>{file.name}</span><button aria-label={`View ${file.name}`} className="icon-button payment-attachment-view" onClick={() => setAttachment(file)} title="View attachment" type="button"><Eye size={16} /></button></span>)}</span> : <span className="payment-review-answer-value">{answer.answerValue || "-"}</span>}</td></tr>)}</tbody></table></div> : detail && !detail.answers.length ? <p className="subtle">No additional fields were supplied.</p> : null}

          {detail?.volumeDate && summary.locationId ? <PaymentVolumeContext date={detail.volumeDate} locationId={summary.locationId} /> : null}
          {detail?.fuel ? <div className="van-fuel-review"><strong>{detail.fuel.vehicle_no}</strong><span>Fuel date · {detail.fuel.fuel_date}</span><span>{detail.fuel.litres != null ? `${detail.fuel.litres} L` : "Litres pending bill"}</span></div> : null}
          {detail?.fuelHistory ? <details className="van-fuel-pending" open={detail.fuelHistory.rows.length > 0}><summary>{detail.fuelHistory.rows.length ? `${detail.fuelHistory.rows.length} existing fuel transaction(s) · same vehicle / day` : "Same-day provider fuel check"}</summary>
            {detail.fuelHistory.rows.map(row => <p key={`${row.provider}:${row.reference}`}><strong>{row.provider} · ₹{row.amount.toLocaleString("en-IN")}</strong> · {row.litres} L · {row.reference}</p>)}
            <small>{detail.fuelHistory.error || `Latest CPS import date: ${detail.fuelHistory.latestDate ?? "unavailable"}. Provider feeds may be incomplete; verify the bill before approval.`}</small>
          </details> : null}
          {summary.paymentHeadCode === "VAN_ADHOC" ? <PaymentApprovalAdhocHistory requestId={summary.id} /> : null}
          {detail?.trackingCount ? <PaymentApprovalShipments count={detail.trackingCount} requestId={summary.id} /> : null}

          {detail?.logs.length ? <details className="payment-review-additional-details"><summary><span>Request history</span><small>{detail.logs.length} events</small></summary><div className="table-wrap"><table><thead><tr><th>Action</th><th>Action by</th><th>Role</th><th>Remarks</th><th>Date · IST</th></tr></thead><tbody>{detail.logs.map((entry) => <tr key={entry.id}><td>{entry.action}</td><td>{entry.actor}</td><td>{entry.role}</td><td>{entry.comments || "-"}</td><td>{displayDateTime(entry.createdAt)}</td></tr>)}</tbody></table></div></details> : null}
        </div>
      </section>

      {attachment ? <div className="modal-backdrop payment-attachment-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setAttachment(null); }}>
        <section ref={attachmentRef} aria-label={`Attachment ${attachment.name}`} aria-modal="true" className="modal-panel payment-attachment-preview-modal" role="dialog">
          <div className="panel-head"><div><small>Request attachment</small><h2>{attachment.name}</h2></div><button aria-label="Close attachment" className="icon-button" onClick={() => setAttachment(null)} type="button"><X size={18} /></button></div>
          {attachmentPreviewKind(attachment.name) === "image" ? <div className="payment-attachment-preview-canvas"><img alt={attachment.name} className="payment-attachment-preview-image" src={attachment.url} /></div> : null}
          {attachmentPreviewKind(attachment.name) === "document" ? <iframe className="payment-attachment-preview-frame" src={attachment.url} title={attachment.name} /> : null}
          {attachmentPreviewKind(attachment.name) === "unsupported" ? <div className="payment-attachment-preview-unavailable"><strong>Preview is not available for this file type.</strong><span>Use Open full size to view or download the attachment.</span></div> : null}
          <div className="payment-attachment-preview-actions"><a className="button secondary" href={attachment.url} rel="noreferrer" target="_blank"><ExternalLink size={16} />Open full size</a></div>
        </section>
      </div> : null}
    </div>
  ) : null;

  return <>
    {showTrigger ? submitted ? <span className="status-pill good payment-review-submitted"><span className="inline-spinner" aria-hidden="true" />Saving decision…</span> : <button className={`button compact ${canAct ? "payment-action-next" : "secondary"}`} onClick={() => { setDecisionError(""); setOpen(true); }} type="button">{canAct ? "Review" : "View"}</button> : null}
    {!open && decisionError ? <small className="payment-review-inline-error" role="alert">{decisionError}</small> : null}
    {mounted && modal ? createPortal(modal, document.body) : null}
  </>;
}
