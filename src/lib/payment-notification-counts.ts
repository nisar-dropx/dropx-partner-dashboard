import { hasPermission, isCompanyOwner, type AuthorizationContext } from "@/lib/authorization";
import { currentAccessSurface } from "@/lib/access-surface";
import { canAccessPaymentLocation } from "@/lib/payment-approval-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadPeopleExceptionCount } from "@/lib/people-exception-count";

export type PaymentNotificationItem = {
  key: string;
  label: string;
  detail: string;
  href: string;
  count: number;
};

export type PaymentNotificationSnapshot = {
  total: number;
  badges: Record<string, number>;
  items: PaymentNotificationItem[];
};

type PaymentHeadRelation = {
  code: string | null;
  name: string | null;
};

type PaymentNotificationRequest = {
  id: string;
  request_no: string | null;
  location_id: string | null;
  location_code: string | null;
  requested_by: string | null;
  category: string | null;
  amount: number | null;
  amount_requested: number | null;
  payment_mode: string | null;
  payment_portal: string | null;
  payment_reference: string | null;
  bank_account_no: string | null;
  ifsc: string | null;
  account_holder_name: string | null;
  status: string | null;
  approval_status: string | null;
  current_approver_user_id: string | null;
  current_approver_role_id: string | null;
  current_approver_role_ids: string[] | null;
  payment_process_role_ids: string[] | null;
  created_at: string | null;
  payment_heads?: PaymentHeadRelation | PaymentHeadRelation[] | null;
};

const EMPTY_BADGES = {
  people_review: 0,
  people_exceptions: 0,
  payments: 0,
  expense_requests: 0,
  payment_requests: 0,
  payment_approvals: 0,
  payment_process: 0,
  payment_reports: 0
};

const CLOSED_STATUSES = new Set(["APPROVED", "REJECTED", "RETURNED", "CANCELLED", "PROCESSING", "PROCESSED"]);

export function emptyPaymentNotificationSnapshot(): PaymentNotificationSnapshot {
  return {
    total: 0,
    badges: { ...EMPTY_BADGES },
    items: []
  };
}

function normalizeStatus(value: string | null | undefined) {
  return String(value ?? "").trim().toUpperCase();
}

function requestStatus(request: PaymentNotificationRequest) {
  return normalizeStatus(request.approval_status || request.status);
}

function isExpenseRequest(request: PaymentNotificationRequest) {
  return normalizeStatus(request.category) === "EXPENSE";
}

function isReturned(request: PaymentNotificationRequest) {
  return requestStatus(request) === "RETURNED";
}

function hasCurrentApprover(request: PaymentNotificationRequest) {
  return Boolean(request.current_approver_user_id || request.current_approver_role_id || request.current_approver_role_ids?.length);
}

function isFinalApproved(request: PaymentNotificationRequest) {
  const status = requestStatus(request);
  return (
    status === "APPROVED" ||
    status === "OWNER_APPROVED" ||
    status === "RE_APPROVED" ||
    (status.endsWith("_APPROVED") && !hasCurrentApprover(request))
  );
}

function hasPaymentDetails(request: PaymentNotificationRequest) {
  const mode = normalizeStatus(request.payment_mode || "account_transfer");
  if (request.amount === null || request.amount === undefined) return false;
  if (mode === "ONLINE" || mode === "ONLINE_PAYMENT") return Boolean(request.payment_portal?.trim());
  if (mode === "UPI" || mode === "UPI_PAYMENT") return Boolean(request.payment_reference?.trim());
  return Boolean(request.bank_account_no?.trim() && request.ifsc?.trim() && request.account_holder_name?.trim());
}

function needsPaymentDetails(request: PaymentNotificationRequest) {
  return isExpenseRequest(request) && isFinalApproved(request) && !hasPaymentDetails(request);
}

function isPendingApproval(request: PaymentNotificationRequest) {
  const status = requestStatus(request);
  if (status === "RE_APPROVED") return false;
  if (CLOSED_STATUSES.has(status)) return false;
  return Boolean(request.current_approver_user_id || request.current_approver_role_id || request.current_approver_role_ids?.length || status === "PENDING" || !status);
}

function isReadyForPaymentProcess(request: PaymentNotificationRequest) {
  return isFinalApproved(request) && hasPaymentDetails(request) && requestStatus(request) !== "PROCESSED";
}

function canProcessPayment(request: PaymentNotificationRequest, authorization: AuthorizationContext) {
  if (isCompanyOwner(authorization) || authorization.isMasterOwner) return true;
  if (!authorization.roleId) return false;
  return (request.payment_process_role_ids ?? []).includes(authorization.roleId);
}

function addItem(items: PaymentNotificationItem[], key: string, label: string, detail: string, href: string, count: number) {
  if (count <= 0) return;
  items.push({ key, label, detail, href, count });
}

