import { AppShell } from "@/components/app-shell";
import { PaymentProcessPanel } from "@/components/payment-process-panel";
import { finalizePaymentProcess, updatePaymentProcessStatus } from "@/app/payments/process/actions";
import { isCompanyOwner, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { dashboardDateInputValue } from "@/lib/date-format";
import { supabaseAdmin } from "@/lib/supabase-admin";

type PaymentBankRow = {
  id: string;
  bank_code: string;
  display_name: string;
  account_no: string;
  ifsc: string;
  is_active: boolean;
};

type PaymentRequestRow = {
  id: string;
  request_no: string;
  location_code: string;
  location_name?: string | null;
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
  requested_by: string | null;
  processed_at: string | null;
  status: string;
  approval_status: string | null;
  current_approver_user_id: string | null;
  current_approver_role_id: string | null;
  created_at: string;
  payment_heads?: { name: string; code: string } | null;
  payment_details?: Array<{ id: string; label: string; value: string | null; file_name: string | null }>;
  payment_history?: PaymentHistoryRow[];
};

type PaymentApprovalRow = {
  id: string;
  payment_request_id: string;
  action: string;
  comments: string | null;
  created_at: string;
  approver_user_id: string | null;
  approver_role_id: string | null;
};

type PaymentHistoryRow = {
  id: string;
  action: string;
  actor: string;
  role: string;
  comments: string | null;
  created_at: string;
};

type PaymentAnswerRow = {
  id: string;
  payment_request_id: string;
  answer_value: string | null;
  file_name: string | null;
  payment_head_questions?: { question_text: string; sort_order: number | null } | Array<{ question_text: string; sort_order: number | null }> | null;
};

const PROCESS_DETAIL_BATCH_SIZE = 50;

function chunkValues<T>(values: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function firstRelation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function isReadyForPaymentProcess(request: PaymentRequestRow) {
  const status = String(request.status ?? "").toUpperCase();
  const approvalStatus = String(request.approval_status ?? "").toUpperCase();
  const hasCurrentApprover = Boolean(request.current_approver_user_id || request.current_approver_role_id);
  const isOnlinePayment = (request.payment_mode ?? "account_transfer") === "online_payment";
  const isUpiPayment = request.payment_mode === "upi_payment";
  const hasPaymentDetails = isOnlinePayment
    ? Boolean(request.amount != null && request.payment_portal?.trim())
    : isUpiPayment
      ? Boolean(request.amount != null && request.payment_reference?.trim())
    : Boolean(
      request.amount != null &&
      request.bank_account_no?.trim() &&
      request.ifsc?.trim() &&
      request.account_holder_name?.trim()
    );
  return hasPaymentDetails && (status === "APPROVED" ||
    status === "RE_APPROVED" ||
    status === "PROCESSING" ||
    status === "PROCESSED" ||
    status === "OWNER_APPROVED" ||
    approvalStatus === "PROCESSING" ||
    approvalStatus === "PROCESSED" ||
    approvalStatus === "OWNER_APPROVED" ||
    approvalStatus === "RE_APPROVED" ||
    (approvalStatus.endsWith("_APPROVED") && !hasCurrentApprover));
}

async function loadPaymentProcess(companyId: string, userId: string | null, roleId: string | null, canSeeAllFinalApproved: boolean) {
  if (!supabaseAdmin) {
    return {
      banks: [] as PaymentBankRow[],
      requests: [] as PaymentRequestRow[],
      error: "Supabase service role key is not configured."
    };
  }
  if (!roleId && !canSeeAllFinalApproved) {
    return { banks: [] as PaymentBankRow[], requests: [] as PaymentRequestRow[], error: "Payment process role is not available." };
  }
  const admin = supabaseAdmin;

  let requestsQuery = supabaseAdmin
    .from("payment_requests")
    .select("id, request_no, location_code, payment_head_id, amount, amount_requested, payment_mode, payment_portal, payment_reference, bank_account_no, ifsc, account_holder_name, contact_no, email, remarks, requested_by, processed_at, status, approval_status, current_approver_user_id, current_approver_role_id, created_at, payment_heads ( name, code )")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false });

  if (!canSeeAllFinalApproved && roleId) {
    requestsQuery = requestsQuery.contains("payment_process_role_ids", [roleId]);
  }

  const [banksResult, requestsResult] = await Promise.all([
    supabaseAdmin
      .from("payment_banks")
      .select("id, bank_code, display_name, account_no, ifsc, is_active")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("display_name"),
    requestsQuery
  ]);

  const error = banksResult.error?.message || requestsResult.error?.message || null;
  if (error) return { banks: [] as PaymentBankRow[], requests: [] as PaymentRequestRow[], error };
  const requestRows = ((requestsResult.data ?? []) as unknown as PaymentRequestRow[])
    .filter(isReadyForPaymentProcess)
    .filter((request) => String(request.approval_status ?? "").toUpperCase() !== "RE_APPROVED" || request.current_approver_user_id === userId);
  const requestIds = requestRows.map((request) => request.id);
  const requestIdBatches = chunkValues(requestIds, PROCESS_DETAIL_BATCH_SIZE);
  const [answerBatchResults, approvalBatchResults] = requestIds.length ? await Promise.all([
    Promise.all(requestIdBatches.map((batch) => admin
      .from("payment_request_answers")
      .select("id, payment_request_id, answer_value, file_name, payment_head_questions ( question_text, sort_order )")
      .eq("company_id", companyId)
      .in("payment_request_id", batch))),
    Promise.all(requestIdBatches.map((batch) => admin
      .from("payment_request_approvals")
      .select("id, payment_request_id, action, comments, created_at, approver_user_id, approver_role_id")
      .eq("company_id", companyId)
      .in("payment_request_id", batch)
      .order("created_at", { ascending: true })))
  ]) : [[], []];
  const answersResult = {
    data: answerBatchResults.flatMap((result) => result.data ?? []),
    error: answerBatchResults.find((result) => result.error)?.error ?? null
  };
  const approvalsResult = {
    data: approvalBatchResults.flatMap((result) => result.data ?? []),
    error: approvalBatchResults.find((result) => result.error)?.error ?? null
  };
  const relatedError = answersResult.error?.message || approvalsResult.error?.message;
  if (relatedError) return { banks: [] as PaymentBankRow[], requests: [] as PaymentRequestRow[], error: relatedError };
  const detailsByRequest = new Map<string, PaymentRequestRow["payment_details"]>();
  ((answersResult.data ?? []) as unknown as PaymentAnswerRow[])
    .sort((a, b) => Number(firstRelation(a.payment_head_questions)?.sort_order ?? 0) - Number(firstRelation(b.payment_head_questions)?.sort_order ?? 0))
    .forEach((answer) => {
      const details = detailsByRequest.get(answer.payment_request_id) ?? [];
      details.push({
        id: answer.id,
        label: firstRelation(answer.payment_head_questions)?.question_text ?? "Field",
        value: answer.answer_value,
        file_name: answer.file_name
      });
      detailsByRequest.set(answer.payment_request_id, details);
    });
  const approvalRows = (approvalsResult.data ?? []) as PaymentApprovalRow[];
  const profileIds = Array.from(new Set([
    ...requestRows.map((request) => request.requested_by),
    ...approvalRows.map((approval) => approval.approver_user_id)
  ].filter(Boolean))) as string[];
  const roleIds = Array.from(new Set(approvalRows.map((approval) => approval.approver_role_id).filter(Boolean))) as string[];
  const locationCodes = Array.from(new Set(requestRows.map((request) => request.location_code).filter(Boolean)));
  const [profilesResult, rolesResult, locationsResult] = await Promise.all([
    profileIds.length ? supabaseAdmin.from("profiles").select("id, full_name, email").eq("company_id", companyId).in("id", profileIds) : { data: [], error: null },
    roleIds.length ? supabaseAdmin.from("user_roles").select("id, name, code").eq("company_id", companyId).in("id", roleIds) : { data: [], error: null },
    locationCodes.length ? supabaseAdmin.from("stations").select("station_code, station_name, city").eq("company_id", companyId).in("station_code", locationCodes) : { data: [], error: null }
  ]);
  const identityError = profilesResult.error?.message || rolesResult.error?.message || locationsResult.error?.message;
  if (identityError) return { banks: [] as PaymentBankRow[], requests: [] as PaymentRequestRow[], error: identityError };
  const profilesById = new Map((profilesResult.data ?? []).map((profile) => [profile.id, profile]));
  const rolesById = new Map((rolesResult.data ?? []).map((role) => [role.id, role]));
  const locationsByCode = new Map((locationsResult.data ?? []).map((location) => [location.station_code, location.station_name || location.city || null]));
  const approvalsByRequest = new Map<string, PaymentApprovalRow[]>();
  approvalRows.forEach((approval) => {
    const rows = approvalsByRequest.get(approval.payment_request_id) ?? [];
    rows.push(approval);
    approvalsByRequest.set(approval.payment_request_id, rows);
  });
  return {
    banks: (banksResult.data ?? []) as PaymentBankRow[],
    requests: requestRows.map((request) => ({
        ...request,
        location_name: locationsByCode.get(request.location_code) ?? null,
        payment_heads: firstRelation(request.payment_heads),
        payment_details: detailsByRequest.get(request.id) ?? [],
        payment_history: (() => {
          const approvalHistory = approvalsByRequest.get(request.id) ?? [];
          const requester = request.requested_by ? profilesById.get(request.requested_by) : null;
          const history: PaymentHistoryRow[] = approvalHistory.map((approval) => {
            const actor = approval.approver_user_id ? profilesById.get(approval.approver_user_id) : null;
            const role = approval.approver_role_id ? rolesById.get(approval.approver_role_id) : null;
            const roleLabel = role?.name ?? role?.code ?? (approval.action.toLowerCase() === "created" ? "Requester" : "-");
            const locationLabel = `${request.location_code}${locationsByCode.get(request.location_code) ? ` - ${locationsByCode.get(request.location_code)}` : ""}`;
            const isLocationEntry = String(role?.code || role?.name || "").trim().toLowerCase() === "location";
            return {
              id: approval.id,
              action: approval.action,
              actor: isLocationEntry ? locationLabel : actor?.full_name ?? actor?.email ?? "System",
              role: roleLabel,
              comments: approval.comments,
              created_at: approval.created_at
            };
          });
          if (!history.some((entry) => entry.action.toLowerCase() === "created")) {
            history.unshift({
              id: `created-${request.id}`,
              action: "created",
              actor: requester?.full_name ?? requester?.email ?? request.location_code,
              role: "Requester",
              comments: request.remarks || "Payment request created.",
              created_at: request.created_at
            });
          }
          if (request.processed_at && !history.some((entry) => entry.action.toLowerCase() === "processed")) {
            history.push({
              id: `processed-${request.id}`,
              action: "processed",
              actor: "System",
              role: "Payment processing",
              comments: "Payment processing completed.",
              created_at: request.processed_at
            });
          }
          return history.sort((first, second) => new Date(first.created_at).getTime() - new Date(second.created_at).getTime());
        })()
      })),
    error: null
  };
}

