import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PaymentApprovalFilters } from "@/components/payment-approval-filters";
import { PaymentApprovalActionForm } from "@/components/payment-approval-action-form";
import { PendingLink } from "@/components/pending-link";
import { StatusPill } from "@/components/status-pill";
import { Eye } from "lucide-react";
import { requirePagePermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDate, formatDashboardDateTime } from "@/lib/date-format";
import { getPaymentApprovalEligibility } from "@/lib/payment-approval-scope";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";
import {
  handleApprovePaymentApproval,
  handleRejectPaymentApproval,
  handleReturnPaymentApproval
} from "./actions";

type RequestRow = {
  id: string;
  request_no: string;
  location_id: string | null;
  location_code: string;
  payment_head_id: string;
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
  remarks: string | null;
  status: string;
  approval_status: string | null;
  current_approver_user_id: string | null;
  current_approver_role_id: string | null;
  current_approver_role_ids: string[] | null;
  final_approval_role_id: string | null;
  final_approval_role_ids: string[] | null;
  requested_by: string | null;
  approval_cycle: number | null;
  created_at: string;
  updated_at: string | null;
  processed_at: string | null;
  payment_heads?: { name: string; code: string } | null;
  profiles?: { full_name: string | null; email: string | null } | null;
};

const NO_LOCATION_SCOPE_ID = "00000000-0000-0000-0000-000000000000";

type AnswerRow = {
  id: string;
  answer_value: string | null;
  file_path: string | null;
  file_name: string | null;
  payment_head_questions?: { question_text: string; answer_type: string } | null;
};

type ApprovalLogRow = {
  id: string;
  action: string;
  comments: string | null;
  created_at: string;
  approver_user_id?: string | null;
  approver_role_id?: string | null;
  approval_cycle?: number | null;
  profiles?: { full_name: string | null; email: string | null } | null;
  user_roles?: { name: string | null; code: string | null } | null;
};

function firstRelation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function hasDisplayValue(value: string | number | null | undefined) {
  return value != null && String(value).trim() !== "" && String(value).trim() !== "-";
}

async function loadApprovalLogs(companyId: string, requestId: string) {
  if (!supabaseAdmin) return { logs: [] as ApprovalLogRow[], error: null as string | null };

  const logsResult = await supabaseAdmin
    .from("payment_request_approvals")
    .select("id, action, comments, created_at, approver_user_id, approver_role_id, approval_cycle")
    .eq("company_id", companyId)
    .eq("payment_request_id", requestId)
    .order("created_at", { ascending: true });

  if (logsResult.error) return { logs: [] as ApprovalLogRow[], error: logsResult.error.message };

  const rawLogs = (logsResult.data ?? []) as ApprovalLogRow[];
  const userIds = Array.from(new Set(rawLogs.map((log) => log.approver_user_id).filter(Boolean))) as string[];
  const roleIds = Array.from(new Set(rawLogs.map((log) => log.approver_role_id).filter(Boolean))) as string[];

  const [profilesResult, rolesResult] = await Promise.all([
    userIds.length
      ? supabaseAdmin.from("profiles").select("id, full_name, email").eq("company_id", companyId).in("id", userIds)
      : { data: [], error: null },
    roleIds.length
      ? supabaseAdmin.from("user_roles").select("id, name, code").eq("company_id", companyId).in("id", roleIds)
      : { data: [], error: null }
  ]);

  const profilesById = new Map((profilesResult.data ?? []).map((profile) => [profile.id, profile]));
  const rolesById = new Map((rolesResult.data ?? []).map((role) => [role.id, role]));

  return {
    logs: rawLogs.map((log) => ({
      ...log,
      profiles: log.approver_user_id ? profilesById.get(log.approver_user_id) ?? null : null,
      user_roles: log.approver_role_id ? rolesById.get(log.approver_role_id) ?? null : null
    })),
    error: profilesResult.error?.message || rolesResult.error?.message || null
  };
}