function isAssignedToCurrentUser(request: PaymentNotificationRequest, authorization: AuthorizationContext) {
  if (!canAccessPaymentLocation(authorization, request.location_id)) return false;
  if (request.current_approver_user_id === authorization.userId) return true;
  if (!authorization.roleId) return false;
  return request.current_approver_role_id === authorization.roleId ||
    (request.current_approver_role_ids ?? []).includes(authorization.roleId);
}

async function loadPeopleReviewCount(authorization: AuthorizationContext) {
  if (!supabaseAdmin || !authorization.companyId || !hasPermission(authorization, "people_review", "access")) return 0;
  if (!authorization.hasAllLocationAccess && !authorization.isMasterOwner && authorization.locationScopeIds.length === 0) return 0;

  const sources = [
    { table: "employees", statusColumn: "profile_completion_status" },
    { table: "field_executives", statusColumn: "onboarding_status" },
    { table: "contractors", statusColumn: "onboarding_status" },
    { table: "vendors", statusColumn: "onboarding_status" },
    { table: "workers", statusColumn: "onboarding_status" }
  ];
  const results = await Promise.all(sources.map(async ({ table, statusColumn }) => {
    let query = supabaseAdmin!
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("company_id", authorization.companyId!)
      .eq(statusColumn, "under_review");
    if (!authorization.hasAllLocationAccess && !authorization.isMasterOwner) {
      query = query.in("location_id", authorization.locationScopeIds);
    }
    const result = await query;
    return result.error ? 0 : result.count ?? 0;
  }));

  return results.reduce((total, count) => total + count, 0);
}

export async function loadPaymentNotificationSnapshot(authorization: AuthorizationContext): Promise<PaymentNotificationSnapshot> {
  if (!authorization.companyId) return emptyPaymentNotificationSnapshot();

  const accessSurface = currentAccessSurface();
  const badges = { ...EMPTY_BADGES };
  const items: PaymentNotificationItem[] = [];
  badges.people_review = await loadPeopleReviewCount(authorization);
  badges.people_exceptions = await loadPeopleExceptionCount(authorization);
  const canSeePayments = hasPermission(authorization, "payments", "access");
  if (!canSeePayments || !supabaseAdmin) return { total: 0, badges, items };

  const { data, error } = await supabaseAdmin
    .from("payment_requests")
    .select(`
      id,
      request_no,
      location_id,
      location_code,
      requested_by,
      category,
      amount,
      amount_requested,
      payment_mode,
      payment_portal,
      payment_reference,
      bank_account_no,
      ifsc,
      account_holder_name,
      status,
      approval_status,
      current_approver_user_id,
      current_approver_role_id,
      current_approver_role_ids,
      payment_process_role_ids,
      created_at,
      payment_heads (
        code,
        name
      )
    `)
    .eq("company_id", authorization.companyId)
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error || !data) return { total: 0, badges, items };

  const requests = data as PaymentNotificationRequest[];
  const ownRequests = authorization.userId
    ? requests.filter((request) => request.requested_by === authorization.userId)
    : [];

  if (hasPermission(authorization, "expense_requests", "access")) {
    badges.expense_requests = ownRequests
      .filter(isExpenseRequest)
      .filter((request) => isReturned(request) || needsPaymentDetails(request))
      .length;
    addItem(
      items,
      "expense_requests",
      "Expense requests",
      `${badges.expense_requests} expense request${badges.expense_requests === 1 ? "" : "s"} need attention`,
      "/payments/expense-request",
      badges.expense_requests
    );
  }

  if (hasPermission(authorization, "payment_requests", "access")) {
    badges.payment_requests = ownRequests
      .filter((request) => !isExpenseRequest(request))
      .filter(isReturned)
      .length;
    addItem(
      items,
      "payment_requests",
      "Payment requests",
      `${badges.payment_requests} payment request${badges.payment_requests === 1 ? "" : "s"} returned for action`,
      "/payments/requests",
      badges.payment_requests
    );
  }

  if (hasPermission(authorization, "payment_approvals", "access")) {
    badges.payment_approvals = requests
      .filter((request) => isAssignedToCurrentUser(request, authorization))
      .filter(isPendingApproval)
      .length;
    addItem(
      items,
      "payment_approvals",
      "Payment approvals",
      `${badges.payment_approvals} request${badges.payment_approvals === 1 ? "" : "s"} waiting for approval`,
      "/payments/approvals",
      badges.payment_approvals
    );
  }

  if (accessSurface === "dashboard" && hasPermission(authorization, "payment_process", "access")) {
    badges.payment_process = requests
      .filter((request) => canProcessPayment(request, authorization))
      .filter(isReadyForPaymentProcess)
      .length;
    addItem(
      items,
      "payment_process",
      "Payment process",
      `${badges.payment_process} approved payment${badges.payment_process === 1 ? "" : "s"} ready to process`,
      "/payments/process",
      badges.payment_process
    );
  }

  badges.payments = badges.expense_requests + badges.payment_requests + badges.payment_approvals + badges.payment_process;

  return {
    total: badges.payments,
    badges,
    items
  };
}