export const dynamic = "force-dynamic";

export default async function PaymentProcessPage({
  searchParams
}: {
  searchParams?: { processError?: string; processNotice?: string };
}) {
  const authorization = await requirePagePermission("payment_process", "access");
  const companyId = requireCompanyId(authorization);
  const pagePermission = authorization.permissions.payment_process;
  const canSeeAllFinalApproved = isCompanyOwner(authorization);
  const { banks, requests, error } = await loadPaymentProcess(companyId, authorization.userId, authorization.roleId, canSeeAllFinalApproved);
  const today = dashboardDateInputValue();

  return (
    <AppShell active="Payment Process" pageCode="payment_process">
      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Payment process setup needed</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{error} Run `scripts/payment_banks_v1.sql` and `scripts/payment_requests_v1.sql` in Supabase SQL Editor, then refresh.</p>
          </div>
        </section>
      ) : null}

      {searchParams?.processError || searchParams?.processNotice ? (
        <section className={`panel message-panel ${searchParams.processError ? "error" : "success"}`}>
          <div className="panel-body">
            <strong>{searchParams.processError ? "Payment process not finalized" : "Payment process finalized"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{searchParams.processError || searchParams.processNotice}</p>
          </div>
        </section>
      ) : null}

      {!error && pagePermission.canView ? (
        <PaymentProcessPanel
          banks={banks.map((bank) => ({
            id: bank.id,
            bank_code: bank.bank_code,
            display_name: bank.display_name,
            account_no: bank.account_no
          }))}
          requests={requests.map((request) => ({
            id: request.id,
            request_no: request.request_no,
            location_code: request.location_code,
            location_name: request.location_name ?? null,
            amount: request.amount,
            amount_requested: request.amount_requested,
            payment_mode: request.payment_mode,
            payment_portal: request.payment_portal,
            payment_reference: request.payment_reference,
            bank_account_no: request.bank_account_no,
            ifsc: request.ifsc,
            account_holder_name: request.account_holder_name,
            contact_no: request.contact_no,
            email: request.email,
            request_remarks: request.remarks,
            payment_details: request.payment_details ?? [],
            payment_history: request.payment_history ?? [],
            status: request.status,
            approval_status: request.approval_status,
            created_at: request.created_at,
            payment_head_name: request.payment_heads?.name ?? null
          }))}
          finalizeAction={finalizePaymentProcess}
          finalizeResultKey={searchParams?.processError || searchParams?.processNotice || ""}
          processAction={updatePaymentProcessStatus}
          today={today}
        />
      ) : null}
    </AppShell>
  );
}
