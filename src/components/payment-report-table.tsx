"use client";

import { useEffect, useMemo, useState } from "react";
import { Eye } from "lucide-react";
import { StatusPill } from "@/components/status-pill";
import { formatDashboardDate, formatDashboardDateTime } from "@/lib/date-format";
import { paymentStatusLabel } from "@/lib/payment-status-label";

export type PaymentReportAnswer = {
  id: string;
  payment_request_id: string;
  answer_value: string | null;
  file_name: string | null;
  question_text: string | null;
  answer_type: string | null;
};

export type PaymentReportLog = {
  id: string;
  payment_request_id: string;
  action: string;
  comments: string | null;
  created_at: string;
  approver_name: string | null;
  approver_email: string | null;
  role_name: string | null;
  role_code: string | null;
};

export type PaymentReportRequest = {
  id: string;
  request_no: string;
  location_code: string;
  payment_head_name: string;
  payment_head_external_id: string;
  amount: number | null;
  payment_mode: string | null;
  account_holder_name: string | null;
  bank_account_no: string | null;
  ifsc: string | null;
  contact_no: string | null;
  email: string | null;
  remarks: string | null;
  supporting_document_path: string | null;
  status: string;
  approval_status: string | null;
  current_approver_user_id: string | null;
  current_approver_role_id: string | null;
  current_approver_role_ids: string[] | null;
  utr_cin: string | null;
  bank_status: string | null;
  bank_processing_remarks: string | null;
  processing_started_at: string | null;
  processed_at: string | null;
  requested_by_name: string | null;
  requested_by_email: string | null;
  created_at: string;
  updated_at: string;
  answers: PaymentReportAnswer[];
  logs: PaymentReportLog[];
};

function formatAmount(amount: number | null) {
  return amount == null ? "-" : `Rs ${Number(amount).toLocaleString("en-IN")}`;
}

function formatDate(value: string) {
  return formatDashboardDate(value);
}

function formatDateTime(value: string) {
  return formatDashboardDateTime(value);
}

function isProcessingStarted(request: PaymentReportRequest) {
  const status = String(request.status ?? "").toUpperCase();
  const approvalStatus = String(request.approval_status ?? "").toUpperCase();
  return status === "PROCESSING" ||
    status === "PROCESSED" ||
    approvalStatus === "PROCESSING" ||
    approvalStatus === "PROCESSED";
}

function reportStatusLabel(request: PaymentReportRequest) {
  return paymentStatusLabel(request);
}