async function loadNextActionFrom(companyId: string, request: RequestRow | null) {
  if (!supabaseAdmin || !request) return "-";
  const status = String(request.approval_status || request.status || "").trim().toUpperCase();
  if (status === "RETURNED") return "Requester";
  if (["REJECTED", "CANCELLED", "PROCESSED"].includes(status)) return "-";

  if (request.current_approver_user_id) {
    const { data } = await supabaseAdmin
      .from("profiles")
      .select("full_name, email")
      .eq("company_id", companyId)
      .eq("id", request.current_approver_user_id)
      .maybeSingle();
    if (data) return data.full_name || data.email || "Assigned approver";
  }

  const roleIds = Array.from(new Set([
    request.current_approver_role_id,
    ...(request.current_approver_role_ids ?? [])
  ].filter(Boolean))) as string[];
  if (roleIds.length) {
    const { data } = await supabaseAdmin
      .from("user_roles")
      .select("name, code")
      .eq("company_id", companyId)
      .in("id", roleIds);
    const names = (data ?? []).map((role) => role.name || role.code).filter(Boolean);
    if (names.length) return names.join(", ");
  }

  if (["APPROVED", "OWNER_APPROVED", "RE_APPROVED"].includes(status) || status.endsWith("_APPROVED")) {
    return "Payment processor";
  }
  return "-";
}

async function loadApprovals(companyId: string, authorization: AuthorizationContext, statusFilter: string | undefined, searchTerm: string | undefined) {
  if (!supabaseAdmin) {
    return {
      requests: [] as RequestRow[],
      selectedRequest: null as RequestRow | null,
      answers: [] as AnswerRow[],
      logs: [] as ApprovalLogRow[],
      canDownloadProcessData: false,
      error: "Supabase service role key is not configured."
    };
  }

  let query = supabaseAdmin
    .from("payment_requests")
    .select(`
      id,
      request_no,
      location_id,
      location_code,
      payment_head_id,
      amount,
      amount_requested,
      payment_mode,
      payment_portal,
      payment_reference,
      bank_account_no,
      ifsc,
      account_holder_name,
      contact_no,
      email,
      remarks,
      status,
      approval_status,
      current_approver_user_id,
      current_approver_role_id,
      current_approver_role_ids,
      final_approval_role_id,
      final_approval_role_ids,
      requested_by,
      approval_cycle,
      created_at,
      updated_at,
      processed_at,
      payment_heads ( name, code ),
      profiles:requested_by ( full_name, email )
    `)
    .eq("company_id", companyId)
    .order("created_at", { ascending: false });

  if (!authorization.hasAllLocationAccess) {
    query = query.in(
      "location_id",
      authorization.locationScopeIds.length
        ? authorization.locationScopeIds
        : [NO_LOCATION_SCOPE_ID]
    );
  }

  const requestsResult = await query;
  const processHeadsResult = authorization.roleId ? await supabaseAdmin
    .from("payment_heads")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .contains("payment_process_role_ids", [authorization.roleId]) : { count: 0, error: null };
  const unscopedRequests = ((requestsResult.data ?? []) as unknown as RequestRow[]).map((request) => ({
    ...request,
    payment_heads: firstRelation(request.payment_heads),
    profiles: firstRelation(request.profiles)
  }));
  const eligibleIds = await getPaymentApprovalEligibility(companyId, authorization, unscopedRequests);
  const normalizedFilter = statusFilter || "pending";
  const normalizedSearch = String(searchTerm ?? "").trim().toLowerCase();
  const pendingApprovalStatuses = new Set(["pending", "resubmitted", "re_pending", "re_cluster_approved"]);
  const requests = unscopedRequests.filter((request) => {
    if (!eligibleIds.has(request.id)) return false;
    const requestStatus = String(request.status ?? "").trim().toLowerCase();
    const approvalStatus = String(request.approval_status ?? "").toUpperCase();
    if (normalizedFilter === "pending") {
      if (!pendingApprovalStatuses.has(requestStatus)) return false;
    } else if (normalizedFilter === "returned") {
      if (requestStatus !== "returned" && approvalStatus !== "RETURNED") return false;
    } else if (normalizedFilter === "rejected") {
      if (requestStatus !== "rejected" && approvalStatus !== "REJECTED") return false;
    }
    if (!normalizedSearch) return true;
    const haystack = [
      request.request_no,
      request.location_code,
      request.payment_heads?.name,
      request.payment_heads?.code,
      request.amount == null ? "" : String(request.amount),
      request.profiles?.full_name,
      request.profiles?.email,
      request.status,
      request.approval_status
    ].join(" ").toLowerCase();
    return haystack.includes(normalizedSearch);
  });
  const selectedRequestId = requests[0]?.id ?? null;
  const [answersResult, logsData] = selectedRequestId ? await Promise.all([
    supabaseAdmin
      .from("payment_request_answers")
      .select("id, answer_value, file_path, file_name, payment_head_questions ( question_text, answer_type )")
      .eq("company_id", companyId)
      .eq("payment_request_id", selectedRequestId),
    loadApprovalLogs(companyId, selectedRequestId)
  ]) : [{ data: [], error: null }, { logs: [], error: null }];

  return {
    requests,
    selectedRequest: requests[0] ?? null,
    answers: ((answersResult.data ?? []) as unknown as AnswerRow[]).map((answer) => ({
      ...answer,
      payment_head_questions: firstRelation(answer.payment_head_questions)
    })),
    logs: logsData.logs,
    canDownloadProcessData: Boolean(authorization.roleId && (processHeadsResult.count ?? 0) > 0),
    error: requestsResult.error?.message || answersResult.error?.message || logsData.error || processHeadsResult.error?.message || null
  };
}

