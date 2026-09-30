import { AppShell } from "@/components/app-shell";
import { AdhocDaFields } from "@/components/adhoc-da-fields";
import { AutoGrowTextarea } from "@/components/auto-grow-textarea";
import { PageHead } from "@/components/page-head";
import { PaymentRequestForm } from "@/components/payment-request-form";
import { PaymentBeneficiaryFields } from "@/components/payment-beneficiary-fields";
import { PendingLink } from "@/components/pending-link";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDate, formatDashboardDateTime } from "@/lib/date-format";
import { paymentFileAccept, paymentFileGroupLabels } from "@/lib/payment-file-types";
import { paymentRequestAttachments } from "@/lib/payment-request-attachments";
import { loadUserPaymentContacts } from "@/lib/payment-contacts";
import { paymentStatusLabel } from "@/lib/payment-status-label";
import { hasSubmittedPaymentDetails } from "@/lib/payment-details";
import { loadPaymentNotificationSnapshot } from "@/lib/payment-notification-counts";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";
import { paymentModeLabel, type PaymentMode } from "@/lib/payment-modes";
import { paymentQuestionDateBounds } from "@/lib/payment-question-date-rules";
import { paymentRequestCancelEligibility, type CancelEligibility } from "@/lib/payment-request-cancel";
import { buildPaymentApprovalFlow } from "@/lib/payment-approval-flow";
import { loadApprovalSteps } from "@/lib/payment-approval-steps";
import { cancelPaymentRequest, createPaymentRequest, resubmitPaymentRequest, submitPaymentBankDetails } from "./actions";

type QuestionRow = { id: string; question_text: string; answer_type: string; dropdown_options: string | null; field_stage: string | null; is_required: boolean; sort_order: number; date_rule?: string | null; date_days?: number | null };
type LocationRow = {
  id: string;
  station_code: string;
  station_email: string | null;
  station_manager_email: string | null;
  station_name: string | null;
};
type PaymentHeadRow = {
  id: string;
  code: string;
  name: string;
  requires_supporting_document: boolean;
  request_expense_approval: boolean;
  expense_approval_threshold: number | null;
  supported_payment_modes: PaymentMode[] | null;
  payment_head_questions?: QuestionRow[] | null;
};
type PaymentRequestRow = {
  id: string;
  adhoc_da_name: string | null;
  adhoc_provider_employee_id: string | null;
  adhoc_work_date: string | null;
  request_no: string;
  location_id: string | null;
  location_code: string;
  payment_head_id: string;
  amount: number | null;
  amount_requested: number | null;
  bank_account_no: string | null;
  ifsc: string | null;
  account_holder_name: string | null;
  contact_no: string | null;
  email: string | null;
  remarks: string | null;
  status: string;
  approval_status: string | null;
  requested_by: string | null;
  payment_mode: PaymentMode | null;
  payment_portal: string | null;
  payment_reference: string | null;
  created_at: string;
};
type AnswerRow = {
  id: string;
  question_id: string;
  answer_value: string | null;
  file_name: string | null;
  file_path: string | null;
  file_size?: number | null;
  attachments?: unknown;
};
type ApprovalRemarkRow = { action: string | null; comments: string | null; created_at: string };
type HistoryRow = ApprovalRemarkRow & { approver_user_id: string | null; approver_role_id: string | null };

