import type { PaymentReportRequest } from "../components/payment-report-table";
import { paymentStatusLabel } from "./payment-status-label.ts";

export function summarizePaymentReport(requests: PaymentReportRequest[]) {
  let pending = 0;
  let approved = 0;
  let amount = 0;
  for (const request of requests) {
    const status = paymentStatusLabel(request);
    if (["Pending Initial Approval", "Final Approval Pending", "Approval In Progress", "Resubmitted", "Resubmitted - Initial Approval", "Resubmitted - Final Approval"].includes(status)) pending += 1;
    if (["Final Approved", "Resubmitted - Payment Processing"].includes(status)) approved += 1;
    amount += Number(request.amount ?? request.amount_requested ?? 0);
  }
  return { total: requests.length, pending, approved, amount };
}

function csvCell(value: string | number | null | undefined) {
  const text = String(value ?? "");
  // Quote fields and neutralize spreadsheet formulas in user-entered text.
  const safe = typeof value === "string" && /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** Export the complete filtered result, before display pagination. */
export function paymentReportCsv(requests: PaymentReportRequest[]) {
  const records: Array<Array<string | number | null>> = [[
    "Request", "Request Type", "Location", "Payment Head", "External ID", "Amount",
    "Payment Method", "Account Holder", "Bank Account", "IFSC", "Contact No", "Email",
    "Requester", "Current Owner", "Responsible Role", "Approval Step", "Status",
    "UTR/CIN", "Bank Status", "Bank Processing Remarks", "Remarks", "Document",
    "Created", "Processed", "Updated"
  ]];
  for (const request of requests) {
    const currentStep = Number(request.current_step_order) || 0;
    const totalSteps = Math.max(Number(request.total_steps) || 0, currentStep);
    records.push([
      request.request_no,
      String(request.category ?? "payment").toLowerCase() === "expense" ? "Expense Request" : "Payment Request",
      request.location_code, request.payment_head_name, request.payment_head_external_id,
      request.amount ?? request.amount_requested, request.payment_mode,
      request.account_holder_name, request.bank_account_no, request.ifsc, request.contact_no, request.email,
      request.requested_by_name ?? request.requested_by_email,
      request.current_approver_name ?? request.current_approver_email,
      request.current_approver_role_names.join(", "), currentStep ? `${currentStep} of ${totalSteps}` : "",
      paymentStatusLabel(request), request.utr_cin, request.bank_status, request.bank_processing_remarks,
      request.remarks, request.supporting_document_path ? "Uploaded" : "",
      request.created_at, request.processed_at, request.updated_at
    ]);
  }
  return "\uFEFF" + records.map((record) => record.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
