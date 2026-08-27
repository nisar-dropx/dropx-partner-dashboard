"use client";

import { useEffect, useMemo, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { PageHead } from "@/components/page-head";
import { StatusPill } from "@/components/status-pill";
import { formatDashboardDate, formatDashboardDateTime } from "@/lib/date-format";

export type PaymentProcessBank = {
  id: string;
  bank_code: string;
  display_name: string;
  account_no: string;
};

export type PaymentProcessRequest = {
  id: string;
  request_no: string;
  location_code: string;
  location_name: string | null;
  amount: number | null;
  amount_requested: number | null;
  payment_mode: string | null;
  payment_portal: string | null;
  payment_reference: string | null;
  bank_account_no: string | null;
  ifsc: string | null;
  account_holder_name: string | null;
  contact_no: string | null;
  email: string | null;
  request_remarks: string | null;
  payment_details: Array<{ id: string; label: string; value: string | null; file_name: string | null }>;
  payment_history: Array<{ id: string; action: string; actor: string; role: string; comments: string | null; created_at: string }>;
  status: string | null;
  approval_status: string | null;
  created_at: string;
  payment_head_name: string | null;
};

function amountValue(request: PaymentProcessRequest) {
  return Number(request.amount ?? request.amount_requested ?? 0);
}

function isAccountTransfer(request: PaymentProcessRequest) {
  return (request.payment_mode ?? "account_transfer") === "account_transfer";
}

function paymentMethodLabel(request: PaymentProcessRequest) {
  if (request.payment_mode === "upi_payment") return "UPI Payment";
  if (request.payment_mode === "online_payment") return "Online Payment";
  return "Bank Transfer";
}

function locationLabel(request: PaymentProcessRequest) {
  return `${request.location_code}${request.location_name ? ` - ${request.location_name}` : ""}`;
}

function UpiPaymentQr({ request }: { request: PaymentProcessRequest }) {
  const [qrDataUrl, setQrDataUrl] = useState("");
  const upiId = request.payment_reference?.trim() ?? "";
  const amount = amountValue(request).toFixed(2);

  useEffect(() => {
    if (!upiId) return;
    const params = new URLSearchParams({ pa: upiId, am: amount, cu: "INR", tn: request.request_no });
    if (request.account_holder_name?.trim()) params.set("pn", request.account_holder_name.trim());
    QRCode.toDataURL(`upi://pay?${params.toString()}`, { errorCorrectionLevel: "M", margin: 2, width: 240 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(""));
  }, [amount, request.account_holder_name, request.request_no, upiId]);

  if (!qrDataUrl) return null;
  return (
    <div style={{ alignItems: "center", background: "#fff", border: "1px solid var(--border)", borderRadius: 14, display: "flex", flexDirection: "column", gap: 8, padding: 14 }}>
      <strong>Scan to pay via UPI</strong>
      <img alt={`UPI QR for ${request.request_no}`} height={220} src={qrDataUrl} width={220} />
      <small className="subtle">{upiId} · Rs {Number(amount).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</small>
    </div>
  );
}

function statusLabel(request: PaymentProcessRequest) {
  const approvalStatus = String(request.approval_status ?? "").toUpperCase();
  const status = String(request.status ?? "").toUpperCase();
  if (approvalStatus === "PROCESSED" || status === "PROCESSED") return "Processed";
  if (approvalStatus === "PROCESSING" || status === "PROCESSING") return "Processing";
  return "Approved";
}

function statusKey(request: PaymentProcessRequest) {
  return statusLabel(request).toLowerCase();
}

function dateOnly(value: string) {
  return new Date(value).toISOString().slice(0, 10);
}

function displayDate(value: string) {
  return formatDashboardDate(value);
}

function fileTypeForBank(bank: PaymentProcessBank | undefined) {
  return bank?.bank_code === "FEDERAL_BANK" ? "fedone" : "";
}

type Props = {
  banks: PaymentProcessBank[];
  requests: PaymentProcessRequest[];
  finalizeAction: (formData: FormData) => Promise<void>;
  finalizeResultKey?: string;
  processAction: (
    previousState: ProcessActionState,
    formData: FormData
  ) => Promise<ProcessActionState>;
  today: string;
};

type ProcessActionState = {
  ok: boolean;
  error: string;
  notice: string;
  requestId: string;
  resultKey: string;
};

const initialProcessActionState: ProcessActionState = {
  ok: false,
  error: "",
  notice: "",
  requestId: "",
  resultKey: ""
};

function FinalizeSubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button className={`button ${pending ? "loading" : ""}`} disabled={pending} type="submit">
      {pending ? <span className="button-spinner" aria-hidden="true" /> : null}
      <span>{pending ? "Finalizing" : "Finalize requests"}</span>
    </button>
  );
}

function ProcessActionButton({
  children,
  className,
  value
}: {
  children: string;
  className: string;
  value: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button className={`button compact ${className} ${pending ? "loading" : ""}`} disabled={pending} name="process_action" type="submit" value={value}>
      {pending ? <span className="button-spinner" aria-hidden="true" /> : null}
      <span>{pending ? "Saving" : children}</span>
    </button>
  );
}

export function PaymentProcessPanel({ banks, requests, finalizeAction, finalizeResultKey, processAction, today }: Props) {
  const router = useRouter();
  const [processResult, processFormAction] = useFormState(processAction, initialProcessActionState);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [processRequest, setProcessRequest] = useState<PaymentProcessRequest | null>(null);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [status, setStatus] = useState("approved");
  const [selectedBankId, setSelectedBankId] = useState("");
  const [fileType, setFileType] = useState("");
  const [hiddenProcessResultKey, setHiddenProcessResultKey] = useState("");
  const [processRemarks, setProcessRemarks] = useState("");
  const [rejectConfirmationOpen, setRejectConfirmationOpen] = useState(false);
  const [rejectValidationError, setRejectValidationError] = useState("");

  useEffect(() => {
    if (finalizeResultKey) setFinalizeOpen(false);
  }, [finalizeResultKey]);

  useEffect(() => {
    if (!processResult.ok || !processResult.resultKey || processResult.resultKey === hiddenProcessResultKey) return;
    setRejectConfirmationOpen(false);
    setProcessRemarks("");
    setProcessRequest(null);
    router.refresh();
  }, [hiddenProcessResultKey, processResult, router]);

  function openProcessRequest(request: PaymentProcessRequest) {
    setHiddenProcessResultKey(processResult.resultKey);
    setProcessRemarks("");
    setRejectValidationError("");
    setRejectConfirmationOpen(false);
    setProcessRequest(request);
  }

  function requestRejectConfirmation() {
    if (!processRemarks.trim()) {
      setRejectValidationError("Enter rejection remarks in the UTR / Error Remarks field before rejecting.");
      return;
    }
    setRejectValidationError("");
    setRejectConfirmationOpen(true);
  }

  const filteredRequests = useMemo(() => {
    return requests.filter((request) => {
      const created = dateOnly(request.created_at);
      if (fromDate && created < fromDate) return false;
      if (toDate && created > toDate) return false;
      const rowStatus = statusLabel(request).toLowerCase();
      if (status !== "all" && rowStatus !== status) return false;
      return true;
    });
  }, [fromDate, requests, status, toDate]);

  const visibleIds = filteredRequests.filter(isAccountTransfer).map((request) => request.id);
  const visibleSelected = visibleIds.filter((id) => selectedIds.includes(id));
  const allVisibleSelected = visibleIds.length > 0 && visibleSelected.length === visibleIds.length;
  const totalAmount = requests.reduce((sum, request) => sum + amountValue(request), 0);
  const requestById = useMemo(() => new Map(requests.map((request) => [request.id, request])), [requests]);
  const selectedBankTransferIds = selectedIds.filter((id) => {
    const request = requestById.get(id);
    return request ? isAccountTransfer(request) : false;
  });

  function toggleAllVisible(checked: boolean) {
    if (!checked) {
      setSelectedIds((current) => current.filter((id) => !visibleIds.includes(id)));
      return;
    }
    setSelectedIds((current) => Array.from(new Set([...current, ...visibleIds])));
  }

  function toggleOne(id: string) {
    setSelectedIds((current) => current.includes(id)
      ? current.filter((item) => item !== id)
      : [...current, id]);
  }

  function selectBank(bankId: string) {
    setSelectedBankId(bankId);
    setFileType(fileTypeForBank(banks.find((bank) => bank.id === bankId)));
  }

  return (
    <>
      <PageHead
        eyebrow="Payments"
        title="Process"
        subtitle="Download bank upload files for final approved payment requests."
        action={(
          <button className="button secondary" onClick={() => setFinalizeOpen(true)} type="button">
            Finalize
          </button>
        )}
      />

      <div className="stat-grid three" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        <div className="stat-card">
          <span>Final approved</span>
          <strong>{requests.length}</strong>
        </div>
        <div className="stat-card">
          <span>Total amount</span>
          <strong>Rs {totalAmount.toLocaleString("en-IN")}</strong>
        </div>
        <div className="stat-card">
          <span>Active banks</span>
          <strong>{banks.length}</strong>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Bank file download</h2>
          </div>
          <div
            style={{
              display: "grid",
              gap: 14,
              gridTemplateColumns: "repeat(3, minmax(180px, 220px))",
              justifyContent: "end",
              marginLeft: "auto",
              width: "min(100%, 720px)"
            }}
          >
            <label>From
              <input className="field" onChange={(event) => setFromDate(event.target.value)} type="date" value={fromDate} />
            </label>
            <label>To
              <input className="field" onChange={(event) => setToDate(event.target.value)} type="date" value={toDate} />
            </label>
            <label>Status
              <select className="field" onChange={(event) => setStatus(event.target.value)} value={status}>
                <option value="approved">Approved</option>
                <option value="processing">Processing</option>
                <option value="processed">Processed</option>
                <option value="all">All approved</option>
              </select>
            </label>
          </div>
        </div>
        <form action="/api/payments/process/download" className="panel-body" method="get">
          <input name="request_ids" type="hidden" value={selectedBankTransferIds.join(",")} />
          <div
            className="form-grid"
            style={{ alignItems: "end", gridTemplateColumns: "minmax(240px, 1.2fr) minmax(190px, 1fr) minmax(170px, 0.8fr) minmax(190px, auto)" }}
          >
            <label>Bank
              <select className="field" name="bank_id" onChange={(event) => selectBank(event.target.value)} required value={selectedBankId}>
                <option value="">Select bank</option>
                {banks.map((bank) => (
                  <option key={bank.id} value={bank.id}>{bank.display_name} | {bank.account_no}</option>
                ))}
              </select>
            </label>
            <label>File type
              <select className="field" disabled={!selectedBankId || !fileType} name="file_type" onChange={(event) => setFileType(event.target.value)} required value={fileType}>
                <option value="">{selectedBankId ? "No file type configured" : "Select file type"}</option>
                <option value="fedone">Federal Bank - FedOne</option>
              </select>
            </label>
            <label>Value date
              <input className="field" name="value_date" type="date" defaultValue={today} required />
            </label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, justifySelf: "end" }}>
              <button className="button" disabled={!selectedBankId || !fileType || !selectedBankTransferIds.length} type="submit">
                Download bank file
              </button>
            </div>
          </div>
        </form>
        <div className="panel-head" style={{ borderTop: "1px solid var(--border)", marginTop: 0 }}>
          <div>
            <h2>Ready for processing</h2>
            <p className="subtle">{filteredRequests.length} of {requests.length} requests shown.</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>
                  <input
                    aria-label="Select all visible payment requests"
                    checked={allVisibleSelected}
                    onChange={(event) => toggleAllVisible(event.target.checked)}
                    type="checkbox"
                  />
                </th>
                <th>Request</th>
                <th>Location</th>
                <th>Payment Head</th>
                <th>Payment Method</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Created</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredRequests.length ? filteredRequests.map((request) => (
                <tr key={request.id}>
                  <td>
                    <input
                      aria-label={`Select payment request ${request.request_no}`}
                      checked={selectedIds.includes(request.id)}
                      disabled={!isAccountTransfer(request)}
                      onChange={() => toggleOne(request.id)}
                      title={isAccountTransfer(request) ? "Select payment request" : "Only account transfers are included in bank files"}
                      type="checkbox"
                    />
                  </td>
                  <td><strong>{request.request_no}</strong></td>
                  <td>{request.location_code}</td>
                  <td>{request.payment_head_name ?? "-"}</td>
                  <td>{paymentMethodLabel(request)}</td>
                  <td>Rs {amountValue(request).toLocaleString("en-IN")}</td>
                  <td><StatusPill status={statusLabel(request)} /></td>
                  <td>{displayDate(request.created_at)}</td>
                  <td>
                    <button className="button secondary compact" onClick={() => openProcessRequest(request)} type="button">
                      Action
                    </button>
                  </td>
                </tr>
              )) : (
                <tr><td className="empty-cell" colSpan={9}>No final approved payment requests ready for processing.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {finalizeOpen ? (
        <div className="modal-backdrop">
          <section aria-label="Finalize payment requests" className="modal-panel">
            <div className="panel-head">
              <div>
                <h2>Finalize</h2>
                <p className="subtle">Upload the bank transaction enquiry file to mark paid or cancelled requests.</p>
              </div>
              <button className="modal-close" onClick={() => setFinalizeOpen(false)} type="button">x</button>
            </div>
            <form action={finalizeAction} className="panel-body" encType="multipart/form-data">
              <label>Bank response file
                <input
                  accept=".xlsx,.xls"
                  className="field"
                  name="bank_response_file"
                  required
                  type="file"
                />
            </label>
            <div className="form-actions modal-actions">
              <button className="button secondary" onClick={() => setFinalizeOpen(false)} type="button">Cancel</button>
              <FinalizeSubmitButton />
            </div>
          </form>
          </section>
        </div>
      ) : null}

      {processRequest ? (
        <div className="modal-backdrop">
          <section aria-label="Update payment processing status" className="modal-panel">
            <div className="panel-head">
              <div>
                <h2>Process payment</h2>
                <div className="payment-modal-reference">
                  <span>{processRequest.request_no}</span>
                  <strong className="payment-location-highlight">{locationLabel(processRequest)}</strong>
                </div>
              </div>
              <button className="modal-close" onClick={() => setProcessRequest(null)} type="button">x</button>
            </div>
            <form action={processFormAction} className="panel-body" id="payment-process-action-form">
              <input name="request_id" type="hidden" value={processRequest.id} />
              {rejectConfirmationOpen ? <input name="process_action" type="hidden" value="rejected" /> : null}
              {statusKey(processRequest) === "processed" ? (
                <div className="modal-inline-message warn">
                  <strong>Return processed payment</strong>
                  <span>Use this only when the payment is completed but the requester must submit the original invoice or corrected documents.</span>
                </div>
              ) : null}
              <div className="form-grid two">
                <label>Payment Head
                  <input className="field" readOnly value={processRequest.payment_head_name ?? "-"} />
                </label>
                <label>Amount
                  <input className="field" readOnly value={`Rs ${amountValue(processRequest).toLocaleString("en-IN")}`} />
                </label>
                <label>Payment Method
                  <input className="field" readOnly value={paymentMethodLabel(processRequest)} />
                </label>
                <label>Status
                  <input className="field" readOnly value={statusLabel(processRequest)} />
                </label>
              </div>
              <div style={{ marginTop: 16 }}>
                <div className={processRequest.payment_mode === "upi_payment" ? "form-grid two" : undefined} style={{ alignItems: "stretch" }}>
                  <div className="form-grid two" style={{ alignContent: "start" }}>
                    {isAccountTransfer(processRequest) ? (
                      <>
                        <label>Bank Account No<input className="field" readOnly value={processRequest.bank_account_no ?? "-"} /></label>
                        <label>IFSC<input className="field" readOnly value={processRequest.ifsc ?? "-"} /></label>
                        <label>Account Holder Name<input className="field" readOnly value={processRequest.account_holder_name ?? "-"} /></label>
                      </>
                    ) : null}
                    {processRequest.payment_mode === "upi_payment" ? (
                      <>
                        <label>UPI ID<input className="field" readOnly value={processRequest.payment_reference ?? "-"} /></label>
                        <label>Account Holder Name<input className="field" readOnly value={processRequest.account_holder_name ?? "-"} /></label>
                      </>
                    ) : null}
                    {processRequest.payment_mode === "online_payment" ? (
                      <>
                        <label>Payment Portal<input className="field" readOnly value={processRequest.payment_portal ?? "-"} /></label>
                        <label>Payment Reference<input className="field" readOnly value={processRequest.payment_reference ?? "-"} /></label>
                        <label>Account Holder Name<input className="field" readOnly value={processRequest.account_holder_name ?? "-"} /></label>
                      </>
                    ) : null}
                    <label>Contact No<input className="field" readOnly value={processRequest.contact_no ?? "-"} /></label>
                    <label>Email<input className="field" readOnly value={processRequest.email ?? "-"} /></label>
                    <label style={{ gridColumn: "1 / -1" }}>Request Remarks<textarea className="field" readOnly value={processRequest.request_remarks ?? "-"} /></label>
                  </div>
                  {processRequest.payment_mode === "upi_payment" ? <UpiPaymentQr request={processRequest} /> : null}
                </div>
                {processRequest.payment_details.length ? (
                  <div className="table-wrap" style={{ marginTop: 16 }}>
                    <table>
                      <tbody>
                        {processRequest.payment_details.map((detail) => (
                          <tr key={detail.id}>
                            <th>{detail.label}</th>
                            <td>{detail.file_name ? <a href={`/api/payments/requests/attachment?answer_id=${encodeURIComponent(detail.id)}`} rel="noreferrer" target="_blank">{detail.file_name}</a> : detail.value || "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
                {processRequest.payment_history.length ? (
                  <>
                    <div className="section-divider" />
                    <h3>Request history</h3>
                    <div className="table-wrap">
                      <table>
                        <thead><tr><th>Action</th><th>Action by</th><th>Role</th><th>Remarks</th><th>Date</th></tr></thead>
                        <tbody>
                          {processRequest.payment_history.map((entry) => (
                            <tr key={entry.id}>
                              <td><StatusPill status={entry.action} /></td>
                              <td>{entry.actor}</td>
                              <td>{entry.role}</td>
                              <td>{entry.comments || "-"}</td>
                              <td>{formatDashboardDateTime(entry.created_at)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : null}
              </div>
              <div className="section-divider" />
              <label className="payment-process-remarks-row">
                <span>UTR / Error Remarks</span>
                <input
                  className="field"
                  name="process_remarks"
                  onChange={(event) => {
                    setProcessRemarks(event.target.value);
                    if (event.target.value.trim()) setRejectValidationError("");
                  }}
                  placeholder={statusKey(processRequest) === "processed" ? "Reason for return" : "Enter UTR No or error remarks"}
                  value={processRemarks}
                />
              </label>
              {rejectValidationError ? (
                <div className="modal-inline-message error" role="alert" style={{ marginTop: 10 }}>
                  <strong>Rejection remarks required</strong>
                  <span>{rejectValidationError}</span>
                </div>
              ) : null}
              {processResult.requestId === processRequest.id &&
              processResult.resultKey !== hiddenProcessResultKey &&
              processResult.error ? (
                <div className="modal-inline-message error" role="alert" style={{ marginTop: 10 }}>
                  <strong>Payment process not finalized</strong>
                  <span>{processResult.error}</span>
                </div>
              ) : null}
              <div className="form-actions modal-actions">
                <button className="button secondary" onClick={() => setProcessRequest(null)} type="button">Cancel</button>
                {statusKey(processRequest) !== "processing" && statusKey(processRequest) !== "processed" ? (
                  <ProcessActionButton className="secondary" value="processing">Processing</ProcessActionButton>
                ) : null}
                {statusKey(processRequest) !== "processed" ? (
                  <ProcessActionButton className="payment-approve-button" value="processed">Processed</ProcessActionButton>
                ) : null}
                <ProcessActionButton className="payment-return-button" value="returned">
                  {statusKey(processRequest) === "processed" ? "Return processed" : "Return"}
                </ProcessActionButton>
                {statusKey(processRequest) !== "processed" ? (
                  <button
                    className="button compact payment-reject-button"
                    onClick={requestRejectConfirmation}
                    type="button"
                  >
                    Reject
                  </button>
                ) : null}
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {processRequest && rejectConfirmationOpen ? (
        <div
          className="modal-backdrop confirmation-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setRejectConfirmationOpen(false);
          }}
        >
          <section aria-modal="true" className="modal-panel confirmation-dialog" role="alertdialog">
            <div className="panel-head">
              <div>
                <h2>Reject payment request?</h2>
                <p className="subtle">This is a final rejection by the payment processor.</p>
              </div>
            </div>
            <div className="confirmation-body">
              <p>
                Reject <strong>{processRequest.request_no}</strong>? The rejection and remarks will be recorded in request history.
              </p>
              <div className="modal-inline-message warn">
                <strong>Rejection remarks</strong>
                <span>{processRemarks}</span>
              </div>
            </div>
            <div className="form-actions modal-actions confirmation-actions">
              <button className="button secondary" onClick={() => setRejectConfirmationOpen(false)} type="button">
                Cancel
              </button>
              <button
                className="button payment-reject-button"
                form="payment-process-action-form"
                type="submit"
              >
                Confirm reject
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