export const dynamic = "force-dynamic";

export default async function PaymentApprovalsPage({
  searchParams
}: {
  searchParams?: { status?: string; search?: string; manage?: string; approvalError?: string; approvalNotice?: string };
}) {
  const authorization = await requirePagePermission("payment_approvals", "access");
  const companyId = requireCompanyId(authorization);
  const pagePermission = authorization.permissions.payment_approvals;
  const currentStatus = ["pending", "returned", "rejected", "all"].includes(searchParams?.status ?? "") ? searchParams?.status ?? "pending" : "pending";
  const currentSearch = searchParams?.search ?? "";
  const currentParams = new URLSearchParams({
    status: currentStatus,
    ...(currentSearch ? { search: currentSearch } : {})
  });
  const { requests, canDownloadProcessData, error } = await loadApprovals(companyId, authorization, currentStatus, currentSearch);
  const manageId = searchParams?.manage;
  const selectedRequest = manageId ? requests.find((request) => request.id === manageId) ?? null : null;
  const detailData = selectedRequest && supabaseAdmin ? await Promise.all([
    supabaseAdmin
      .from("payment_request_answers")
      .select("id, answer_value, file_path, file_name, payment_head_questions ( question_text, answer_type )")
      .eq("company_id", companyId)
      .eq("payment_request_id", selectedRequest.id),
    loadApprovalLogs(companyId, selectedRequest.id)
  ]) : null;
  const answers = ((detailData?.[0].data ?? []) as unknown as AnswerRow[]).map((answer) => ({
    ...answer,
    payment_head_questions: firstRelation(answer.payment_head_questions)
  }));
  const logs = detailData?.[1].logs ?? [];
  const currentNextActionFrom = await loadNextActionFrom(companyId, selectedRequest);
  const currentApprovalCycle = Number(selectedRequest?.approval_cycle) || 1;
  const isResubmitted =
    selectedRequest?.status.toLowerCase() === "resubmitted" ||
    String(selectedRequest?.approval_status ?? "").toUpperCase() === "RESUBMITTED";
  const currentUserAlreadyActed = !isResubmitted && logs.some(
    (log) =>
      log.approver_user_id === authorization.userId &&
      (Number(log.approval_cycle) || 1) === currentApprovalCycle
  );
  const lifecycleBaseRows = selectedRequest
    ? [
        {
          id: `created-${selectedRequest.id}`,
          action: "created",
          comments: selectedRequest.remarks || "Payment request created.",
          created_at: selectedRequest.created_at,
          actor: selectedRequest.profiles?.full_name ?? selectedRequest.profiles?.email ?? "Requester",
          role: "Requester"
        },
        ...logs.map((log) => ({
          id: log.id,
          action: log.action,
          comments: log.comments,
          created_at: log.created_at,
          actor: log.profiles?.full_name ?? log.profiles?.email ?? "System",
          role: log.user_roles?.name ?? log.user_roles?.code ?? "-"
        })),
        ...(selectedRequest.processed_at && !logs.some((log) => log.action.toLowerCase() === "processed")
          ? [{
              id: `processed-${selectedRequest.id}`,
              action: "processed",
              comments: "Payment processing completed.",
              created_at: selectedRequest.processed_at,
              actor: "System",
              role: "Payment processing"
            }]
          : [])
      ].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    : [];
  const lifecycleRows = lifecycleBaseRows.map((entry, index) => {
    const nextEntry = lifecycleBaseRows[index + 1];
    const nextActionFrom = nextEntry
      ? `${nextEntry.actor}${nextEntry.role && nextEntry.role !== "-" ? ` (${nextEntry.role})` : ""}`
      : currentNextActionFrom;
    return { ...entry, nextActionFrom };
  });
  const canShowApprovalActions =
    pagePermission.canEdit &&
    !currentUserAlreadyActed &&
    !["approved", "rejected", "cancelled", "returned"].includes(selectedRequest?.status.toLowerCase() ?? "") &&
    String(selectedRequest?.approval_status ?? "").toUpperCase() !== "RETURNED";

  return (
    <AppShell active="Payment Approvals" pageCode="payment_approvals">
      <PageHead
        eyebrow="Payments"
        title="Approvals"
        subtitle="Approve or reject payment requests currently assigned to you."
        action={<span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>{isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}</span>}
      />

      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Payment approval setup needed</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{error} Run `scripts/payment_requests_v1.sql` in Supabase SQL Editor, then refresh.</p>
          </div>
        </section>
      ) : null}

      {searchParams?.approvalError || searchParams?.approvalNotice ? (
        <section className={`panel message-panel ${searchParams.approvalError ? "error" : "success"}`}>
          <div className="panel-body">
            <strong>{searchParams.approvalError ? "Payment approval not updated" : "Payment approval updated"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>
              {searchParams.approvalError ?? searchParams.approvalNotice}
            </p>
          </div>
        </section>
      ) : null}

      {!error && pagePermission.canView ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Approval list</h2>
              <p className="subtle">{requests.length} records</p>
            </div>
            <PaymentApprovalFilters search={currentSearch} status={currentStatus} />
            {canDownloadProcessData ? (
              <a className="button secondary compact" href="/api/payments/approvals/download">Download raw Excel</a>
            ) : null}
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Location</th>
                  <th>Payment Head</th>
                  <th>Amount</th>
                  <th>Requested By</th>
                  <th>Status</th>
                  <th>Created</th>
                  {pagePermission.canEdit ? <th>Action</th> : null}
                </tr>
              </thead>
              <tbody>
                {requests.length ? requests.map((request) => (
                  <tr key={request.id}>
                    <td><strong>{request.request_no}</strong></td>
                    <td>{request.location_code}</td>
                    <td>{request.payment_heads?.name ?? "-"}</td>
                    <td>{request.amount == null ? "-" : `Rs ${Number(request.amount).toLocaleString("en-IN")}`}</td>
                    <td>{request.profiles?.full_name ?? request.profiles?.email ?? "-"}</td>
                    <td><StatusPill status={request.status} /></td>
                    <td>{formatDashboardDate(request.created_at)}</td>
                    {pagePermission.canEdit ? <td><PendingLink className="button secondary compact" href={`/payments/approvals?${new URLSearchParams({ ...Object.fromEntries(currentParams), manage: request.id }).toString()}`} scroll={false}>Manage</PendingLink></td> : null}
                  </tr>
                )) : (
                  <tr><td className="empty-cell" colSpan={pagePermission.canEdit ? 8 : 7}>No approvals pending.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {selectedRequest ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide" aria-label="Manage payment approval">
            <div className="panel-head">
              <div>
                <h2>Manage payment request</h2>
                <p className="subtle">{selectedRequest.request_no} · {selectedRequest.location_code}</p>
              </div>
              <PendingLink className="icon-button" href={`/payments/approvals?${currentParams.toString()}`} scroll={false} aria-label="Close">x</PendingLink>
            </div>
            <div className="panel-body">
              {searchParams?.approvalError ? (
                <div className="message-panel error" style={{ marginBottom: 16 }}>
                  <strong>Payment approval not updated</strong>
                  <p className="subtle" style={{ marginTop: 6 }}>{searchParams.approvalError}</p>
                </div>
              ) : null}
              <div className="form-grid three">
                <label>Payment Head<input className="field" readOnly value={selectedRequest.payment_heads?.name ?? "-"} /></label>
                <label>{selectedRequest.amount == null && selectedRequest.amount_requested != null ? "Estimated Amount" : "Amount"}<input className="field" readOnly value={(selectedRequest.amount ?? selectedRequest.amount_requested) == null ? "-" : `Rs ${Number(selectedRequest.amount ?? selectedRequest.amount_requested).toLocaleString("en-IN")}`} /></label>
                <label>Status<input className="field" readOnly value={selectedRequest.approval_status || selectedRequest.status} /></label>
                <label>Payment Method<input className="field" readOnly value={selectedRequest.payment_mode === "upi_payment" ? "UPI Payment" : selectedRequest.payment_mode === "online_payment" ? "Online Payment" : "Bank Transfer"} /></label>
                {hasDisplayValue(selectedRequest.account_holder_name) ? <label>Acc Holder Name<input className="field" readOnly value={selectedRequest.account_holder_name ?? "-"} /></label> : null}
                {selectedRequest.payment_mode === "upi_payment" && hasDisplayValue(selectedRequest.payment_reference) ? <label>UPI ID<input className="field" readOnly value={selectedRequest.payment_reference ?? "-"} /></label> : null}
                {selectedRequest.payment_mode === "online_payment" && hasDisplayValue(selectedRequest.payment_portal) ? <label>Payment Portal<input className="field" readOnly value={selectedRequest.payment_portal ?? "-"} /></label> : null}
                {selectedRequest.payment_mode === "online_payment" && hasDisplayValue(selectedRequest.payment_reference) ? <label>Reference ID<input className="field" readOnly value={selectedRequest.payment_reference ?? "-"} /></label> : null}
                {(selectedRequest.payment_mode ?? "account_transfer") === "account_transfer" && hasDisplayValue(selectedRequest.bank_account_no) ? <label>Bank Account No<input className="field" readOnly value={selectedRequest.bank_account_no ?? "-"} /></label> : null}
                {(selectedRequest.payment_mode ?? "account_transfer") === "account_transfer" && hasDisplayValue(selectedRequest.ifsc) ? <label>IFSC<input className="field" readOnly value={selectedRequest.ifsc ?? "-"} /></label> : null}
                {hasDisplayValue(selectedRequest.contact_no) ? <label>Contact No<input className="field" readOnly value={selectedRequest.contact_no ?? "-"} /></label> : null}
                {hasDisplayValue(selectedRequest.email) ? <label>Email<input className="field" readOnly value={selectedRequest.email ?? "-"} /></label> : null}
              </div>
              {answers.length ? (
                <>
                  <div className="section-divider" />
                  <h3>Request details</h3>
                  <div className="table-wrap">
                    <table>
                      <tbody>
                        {answers.map((answer) => (
                          <tr key={answer.id}>
                            <th>{answer.payment_head_questions?.question_text ?? "Field"}</th>
                            <td>
                              {answer.file_name ? (
                                <span className="payment-attachment-cell">
                                  <span>{answer.file_name}</span>
                                  <a
                                    className="icon-button payment-attachment-view"
                                    href={`/api/payments/requests/attachment?answer_id=${encodeURIComponent(answer.id)}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    aria-label={`View ${answer.file_name}`}
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
              {lifecycleRows.length ? (
                <>
                  <div className="section-divider" />
                  <h3>Request history</h3>
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>Action</th><th>Action by</th><th>Role</th><th>Next action from</th><th>Remarks</th><th>Date</th></tr></thead>
                      <tbody>
                        {lifecycleRows.map((entry) => (
                          <tr key={entry.id}>
                            <td><StatusPill status={entry.action} /></td>
                            <td>{entry.actor}</td>
                            <td>{entry.role}</td>
                            <td>{entry.nextActionFrom}</td>
                            <td>{entry.comments || "-"}</td>
                            <td>{formatDashboardDateTime(entry.created_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : null}
              {hasDisplayValue(selectedRequest.remarks) && !canShowApprovalActions ? (
                <>
                  <div className="section-divider" />
                  <div className="form-grid two">
                    <label className="span-2">Request Remarks<textarea className="field" readOnly rows={3} value={selectedRequest.remarks ?? "-"} /></label>
                  </div>
                </>
              ) : null}
              {canShowApprovalActions ? (
                <>
                  <div className="section-divider" />
                  <PaymentApprovalActionForm
                    approveAction={handleApprovePaymentApproval}
                    rejectAction={handleRejectPaymentApproval}
                    requestRemarks={selectedRequest.remarks}
                    requestId={selectedRequest.id}
                    returnAction={handleReturnPaymentApproval}
                    status={currentStatus}
                  />
                </>
              ) : null}
              {pagePermission.canEdit && currentUserAlreadyActed ? (
                <>
                  <div className="section-divider" />
                  <p className="subtle">You have already acted on this request. The next approval action is available only to the higher approver.</p>
                </>
              ) : null}
              {pagePermission.canEdit && (selectedRequest.status.toLowerCase() === "returned" || String(selectedRequest.approval_status ?? "").toUpperCase() === "RETURNED") ? (
                <>
                  <div className="section-divider" />
                  <p className="subtle">This request has been returned to the initiator for resubmission.</p>
                </>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </AppShell>
  );
}
