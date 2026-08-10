"use client";

import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { PageHead } from "@/components/page-head";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";
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
  processAction: (formData: FormData) => Promise<void>;
  today: string;
};

function FinalizeSubmitButton() {
  return (
    <SubmitButton
      confirmDescription="The selected requests will be finalized for bank processing."
      confirmMessage="Are you sure you want to finalize the selected payment requests?"
      confirmSubmitText="Finalize requests"
      confirmTitle="Finalize payment requests?"
      pendingText="Finalizing"
    >Finalize requests</SubmitButton>
  );
}

function ProcessActionButton({
  children,
  className,
  onBeforeConfirm,
  value
}: {
  children: string;
  className: string;
  onBeforeConfirm?: () => boolean;
  value: string;
}) {
  const actionLabel = children.toLowerCase();
  return (
    <SubmitButton
      className={`button compact ${className}`}
      confirmDescription="This action updates the payment request immediately."
      confirmMessage={`Are you sure you want to mark this payment as ${actionLabel}?`}
      confirmSubmitText={children}
      confirmTitle={`${children} payment?`}
      name="process_action"
      onBeforeConfirm={onBeforeConfirm}
      pendingText="Saving"
      value={value}
    >{children}</SubmitButton>
  );
}

export function PaymentProcessPanel({ banks, requests, finalizeAction, finalizeResultKey, processAction, today }: Props) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [processRequest, setProcessRequest] = useState<PaymentProcessRequest | null>(null);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [status, setStatus] = useState("approved");
  const [selectedBankId, setSelectedBankId] = useState("");
  const [fileType, setFileType] = useState("");
  const [processRemarks, setProcessRemarks] = useState("");
  const [processRemarksError, setProcessRemarksError] = useState("");

  useEffect(() => {
    if (finalizeResultKey) setFinalizeOpen(false);
  }, [finalizeResultKey]);

  useEffect(() => {
    setProcessRemarks("");
    setProcessRemarksError("");
  }, [processRequest?.id]);

  function validateProcessAction(action: "processed" | "returned") {
    if (processRemarks.trim()) {
      setProcessRemarksError("");
      return true;
    }
    setProcessRemarksError(action === "processed"
      ? "Enter the UTR number before marking this request as processed."
      : "Enter the reason before returning this request.");
    return false;
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
                    <button className="button secondary compact" onClick={() => setProcessRequest(request)} type="button">
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
                <p className="subtle">{processRequest.request_no} - {processRequest.location_code}</p>
              </div>
              <button className="modal-close" onClick={() => setProcessRequest(null)} type="button">x</button>
            </div>
            <form action={processAction} className="panel-body">
              <input name="request_id" type="hidden" value={processRequest.id} />
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
                <label>{statusKey(processRequest) === "processed" ? "Return remarks" : "UTR No / Return remarks"}
                  <input
                    className="field"
                    name="process_remarks"
                    onChange={(event) => {
                      setProcessRemarks(event.target.value);
                      if (processRemarksError) setProcessRemarksError("");
                    }}
                    placeholder={statusKey(processRequest) === "processed" ? "Reason for return" : "UTR No / error remarks"}
                    value={processRemarks}
                  />
                  {processRemarksError ? <span className="field-error" role="alert">{processRemarksError}</span> : null}
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
              <div className="form-actions modal-actions">
                <button className="button secondary" onClick={() => setProcessRequest(null)} type="button">Cancel</button>
                {statusKey(processRequest) !== "processing" && statusKey(processRequest) !== "processed" ? (
                  <ProcessActionButton className="secondary" value="processing">Processing</ProcessActionButton>
                ) : null}
                {statusKey(processRequest) !== "processed" ? (
                  <ProcessActionButton className="payment-approve-button" onBeforeConfirm={() => validateProcessAction("processed")} value="processed">Processed</ProcessActionButton>
                ) : null}
                <ProcessActionButton className="payment-return-button" onBeforeConfirm={() => validateProcessAction("returned")} value="returned">
                  {statusKey(processRequest) === "processed" ? "Return processed" : "Return"}
                </ProcessActionButton>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </>
  );
}