async function loadApprovalFlow(companyId: string, request: PaymentRequestRow, history: HistoryRow[]) {
  if (!supabaseAdmin) return null;
  const admin = supabaseAdmin;
  const [current, head, steps] = await Promise.all([
    admin.from("payment_requests")
      .select("current_step_order, current_approver_user_id, current_approver_role_id, current_approver_role_ids")
      .eq("company_id", companyId).eq("id", request.id).maybeSingle(),
    admin.from("payment_heads")
      .select("initial_approval_role_id, initial_approval_role_ids, final_approval_role_id, final_approval_role_ids, payment_process_role_ids")
      .eq("company_id", companyId).eq("id", request.payment_head_id).maybeSingle(),
    loadApprovalSteps(companyId, request.payment_head_id).catch(() => [])
  ]);
  const roleList = (many: unknown, one: unknown) =>
    Array.from(new Set([...(Array.isArray(many) ? many : []), one].filter((id): id is string => typeof id === "string" && Boolean(id))));
  const levels = steps.length
    ? steps.map((step) => ({ stepOrder: step.step_order, roleIds: step.candidates.map((candidate) => candidate.role_id) }))
    : [
        { stepOrder: 1, roleIds: roleList(head.data?.initial_approval_role_ids, head.data?.initial_approval_role_id) },
        { stepOrder: 2, roleIds: roleList(head.data?.final_approval_role_ids, head.data?.final_approval_role_id) }
      ].filter((level) => level.roleIds.length);
  const financeRoleIds = roleList(head.data?.payment_process_role_ids, null);
  const flow = buildPaymentApprovalFlow(
    { status: request.status, approval_status: request.approval_status, current_step_order: current.data?.current_step_order ?? null },
    levels, financeRoleIds, history
  );

  const currentUserId: string | null = current.data?.current_approver_user_id ?? null;
  const currentRoleIds = roleList(current.data?.current_approver_role_ids, current.data?.current_approver_role_id);
  const userIds = Array.from(new Set([currentUserId, ...flow.map((step) => step.approvedByUserId), ...history.map((row) => row.approver_user_id)]
    .filter((id): id is string => Boolean(id))));
  const roleIds = Array.from(new Set([...flow.flatMap((step) => step.roleIds), ...currentRoleIds]));
  const [people, roles] = await Promise.all([
    userIds.length ? admin.from("profiles").select("id, full_name, email").eq("company_id", companyId).in("id", userIds) : Promise.resolve({ data: [] }),
    roleIds.length ? admin.from("user_roles").select("id, name").eq("company_id", companyId).in("id", roleIds) : Promise.resolve({ data: [] })
  ]);
  const personName = new Map(((people.data ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>)
    .map((person) => [person.id, person.full_name || person.email || "Unknown user"]));
  const roleName = new Map(((roles.data ?? []) as Array<{ id: string; name: string | null }>).map((role) => [role.id, role.name || "Role"]));
  const rolesLabel = (ids: string[]) => ids.map((id) => roleName.get(id)).filter(Boolean).join(" / ") || "Not configured";

  return {
    steps: flow.map((step) => ({
      ...step,
      rolesText: rolesLabel(step.roleIds),
      approvedBy: step.approvedByUserId ? personName.get(step.approvedByUserId) ?? null : null,
      pendingWith: step.state === "current"
        ? (currentUserId ? personName.get(currentUserId) ?? null : null) ?? (currentRoleIds.length ? `Any ${rolesLabel(currentRoleIds)}` : `Any ${rolesLabel(step.roleIds)}`)
        : null
    })),
    personName
  };
}

const NO_LOCATION_SCOPE_ID = "00000000-0000-0000-0000-000000000000";

function isResubmittable(request: PaymentRequestRow, userId: string) {
  return request.requested_by === userId && (
    String(request.status ?? "").toLowerCase() === "returned" ||
    String(request.approval_status ?? "").toUpperCase() === "RETURNED"
  );
}

function canSubmitBankDetails(request: PaymentRequestRow, userId: string) {
  if (request.requested_by !== userId) return false;
  const status = String(request.status ?? "").toUpperCase();
  const approvalStatus = String(request.approval_status ?? "").toUpperCase();
  const isRejectedOrReturned = ["REJECTED", "RETURNED", "CANCELLED"].includes(status) || ["REJECTED", "RETURNED", "CANCELLED"].includes(approvalStatus);
  const isAlreadyProcessing = ["PROCESSING", "PROCESSED"].includes(status) || ["PROCESSING", "PROCESSED"].includes(approvalStatus);
  const isApproved = status === "APPROVED" || approvalStatus === "APPROVED" || status === "OWNER_APPROVED" || approvalStatus === "OWNER_APPROVED" || approvalStatus.endsWith("_APPROVED");
  return isApproved && !isRejectedOrReturned && !isAlreadyProcessing && !hasSubmittedPaymentDetails(request);
}

function paymentLifecycleLabel(request: PaymentRequestRow, userId: string) {
  if (canSubmitBankDetails(request, userId)) return "Payout details required";
  const status = String(request.status ?? "").toUpperCase();
  const approvalStatus = String(request.approval_status ?? "").toUpperCase();
  const isFinalApproved = status === "APPROVED" || approvalStatus === "APPROVED" || status === "OWNER_APPROVED" || approvalStatus === "OWNER_APPROVED";
  if (isFinalApproved && !hasSubmittedPaymentDetails(request)) return "Payout details pending";
  if (isFinalApproved && hasSubmittedPaymentDetails(request)) return "Ready for Finance";
  return paymentStatusLabel(request);
}

function optionsFromText(text: string | null) {
  return (text ?? "").split(",").map((option) => option.trim()).filter(Boolean);
}

function questionStage(question: QuestionRow) {
  return question.field_stage === "payment" ? "payment" : "expense";
}

function questionsForStage(questions: QuestionRow[] | null | undefined, stage: "expense" | "payment") {
  return (questions ?? [])
    .filter((question) => Number(question.sort_order ?? 0) > 0)
    .filter((question) => questionStage(question) === stage)
    .sort((first, second) => first.sort_order - second.sort_order);
}

function resubmitInputForQuestion(question: QuestionRow, answer?: AnswerRow) {
  const name = `answers[${question.id}]`;
  const attachments = paymentRequestAttachments(answer);
  if (question.answer_type === "dropdown") {
    return (
      <select className="field" name={name} required={question.is_required} defaultValue={answer?.answer_value ?? ""}>
        <option value="">Select</option>
        {optionsFromText(question.dropdown_options).map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    );
  }
  if (question.answer_type === "textarea") {
    return <AutoGrowTextarea name={name} required={question.is_required} rows={3} defaultValue={answer?.answer_value ?? ""} />;
  }
  if (question.answer_type === "yes_no") {
    return (
      <select className="field" name={name} required={question.is_required} defaultValue={answer?.answer_value ?? ""}>
        <option value="">Select</option>
        <option value="Yes">Yes</option>
        <option value="No">No</option>
      </select>
    );
  }
  if (question.answer_type === "file") {
    return (
      <>
        {attachments.length ? (
          <p className="subtle payment-attachment-cell" style={{ margin: "4px 0 8px" }}>
            Current files: {attachments.map((attachment, index) => <span key={attachment.path}>{index ? ", " : ""}<a href={`/api/payments/requests/attachment?answer_id=${encodeURIComponent(answer!.id)}&attachment_index=${index}`} target="_blank" rel="noreferrer">{attachment.name}</a></span>)}
          </p>
        ) : null}
        <input
          accept={paymentFileAccept(question.dropdown_options)}
          className="field"
          multiple
          name={`files[${question.id}]`}
          required={question.is_required && !attachments.length}
          type="file"
        />
        <p className="subtle" style={{ margin: "4px 0 0" }}>
          {attachments.length
            ? "Choose up to 3 files to replace the current attachment set, or leave blank to keep it."
            : `Upload up to 3 files. Allowed: ${paymentFileGroupLabels(question.dropdown_options).join(", ")}`}
        </p>
      </>
    );
  }
  const dateBounds = question.answer_type === "date" ? paymentQuestionDateBounds(question) : null;
  return (
    <>
      <input
        className="field"
        name={name}
        required={question.is_required}
        step={question.answer_type === "number" ? "0.01" : undefined}
        type={question.answer_type === "number" ? "number" : question.answer_type === "date" ? "date" : "text"}
        defaultValue={answer?.answer_value ?? ""}
        min={dateBounds?.min}
        max={dateBounds?.max}
      />
      {dateBounds?.helper ? <span className="helper-text">Allowed: {dateBounds.helper}</span> : null}
    </>
  );
}

async function loadPaymentRequestData(companyId: string, authorization: AuthorizationContext) {
  if (!supabaseAdmin) {
    return { approvedRequestIds: new Set<string>(), heads: [] as PaymentHeadRow[], locations: [] as LocationRow[], requests: [] as PaymentRequestRow[], error: "Supabase service role key is not configured." };
  }
  let locationsQuery = supabaseAdmin
      .from("stations")
      .select("id, station_code, station_name, station_email, station_manager_email")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("station_code");
  const headsQuery = supabaseAdmin
      .from("payment_heads")
      .select("id, code, name, requires_supporting_document, request_expense_approval, expense_approval_threshold, supported_payment_modes, payment_head_questions (id, question_text, answer_type, dropdown_options, field_stage, is_required, sort_order, date_rule, date_days)")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("code");
  let requestsQuery = supabaseAdmin
      .from("payment_requests")
      .select("id, request_no, location_id, location_code, payment_head_id, amount, amount_requested, bank_account_no, ifsc, account_holder_name, contact_no, email, remarks, status, approval_status, requested_by, payment_mode, payment_portal, payment_reference, created_at, adhoc_da_name, adhoc_provider_employee_id, adhoc_work_date")
      .eq("company_id", companyId)
      .not("amount", "is", null)
      .order("created_at", { ascending: false });

  if (!authorization.hasAllLocationAccess) {
    const locationIds = authorization.locationScopeIds.length
      ? authorization.locationScopeIds
      : [NO_LOCATION_SCOPE_ID];
    locationsQuery = locationsQuery.in("id", locationIds);
    requestsQuery = requestsQuery.in("location_id", locationIds);
  }

  const [locationsResult, headsResult, requestsResult] = await Promise.all([
    locationsQuery,
    headsQuery,
    requestsQuery
  ]);
  const error = locationsResult.error?.message || headsResult.error?.message || requestsResult.error?.message || null;
  const allRequests = (requestsResult.data ?? []) as PaymentRequestRow[];
  const visibleRequestIds = new Set([
    ...allRequests.slice(0, 20).map((request) => request.id),
    ...allRequests.filter((request) => request.requested_by === authorization.userId).map((request) => request.id)
  ]);
  // Which of the user's own open requests already have an approval at any level (blocks Cancel).
  const ownOpenIds = allRequests
    .filter((request) => request.requested_by === authorization.userId)
    .filter((request) => !["cancelled", "rejected", "processed", "processing", "approved"].includes(String(request.status ?? "").toLowerCase()))
    .map((request) => request.id);
  const approvedRequestIds = new Set<string>();
  if (ownOpenIds.length) {
    const approvals = await supabaseAdmin
      .from("payment_request_approvals")
      .select("payment_request_id, request_id")
      .eq("company_id", companyId)
      .eq("action", "approved")
      .or(`payment_request_id.in.(${ownOpenIds.join(",")}),request_id.in.(${ownOpenIds.join(",")})`);
    for (const row of (approvals.data ?? []) as Array<{ payment_request_id: string | null; request_id: string | null }>) {
      if (row.payment_request_id) approvedRequestIds.add(row.payment_request_id);
      if (row.request_id) approvedRequestIds.add(row.request_id);
    }
  }
  return {
    approvedRequestIds,
    heads: ((headsResult.data ?? []) as PaymentHeadRow[]).map((head) => ({
      ...head,
      payment_head_questions: questionsForStage(head.payment_head_questions, "expense")
        .concat(questionsForStage(head.payment_head_questions, "payment"))
    })),
    locations: (locationsResult.data ?? []) as LocationRow[],
    requests: allRequests.filter((request) => visibleRequestIds.has(request.id)),
    error
  };
}

async function loadReturnRemark(companyId: string, requestId: string) {
  if (!supabaseAdmin) return null;
  const admin = supabaseAdmin;

  const requestColumns = ["payment_request_id", "request_id"] as const;

  for (const requestColumn of requestColumns) {
    const result = await admin
      .from("payment_request_approvals")
      .select("action, comments, created_at")
      .eq("company_id", companyId)
      .eq(requestColumn, requestId)
      .order("created_at", { ascending: false })
      .limit(10);
    if (result.error) continue;

    const logs = ((result.data ?? []) as ApprovalRemarkRow[])
      .map((log) => ({
        action: String(log.action ?? ""),
        comments: String(log.comments ?? ""),
        created_at: String(log.created_at ?? "")
      }))
      .filter((log) => log.comments.trim());
    const returnLog = logs.find((log) => {
      const action = log.action.toLowerCase();
      const comments = log.comments.trim().toLowerCase();
      return action === "returned" || action === "rejected" || comments.startsWith("returned:");
    });
    if (returnLog) return returnLog as ApprovalRemarkRow;
  }

  return null;
}

function historyLabel(action: string) {
  const labels: Record<string, string> = {
    created: "Submitted",
    submitted: "Submitted",
    approved: "Approved",
    returned: "Returned",
    resubmitted: "Resubmitted",
    rejected: "Rejected",
    cancelled: "Cancelled",
    processing: "Sent for payment",
    processed: "Paid"
  };
  return labels[action] ?? (action ? action.replace(/_/g, " ") : "Update");
}

function CancelRequestPanel({ request, eligibility }: { request: PaymentRequestRow; eligibility: CancelEligibility }) {
  if (!eligibility.allowed) {
    return (
      <div className="payment-cancel-panel is-locked">
        <strong>Cancel request</strong>
        <p className="subtle">{eligibility.reason}</p>
      </div>
    );
  }
  return (
    <form action={cancelPaymentRequest} className="payment-cancel-panel">
      <input type="hidden" name="request_id" value={request.id} />
      <strong>Cancel request</strong>
      <p className="subtle">Use this if the request is a duplicate or no longer needed. It can&apos;t be undone.</p>
      <label>
        Reason for cancelling *
        <textarea className="field" maxLength={1000} name="cancel_reason" placeholder="e.g. Duplicate of an earlier request" required rows={2} />
      </label>
      <div className="form-actions">
        <SubmitButton
          className="button payment-cancel-button"
          confirmDescription={`${request.request_no} will be cancelled and removed from the approval queue. This can't be undone.`}
          confirmMessage="Cancel this payment request?"
          confirmSubmitText="Cancel request"
          confirmTitle="Cancel payment request"
          pendingText="Cancelling"
        >
          Cancel request
        </SubmitButton>
      </div>
    </form>
  );
}

export const dynamic = "force-dynamic";

export default async function PaymentRequestsPage({
  searchParams
}: {
  searchParams?: { bank?: string; paymentError?: string; paymentNotice?: string; resubmit?: string; view?: string };
}) {
  const authorization = await requirePagePermission("payment_requests", "access");
  const companyId = requireCompanyId(authorization);
  const pagePermission = authorization.permissions.payment_requests;
  const { approvedRequestIds, heads, locations, requests, error } = await loadPaymentRequestData(companyId, authorization);
  const cancelEligibility = (request: PaymentRequestRow) =>
    paymentRequestCancelEligibility(request, authorization.userId, approvedRequestIds.has(request.id));
  const savedContacts = await loadUserPaymentContacts(companyId, authorization.userId);
  const expenseActionCount = (await loadPaymentNotificationSnapshot(authorization)).badges.expense_requests ?? 0;
  const headById = new Map(heads.map((head) => [head.id, head]));
  const scopedLocationIds = new Set(authorization.locationScopeIds);
  const userEmail = authorization.email?.trim().toLowerCase() ?? "";
  const visibleLocations = authorization.hasAllLocationAccess
    ? locations
    : locations.filter((location) => {
        const locationEmail = location.station_email?.trim().toLowerCase();
        const managerEmail = location.station_manager_email?.trim().toLowerCase();
        return scopedLocationIds.has(location.id) ||
          Boolean(userEmail && (locationEmail === userEmail || managerEmail === userEmail));
      });
  const locationOptions = visibleLocations.map((location) => ({ value: location.id, label: location.station_code, helper: location.station_name ?? undefined }));
  const headOptions = heads.map((head) => ({ value: head.id, label: head.name, helper: head.code }));
  const bankRequest = searchParams?.bank
    ? requests.find((request) => request.id === searchParams.bank && canSubmitBankDetails(request, authorization.userId)) ?? null
    : null;
  const bankHead = bankRequest ? headById.get(bankRequest.payment_head_id) ?? null : null;
  const bankQuestions = questionsForStage(bankHead?.payment_head_questions, "payment");
  const resubmitRequest = searchParams?.resubmit
    ? requests.find((request) => request.id === searchParams.resubmit && isResubmittable(request, authorization.userId)) ?? null
    : null;
  const resubmitHead = resubmitRequest ? headById.get(resubmitRequest.payment_head_id) ?? null : null;
  const resubmitQuestions = questionsForStage(resubmitHead?.payment_head_questions, "payment");
  const answersResult = resubmitRequest && supabaseAdmin ? await supabaseAdmin
    .from("payment_request_answers")
    .select("id, question_id, answer_value, file_name, file_path, file_size, attachments")
    .eq("company_id", companyId)
    .eq("payment_request_id", resubmitRequest.id) : null;
  const returnRemark = resubmitRequest ? await loadReturnRemark(companyId, resubmitRequest.id) : null;
  const resubmitAnswers = (answersResult?.data ?? []) as AnswerRow[];
  const answerByQuestionId = new Map(resubmitAnswers.map((answer) => [answer.question_id, answer]));
  const returnRemarkText = returnRemark?.comments?.replace(/^returned:\s*/i, "").trim();

  const viewRequest = searchParams?.view && !resubmitRequest && !bankRequest
    ? requests.find((request) => request.id === searchParams.view) ?? null
    : null;
  const viewHead = viewRequest ? headById.get(viewRequest.payment_head_id) ?? null : null;
  const [viewAnswersResult, viewHistoryResult] = viewRequest && supabaseAdmin ? await Promise.all([
    supabaseAdmin
      .from("payment_request_answers")
      .select("id, question_id, answer_value, file_name, file_path")
      .eq("company_id", companyId)
      .eq("payment_request_id", viewRequest.id),
    supabaseAdmin
      .from("payment_request_approvals")
      .select("action, comments, created_at, approver_user_id, approver_role_id")
      .eq("company_id", companyId)
      .or(`payment_request_id.eq.${viewRequest.id},request_id.eq.${viewRequest.id}`)
      .order("created_at", { ascending: true })
  ]) : [null, null];
  const viewAnswers = (viewAnswersResult?.data ?? []) as AnswerRow[];
  const viewHistory = (viewHistoryResult?.data ?? []) as HistoryRow[];
  const viewFlow = viewRequest ? await loadApprovalFlow(companyId, viewRequest, viewHistory) : null;
  const viewQuestionText = new Map((viewHead?.payment_head_questions ?? []).map((question) => [question.id, question.question_text]));
  const viewCancel = viewRequest ? cancelEligibility(viewRequest) : null;
  const money = (value: number | null) => value == null ? "-" : `Rs ${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

  return (
    <AppShell active="Payment Requests" pageCode="payment_requests">
      <PageHead
        eyebrow="Payments"
        title="Payment Requests"
        subtitle="Lifecycle: request → approval → requester submits verified payout details → Finance processing → paid."
        action={<span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>{isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}</span>}
      />

      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Payment database setup needed</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{error} Run `scripts/payment_requests_v1.sql` in Supabase SQL Editor, then refresh.</p>
          </div>
        </section>
      ) : null}

      {searchParams?.paymentError || searchParams?.paymentNotice ? (
        <section className={`panel message-panel ${searchParams.paymentError ? "error" : "success"}`}>
          <div className="panel-body">
            <strong>{searchParams.paymentError ? "Payment request not saved" : "Payment request saved"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>
              {searchParams.paymentError ?? searchParams.paymentNotice}
            </p>
          </div>
        </section>
      ) : null}

      {!error && pagePermission.canAdd ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>New payment request</h2>
              <p className="subtle">Use this for payment heads that do not require expense approval.</p>
            </div>
            <PendingLink className="button secondary" href="/payments/expense-request">
              New expense request
              {expenseActionCount > 0 ? <span className="nav-badge">{expenseActionCount > 99 ? "99+" : expenseActionCount}</span> : null}
            </PendingLink>
          </div>
          <PaymentRequestForm
            action={createPaymentRequest}
            headOptions={headOptions}
            heads={heads.map((head) => ({ ...head, payment_head_questions: questionsForStage(head.payment_head_questions, "payment") }))}
            locationOptions={locationOptions}
            savedContacts={savedContacts}
          />
        </section>
      ) : null}

      {!error && pagePermission.canView ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Payment detail requests</h2>
              <p className="subtle">{requests.length} latest records</p>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Location</th>
                  <th>Payment Head</th>
                  <th>Estimated</th>
                  <th>Amount</th>
                  <th>Payment Method</th>
                  <th>Account Holder</th>
                  <th>Account / UPI ID</th>
                  <th>IFSC / Portal</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {requests.length ? requests.map((request) => {
                  const head = headById.get(request.payment_head_id);
                  return (
                    <tr key={request.id}>
                      <td><strong>{request.request_no}</strong>{request.adhoc_provider_employee_id ? <div><small>{request.adhoc_da_name} · {request.adhoc_provider_employee_id}<br />Work date: {request.adhoc_work_date}</small></div> : null}</td>
                      <td>{request.location_code}</td>
                      <td>{head?.name ?? "-"}</td>
                      <td>{request.amount_requested == null ? "-" : `Rs ${Number(request.amount_requested).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`}</td>
                      <td>{request.amount == null ? "-" : `Rs ${Number(request.amount).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`}</td>
                      <td>{request.payment_mode ? paymentModeLabel(request.payment_mode) : "-"}</td>
                      <td>{request.account_holder_name ?? "-"}</td>
                      <td>{request.payment_mode === "upi_payment" ? request.payment_reference ?? "-" : request.bank_account_no ?? "-"}</td>
                      <td>{request.payment_mode === "online_payment" ? request.payment_portal ?? "-" : request.ifsc ?? "-"}</td>
                      <td><StatusPill status={paymentLifecycleLabel(request, authorization.userId)} /></td>
                      <td>{formatDashboardDate(request.created_at)}</td>
                      <td>
                        <div className="payment-row-actions">
                          <PendingLink className="button secondary compact" href={`/payments/requests?view=${request.id}`} scroll={false}>View</PendingLink>
                          {pagePermission.canAdd && canSubmitBankDetails(request, authorization.userId) ? (
                            <PendingLink className="button compact" href={`/payments/requests?bank=${request.id}`} scroll={false}>Submit payout details</PendingLink>
                          ) : pagePermission.canAdd && isResubmittable(request, authorization.userId) ? (
                            <PendingLink className="button secondary compact" href={`/payments/requests?resubmit=${request.id}`} scroll={false}>Resubmit</PendingLink>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                }) : (
                  <tr><td className="empty-cell" colSpan={12}>No payment requests added yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {bankRequest ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide-modal" role="dialog" aria-modal="true" aria-labelledby="bank-payment-title">
            <div className="panel-head">
              <div>
                <h2 id="bank-payment-title">Submit payment details</h2>
                <p className="subtle">{bankRequest.request_no} - Enter actual amount and beneficiary bank details.</p>
              </div>
              <PendingLink className="icon-button" href="/payments/requests" scroll={false} aria-label="Close">x</PendingLink>
            </div>
            <form action={submitPaymentBankDetails} className="panel-body payment-resubmit-form" encType="multipart/form-data">
              <input type="hidden" name="request_id" value={bankRequest.id} />
              <div className="form-grid three">
                <label>
                  Location
                  <input className="field" value={bankRequest.location_code} readOnly />
                </label>
                <label>
                  Payment Head
                  <input className="field" value={bankHead?.name ?? "-"} readOnly />
                </label>
                <label>
                  Estimated Amount
                  <input className="field" value={bankRequest.amount_requested == null ? "-" : `Rs ${Number(bankRequest.amount_requested).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`} readOnly />
                </label>
                <label>
                  Actual Amount *
                  <input className="field" min="0" name="amount" placeholder="0.00" required step="0.01" type="number" defaultValue={bankRequest.amount_requested ?? ""} />
                </label>
              </div>
              <PaymentBeneficiaryFields
                allowedPaymentModes={bankHead?.supported_payment_modes}
                defaultBankAccountNo={bankRequest.bank_account_no}
                defaultContactNo={bankRequest.contact_no}
                defaultEmail={bankRequest.email}
                defaultIfsc={bankRequest.ifsc}
                savedContacts={savedContacts}
              />
              {bankHead?.code === "ADHOC_DA" && bankRequest.location_id ? <AdhocDaFields locationId={bankRequest.location_id} /> : null}
              {bankQuestions.length ? (
                <>
                  <div className="section-divider" />
                  <div className="form-grid two">
                    {bankQuestions.map((question) => {
                      const questionLabel = question.question_text.toLowerCase();
                      const isWideField = question.answer_type === "textarea" || questionLabel.includes("mail subject") || questionLabel.includes("subject");
                      return (
                        <label key={question.id} className={isWideField ? "span-2" : undefined}>
                          {question.question_text}{question.is_required ? " *" : ""}
                          <input type="hidden" name="question_ids" value={question.id} />
                          {resubmitInputForQuestion(question)}
                        </label>
                      );
                    })}
                  </div>
                </>
              ) : null}
              <label className="payment-resubmit-remarks">
                Remarks
                <textarea className="field" name="remarks" rows={3} defaultValue={bankRequest.remarks ?? ""} />
              </label>
              <div className="form-actions modal-actions">
                <PendingLink className="button secondary" href="/payments/requests" scroll={false}>Cancel</PendingLink>
                <SubmitButton pendingText="Submitting">Submit details</SubmitButton>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {resubmitRequest && resubmitHead ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide-modal" role="dialog" aria-modal="true" aria-labelledby="resubmit-payment-title">
            <div className="panel-head">
              <div>
                <h2 id="resubmit-payment-title">Resubmit payment request</h2>
                <p className="subtle">{resubmitRequest.request_no} - Make corrections and add remarks before resubmitting.</p>
              </div>
              <PendingLink className="icon-button" href="/payments/requests" scroll={false} aria-label="Close">x</PendingLink>
            </div>
            <form action={resubmitPaymentRequest} className="panel-body payment-resubmit-form" encType="multipart/form-data">
              <input type="hidden" name="request_id" value={resubmitRequest.id} />
              {returnRemark && returnRemarkText ? (
                <div className="payment-return-remarks">
                  <div>
                    <strong>Return remarks:</strong>
                    <span>{formatDashboardDateTime(returnRemark.created_at)}</span>
                  </div>
                  <p>{returnRemarkText}</p>
                </div>
              ) : (
                <div className="payment-return-remarks">
                  <div>
                    <strong>Return remarks:</strong>
                  </div>
                  <p>No return remarks were saved for this request.</p>
                </div>
              )}
              <div className="form-grid three">
                <label>
                  Location
                  <input className="field" value={resubmitRequest.location_code} readOnly />
                </label>
                <label>
                  Payment Head
                  <input className="field" value={resubmitHead.name} readOnly />
                </label>
                <label>
                  Amount *
                  <input className="field" min="0" name="amount" placeholder="0.00" required step="0.01" type="number" defaultValue={resubmitRequest.amount ?? ""} />
                </label>
              </div>
              <PaymentBeneficiaryFields
                allowedPaymentModes={resubmitHead.supported_payment_modes}
                defaultAccountHolderName={resubmitRequest.account_holder_name}
                defaultBankAccountNo={resubmitRequest.payment_mode === "account_transfer" ? resubmitRequest.bank_account_no : null}
                defaultContactNo={resubmitRequest.contact_no}
                defaultEmail={resubmitRequest.email}
                defaultIfsc={resubmitRequest.payment_mode === "account_transfer" ? resubmitRequest.ifsc : null}
                defaultPaymentMode={resubmitRequest.payment_mode}
                defaultUpiId={resubmitRequest.payment_mode === "upi_payment" ? resubmitRequest.payment_reference : null}
                savedContacts={savedContacts}
              />

              {resubmitQuestions.length ? (
                <>
                  <div className="section-divider" />
                  <div className="form-grid two">
                    {resubmitQuestions.map((question) => {
                      const questionLabel = question.question_text.toLowerCase();
                      const isWideField = question.answer_type === "textarea" || questionLabel.includes("mail subject") || questionLabel.includes("subject");
                      return (
                        <label key={question.id} className={isWideField ? "span-2" : undefined}>
                          {question.question_text}{question.is_required ? " *" : ""}
                          <input type="hidden" name="question_ids" value={question.id} />
                          {resubmitInputForQuestion(question, answerByQuestionId.get(question.id))}
                        </label>
                      );
                    })}
                  </div>
                </>
              ) : null}

              <div className="section-divider" />
              <label className="payment-resubmit-remarks">
                Resubmission remarks *
                <textarea className="field" name="remarks" rows={5} required defaultValue={resubmitRequest.remarks ?? ""} />
              </label>
              <div className="form-actions modal-actions">
                <PendingLink className="button secondary" href="/payments/requests" scroll={false}>Cancel</PendingLink>
                <SubmitButton pendingText="Resubmitting">Resubmit request</SubmitButton>
              </div>
            </form>
            <div className="panel-body payment-cancel-wrap">
              <CancelRequestPanel eligibility={cancelEligibility(resubmitRequest)} request={resubmitRequest} />
            </div>
          </section>
        </div>
      ) : null}

      {viewRequest ? (
        <div className="modal-backdrop">
          <section className="modal-panel payment-view-modal" role="dialog" aria-modal="true" aria-labelledby="view-payment-title">
            <header className="payment-view-header">
              <div>
                <span className="payment-view-eyebrow">Payment request</span>
                <h2 id="view-payment-title">{viewRequest.request_no}</h2>
                <p>{viewRequest.location_code} · {viewHead?.name ?? "Payment"} · Submitted {formatDashboardDateTime(viewRequest.created_at)}</p>
              </div>
              <div className="payment-view-header-side">
                <StatusPill status={paymentLifecycleLabel(viewRequest, authorization.userId)} />
                <PendingLink className="icon-button" href="/payments/requests" scroll={false} aria-label="Close">x</PendingLink>
              </div>
            </header>

            <div className="payment-view-amounts">
              <div><span>Estimated</span><strong>{money(viewRequest.amount_requested)}</strong></div>
              <div><span>Amount</span><strong>{money(viewRequest.amount)}</strong></div>
              <div><span>Payment method</span><strong>{viewRequest.payment_mode ? paymentModeLabel(viewRequest.payment_mode) : "-"}</strong></div>
            </div>

            <div className="payment-view-layout">
              <div className="payment-view-main">
                {viewFlow ? (() => {
                  const pending = viewFlow.steps.find((step) => step.state === "current");
                  return (
                    <section className="payment-view-card">
                      <h3>Approval flow</h3>
                      {pending ? (
                        <p className="payment-flow-pending">
                          Pending at <strong>{pending.label}</strong> · with <strong>{pending.pendingWith ?? pending.rolesText}</strong>
                        </p>
                      ) : null}
                      <ol className="payment-flow">
                        {viewFlow.steps.map((step) => (
                          <li className={`is-${step.state}`} key={step.key}>
                            <span className="payment-flow-marker" aria-hidden="true">{step.state === "done" ? "✓" : ""}</span>
                            <div>
                              <strong>{step.label}</strong>
                              <span className="payment-flow-roles">{step.rolesText}</span>
                              <span className="payment-flow-state">
                                {step.state === "done"
                                  ? step.key === "finance"
                                    ? "Paid"
                                    : `Approved${step.approvedBy ? ` by ${step.approvedBy}` : ""}${step.approvedAt ? ` · ${formatDashboardDateTime(step.approvedAt)}` : ""}`
                                  : step.state === "current"
                                    ? `Pending with ${step.pendingWith ?? step.rolesText}`
                                    : step.state === "returned"
                                      ? "Returned to requester"
                                      : step.state === "stopped"
                                        ? String(viewRequest.status ?? "").toLowerCase() === "rejected" ? "Rejected here" : "Cancelled"
                                        : "Upcoming"}
                              </span>
                            </div>
                          </li>
                        ))}
                      </ol>
                    </section>
                  );
                })() : null}

                <section className="payment-view-card">
                  <h3>Beneficiary</h3>
                  <dl>
                    <div><dt>Account holder</dt><dd>{viewRequest.account_holder_name ?? "-"}</dd></div>
                    <div><dt>{viewRequest.payment_mode === "upi_payment" ? "UPI ID" : "Account number"}</dt><dd>{viewRequest.payment_mode === "upi_payment" ? viewRequest.payment_reference ?? "-" : viewRequest.bank_account_no ?? "-"}</dd></div>
                    {viewRequest.payment_mode === "upi_payment" ? null : (
                      <div><dt>{viewRequest.payment_mode === "online_payment" ? "Portal" : "IFSC"}</dt><dd>{viewRequest.payment_mode === "online_payment" ? viewRequest.payment_portal ?? "-" : viewRequest.ifsc ?? "-"}</dd></div>
                    )}
                    <div><dt>Contact</dt><dd>{viewRequest.contact_no || "-"}</dd></div>
                    <div><dt>Email</dt><dd>{viewRequest.email || "-"}</dd></div>
                    {viewRequest.adhoc_provider_employee_id ? <div><dt>Adhoc DA</dt><dd>{viewRequest.adhoc_da_name} · {viewRequest.adhoc_provider_employee_id}</dd></div> : null}
                  </dl>
                </section>

                <section className="payment-view-card">
                  <h3>Submitted details</h3>
                  <dl>
                    {viewAnswers.map((answer) => (
                      <div key={answer.id}>
                        <dt>{viewQuestionText.get(answer.question_id) ?? "Answer"}</dt>
                        <dd>
                          {answer.file_name ? (
                            <a className="payment-view-file" href={`/api/payments/requests/attachment?answer_id=${encodeURIComponent(answer.id)}`} rel="noreferrer" target="_blank">{answer.file_name}</a>
                          ) : answer.answer_value || "-"}
                        </dd>
                      </div>
                    ))}
                    <div className="is-wide"><dt>Remarks</dt><dd>{viewRequest.remarks || "-"}</dd></div>
                  </dl>
                </section>
              </div>

              <aside className="payment-view-side">
                <section className="payment-view-card">
                  <h3>History</h3>
                  {viewHistory.length ? (
                    <ol className="payment-view-timeline">
                      {viewHistory.map((entry, index) => {
                        const action = String(entry.action ?? "").toLowerCase();
                        return (
                          <li className={`is-${action}`} key={`${entry.created_at}-${index}`}>
                            <strong>{historyLabel(action)}</strong>
                            <span>
                              {entry.approver_user_id && viewFlow?.personName.get(entry.approver_user_id) ? `${viewFlow.personName.get(entry.approver_user_id)} · ` : ""}
                              {formatDashboardDateTime(entry.created_at)}
                            </span>
                            {entry.comments ? <p>{entry.comments.replace(/^returned:\s*/i, "")}</p> : null}
                          </li>
                        );
                      })}
                    </ol>
                  ) : <p className="subtle">No approval activity yet.</p>}
                </section>
                {pagePermission.canAdd && viewRequest.requested_by === authorization.userId && viewCancel ? (
                  <CancelRequestPanel eligibility={viewCancel} request={viewRequest} />
                ) : null}
              </aside>
            </div>
          </section>
        </div>
      ) : null}
    </AppShell>
  );
}