function buildHistory(request: PaymentReportRequest) {
  const history = [
    {
      id: `${request.id}-requested`,
      status: "requested",
      actor: request.requested_by_name ?? request.requested_by_email ?? "-",
      role: "Requester",
      comments: request.remarks || "-",
      created_at: request.created_at
    },
    ...request.logs.map((log) => ({
      id: log.id,
      status: log.action,
      actor: log.approver_name ?? log.approver_email ?? "-",
      role: log.role_name ?? log.role_code ?? "-",
      comments: log.comments || "-",
      created_at: log.created_at
    }))
  ];

  if (isProcessingStarted(request)) {
    history.push({
      id: `${request.id}-processing`,
      status: "processing",
      actor: "Payment process",
      role: "System",
      comments: "Payment processing started",
      created_at: request.processing_started_at ?? request.updated_at
    });
  }

  if (request.processed_at) {
    history.push({
      id: `${request.id}-processed`,
      status: request.bank_status || "processed",
      actor: "Bank response",
      role: "Payment process",
      comments: request.bank_processing_remarks || request.utr_cin || "-",
      created_at: request.processed_at
    });
  }

  return history.sort((left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime());
}

function MultiCheckFilter({
  allLabel,
  label,
  options,
  selected,
  setSelected,
  displayValue = (value) => value
}: {
  allLabel: string;
  label: string;
  options: string[];
  selected: string[];
  setSelected: (values: string[]) => void;
  displayValue?: (value: string) => string;
}) {
  const summary = selected.length === 0
    ? allLabel
    : selected.length <= 2
      ? selected.map(displayValue).join(", ")
      : `${selected.length} selected`;

  function toggle(value: string) {
    setSelected(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  }

  return (
    <div className="payment-report-multi-filter">
      <span>{label}</span>
      <details className="multi-select">
        <summary className="multi-select-trigger"><span className="multi-select-summary">{summary}</span><span aria-hidden="true">⌄</span></summary>
        <div className="multi-select-menu payment-report-filter-menu">
          <label className="multi-select-all">
            <input checked={selected.length === 0} onChange={() => setSelected([])} type="checkbox" />
            <span>{allLabel}</span>
          </label>
          <div className="multi-select-options">
            {options.map((option) => (
              <label className="multi-select-option" key={option}>
                <input checked={selected.includes(option)} onChange={() => toggle(option)} type="checkbox" />
                <span>{displayValue(option)}</span>
              </label>
            ))}
          </div>
        </div>
      </details>
    </div>
  );
}

export function PaymentReportTable({ requests }: { requests: PaymentReportRequest[] }) {
  const [selectedRequest, setSelectedRequest] = useState<PaymentReportRequest | null>(null);
  const [search, setSearch] = useState("");
  const [locationsSelected, setLocationsSelected] = useState<string[]>([]);
  const [headsSelected, setHeadsSelected] = useState<string[]>([]);
  const [statusesSelected, setStatusesSelected] = useState<string[]>([]);
  const [paymentModesSelected, setPaymentModesSelected] = useState<string[]>([]);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [pageSize, setPageSize] = useState("20");
  const [page, setPage] = useState(1);
  const history = selectedRequest ? buildHistory(selectedRequest) : [];
  const locations = useMemo(() => [...new Set(requests.map((item) => item.location_code).filter(Boolean))].sort(), [requests]);
  const heads = useMemo(() => [...new Set(requests.map((item) => item.payment_head_name).filter(Boolean))].sort(), [requests]);
  const statuses = useMemo(() => [...new Set(requests.map(reportStatusLabel).filter(Boolean))].sort(), [requests]);
  const paymentModes = useMemo(() => [...new Set(requests.map((item) => item.payment_mode).filter(Boolean) as string[])].sort(), [requests]);
  const filteredRequests = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return requests.filter((request) => {
      const createdDate = request.created_at.slice(0, 10);
      const searchable = [request.request_no, request.location_code, request.payment_head_name, request.payment_head_external_id,
        request.account_holder_name, request.bank_account_no, request.ifsc, request.contact_no, request.email, request.utr_cin,
        request.requested_by_name, request.requested_by_email].filter(Boolean).join(" ").toLowerCase();
      return (!needle || searchable.includes(needle)) &&
        (!locationsSelected.length || locationsSelected.includes(request.location_code)) &&
        (!headsSelected.length || headsSelected.includes(request.payment_head_name)) &&
        (!statusesSelected.length || statusesSelected.includes(reportStatusLabel(request))) &&
        (!paymentModesSelected.length || (request.payment_mode != null && paymentModesSelected.includes(request.payment_mode))) &&
        (!fromDate || createdDate >= fromDate) &&
        (!toDate || createdDate <= toDate);
    });
  }, [requests, search, locationsSelected, headsSelected, statusesSelected, paymentModesSelected, fromDate, toDate]);
  const effectivePageSize = pageSize === "all" ? Math.max(filteredRequests.length, 1) : Number(pageSize);
  const totalPages = Math.max(1, Math.ceil(filteredRequests.length / effectivePageSize));
  const visibleRequests = pageSize === "all" ? filteredRequests : filteredRequests.slice((page - 1) * effectivePageSize, page * effectivePageSize);

  useEffect(() => setPage(1), [search, locationsSelected, headsSelected, statusesSelected, paymentModesSelected, fromDate, toDate, pageSize]);
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);

  return (
    <>
      <div className="payment-report-filters">
        <label className="payment-report-search">Search<input className="field" onChange={(event) => setSearch(event.target.value)} placeholder="Request, person, account, IFSC, UTR..." type="search" value={search} /></label>
        <MultiCheckFilter allLabel="All locations" label="Location" options={locations} selected={locationsSelected} setSelected={setLocationsSelected} />
        <MultiCheckFilter allLabel="All heads" label="Payment head" options={heads} selected={headsSelected} setSelected={setHeadsSelected} />
        <MultiCheckFilter allLabel="All statuses" label="Status" options={statuses} selected={statusesSelected} setSelected={setStatusesSelected} />
        <MultiCheckFilter allLabel="All methods" displayValue={(item) => item.replaceAll("_", " ")} label="Payment method" options={paymentModes} selected={paymentModesSelected} setSelected={setPaymentModesSelected} />
        <label>From<input className="field" onChange={(event) => setFromDate(event.target.value)} type="date" value={fromDate} /></label>
        <label>To<input className="field" onChange={(event) => setToDate(event.target.value)} type="date" value={toDate} /></label>
        <label>Rows<select className="select" onChange={(event) => setPageSize(event.target.value)} value={pageSize}>{["20", "100", "500", "1000"].map((size) => <option key={size}>{size}</option>)}<option value="all">All</option></select></label>
      </div>
      <p className="subtle payment-report-result-count">Showing {visibleRequests.length} of {filteredRequests.length} matching records</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Request</th>
              <th>Location</th>
              <th>Payment Head</th>
              <th>External ID</th>
              <th>Amount</th>
              <th>Account Holder</th>
              <th>Bank Account</th>
              <th>IFSC</th>
              <th>Status</th>
              <th>Document</th>
              <th>Created</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {visibleRequests.length ? visibleRequests.map((request) => (
              <tr key={request.id}>
                <td><strong>{request.request_no}</strong></td>
                <td>{request.location_code}</td>
                <td>{request.payment_head_name}</td>
                <td>{request.payment_head_external_id}</td>
                <td>{formatAmount(request.amount)}</td>
                <td>{request.account_holder_name ?? "-"}</td>
                <td>{request.bank_account_no ?? "-"}</td>
                <td>{request.ifsc ?? "-"}</td>
                <td><StatusPill status={reportStatusLabel(request)} /></td>
                <td>{request.supporting_document_path ? "Uploaded" : "-"}</td>
                <td>{formatDate(request.created_at)}</td>
                <td>
                  <button className="button secondary compact" onClick={() => setSelectedRequest(request)} type="button">
                    View
                  </button>
                </td>
              </tr>
            )) : (
              <tr><td className="empty-cell" colSpan={12}>No payment requests found.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {filteredRequests.length > effectivePageSize ? <div className="panel-foot pagination"><button className="pager-button" disabled={page === 1} onClick={() => setPage((value) => value - 1)} type="button">Previous</button><span>Page {page} of {totalPages}</span><button className="pager-button" disabled={page === totalPages} onClick={() => setPage((value) => value + 1)} type="button">Next</button></div> : null}

      {selectedRequest ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide" aria-label="View payment request">
            <div className="panel-head">
              <div>
                <h2>Payment request details</h2>
                <p className="subtle">{selectedRequest.request_no} - {selectedRequest.location_code}</p>
              </div>
              <button className="modal-close" onClick={() => setSelectedRequest(null)} type="button">x</button>
            </div>
            <div className="panel-body">
              <div className="form-grid three">
                <label>Payment Head<input className="field" readOnly value={selectedRequest.payment_head_name} /></label>
                <label>External ID<input className="field" readOnly value={selectedRequest.payment_head_external_id} /></label>
                <label>Status<input className="field" readOnly value={reportStatusLabel(selectedRequest)} /></label>
                <label>Amount<input className="field" readOnly value={formatAmount(selectedRequest.amount)} /></label>
                <label>Location<input className="field" readOnly value={selectedRequest.location_code} /></label>
                <label>Created<input className="field" readOnly value={formatDate(selectedRequest.created_at)} /></label>
                <label>UTR/CIN<input className="field" readOnly value={selectedRequest.utr_cin ?? "-"} /></label>
                <label>Transfer Date<input className="field" readOnly value={selectedRequest.processed_at ? formatDate(selectedRequest.processed_at) : "-"} /></label>
                <label>Bank Status<input className="field" readOnly value={selectedRequest.bank_status ?? "-"} /></label>
                <label>Acc Holder Name<input className="field" readOnly value={selectedRequest.account_holder_name ?? "-"} /></label>
                <label>Bank Account No<input className="field" readOnly value={selectedRequest.bank_account_no ?? "-"} /></label>
                <label>IFSC<input className="field" readOnly value={selectedRequest.ifsc ?? "-"} /></label>
                <label>Contact No<input className="field" readOnly value={selectedRequest.contact_no ?? "-"} /></label>
                <label>Email<input className="field" readOnly value={selectedRequest.email ?? "-"} /></label>
                <label className="span-3">Bank Processing Remarks<textarea className="field" readOnly rows={2} value={selectedRequest.bank_processing_remarks ?? "-"} /></label>
                <label className="span-3">Remarks<textarea className="field" readOnly rows={3} value={selectedRequest.remarks ?? "-"} /></label>
              </div>

              {selectedRequest.answers.length ? (
                <>
                  <div className="section-divider" />
                  <h3>Request details</h3>
                  <div className="table-wrap">
                    <table>
                      <tbody>
                        {selectedRequest.answers.map((answer) => (
                          <tr key={answer.id}>
                            <th>{answer.question_text ?? "Field"}</th>
                            <td>
                              {answer.file_name ? (
                                <span className="payment-attachment-cell">
                                  <span>{answer.file_name}</span>
                                  <a
                                    aria-label={`View ${answer.file_name}`}
                                    className="icon-button payment-attachment-view"
                                    href={`/api/payments/requests/attachment?answer_id=${encodeURIComponent(answer.id)}`}
                                    rel="noreferrer"
                                    target="_blank"
                                    title="View attachment"
                                  >
                                    <Eye size={16} />
                                  </a>
                                </span>
                              ) : answer.answer_value || "-"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : null}

              <div className="section-divider" />
              <h3>History</h3>
              <div className="table-wrap">
                <table>
                  <tbody>
                    {history.length ? history.map((item) => (
                      <tr key={item.id}>
                        <td><StatusPill status={item.status} /></td>
                        <td>{item.actor}</td>
                        <td>{item.role}</td>
                        <td>{item.comments}</td>
                        <td>{formatDateTime(item.created_at)}</td>
                      </tr>
                    )) : (
                      <tr><td className="empty-cell" colSpan={5}>No history found.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
