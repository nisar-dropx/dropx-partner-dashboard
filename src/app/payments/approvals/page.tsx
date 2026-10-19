import { isPendingPaymentApproval } from '@/lib/payment-pending-approval';
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PaymentApprovalFilters, type PaymentApprovalFilterOption } from "@/components/payment-approval-filters";
import { PaymentApprovalReviewLauncher, type PaymentApprovalReviewSummary } from "@/components/payment-approval-review-launcher";
import { PendingLink } from "@/components/pending-link";
import { StatusPill } from "@/components/status-pill";
import { hasPermission, requirePagePermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDate, formatDashboardDateTime } from "@/lib/date-format";
import { canOverseePayment, paymentPendingAge } from "@/lib/payment-oversight-policy";
import { readAllRows } from "@/lib/supabase-pagination";
import { getPaymentApprovalEligibility } from "@/lib/payment-approval-scope";
import { paymentApprovalAmount } from "@/lib/payment-approval-amount";
import {
  matchesPaymentApprovalFacets,
  paymentApprovalDateKey,
  selectedPaymentApprovalValues,
  type PaymentApprovalFacetSelection
} from "@/lib/payment-approval-filtering";
import { isResubmittedPaymentStage, paymentApprovalStatusTone, paymentStatusLabel } from "@/lib/payment-status-label";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";
import { DATABASE_UNREACHABLE_MESSAGE } from "@/lib/timeout-fetch";

type RequestRow = {
  id: string;
  request_no: string;
  location_id: string | null;
  location_code: string;
  location_model_id?: string | null;
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
  current_step_order: number | null;
  total_steps: number | null;
  created_at: string;
  updated_at: string | null;
  approval_pending_since: string | null;
  approval_routing_reason: string | null;
  currentOwner?: string;
  currentRole?: string;
  processed_at: string | null;
  payment_heads?: { name: string; code: string } | null;
  profiles?: { full_name: string | null; email: string | null } | null;
  stations?: { location_model_id: string | null } | null;
};

const NO_LOCATION_SCOPE_ID = "00000000-0000-0000-0000-000000000000";

type ApprovalSearchParams = {
  view?: string | string[];
  page?: string | string[];
  status?: string | string[];
  search?: string | string[];
  stage?: string | string[];
  station?: string | string[];
  head?: string | string[];
  date?: string | string[];
  manage?: string | string[];
  approvalError?: string | string[];
  approvalNotice?: string | string[];
};

type ApprovalFilters = PaymentApprovalFacetSelection & {
  oversight: boolean;
  status?: string;
  search?: string;
  stage?: string;
};

// The coloured milestone chips above the list; each one opens the requests at that milestone.
const APPROVAL_STAGES = [
  { value: "initial", label: "Initial review", tone: "payment-stage-initial", tones: ["payment-stage-initial"] },
  { value: "progress", label: "In progress", tone: "payment-stage-progress", tones: ["payment-stage-progress"] },
  { value: "final", label: "Final approval", tone: "payment-stage-final", tones: ["payment-stage-final"] },
  { value: "approved", label: "Approved", tone: "payment-stage-approved", tones: ["payment-stage-approved", "payment-stage-processing", "payment-stage-complete"] }
];

function firstRelation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function firstSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function withQueryParam(params: URLSearchParams, key: string, value: string) {
  const next = new URLSearchParams(params);
  next.set(key, value);
  return next.toString();
}

async function loadApprovals(companyId: string, authorization: AuthorizationContext, filters: ApprovalFilters) {
  if (!supabaseAdmin) {
    return {
      requests: [] as RequestRow[],
      canDownloadProcessData: false,
      eligibleIds: new Set<string>(),
      filterOptions: {
        stations: [] as PaymentApprovalFilterOption[],
        paymentHeads: [] as PaymentApprovalFilterOption[],
        dates: [] as PaymentApprovalFilterOption[]
      },
      selectedFilters: { stations: [], paymentHeads: [], dates: [] } as PaymentApprovalFacetSelection,
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
      current_step_order,
      total_steps,
      created_at,
      updated_at,
      approval_pending_since,
      approval_routing_reason,
      processed_at,
      payment_heads ( name, code ),
      profiles:requested_by ( full_name, email ),
      stations ( location_model_id )
    `)
    .eq("company_id", companyId)
    .order("created_at", { ascending: false }).order("id");

  if (!authorization.hasAllLocationAccess) {
    query = query.in(
      "location_id",
      authorization.locationScopeIds.length
        ? authorization.locationScopeIds
        : [NO_LOCATION_SCOPE_ID]
    );
  }

  // The normal approval inbox only needs actionable rows. Filtering terminal
  // requests in PostgREST prevents every click/refresh from downloading the
  // full historical payment table before the eligibility check runs.
  if ((filters.status || "pending") === "pending" && !filters.stage) {
    query = query.not(
      "status",
      "in",
      "(approved,APPROVED,processed,PROCESSED,processing,PROCESSING,returned,RETURNED,rejected,REJECTED,cancelled,CANCELLED)"
    );
  }

  const [requestsResult, processHeadsResult] = await Promise.all([
    readAllRows(query),
    authorization.roleId ? supabaseAdmin
      .from("payment_heads")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId)
      .contains("payment_process_role_ids", [authorization.roleId]) : { count: 0, error: null }
  ]);
  const unscopedRequests = ((requestsResult.data ?? []) as unknown as RequestRow[]).map((request) => ({
    ...request,
    payment_heads: firstRelation(request.payment_heads),
    profiles: firstRelation(request.profiles),
    location_model_id: firstRelation(request.stations)?.location_model_id ?? null
  }));
  const eligibleIds = !filters.oversight && hasPermission(authorization, "payment_approvals", "access")
    ? await getPaymentApprovalEligibility(companyId, authorization, unscopedRequests)
    : new Set<string>();
  const normalizedFilter = filters.status || "pending";
  const stageTones = APPROVAL_STAGES.find((stage) => stage.value === filters.stage)?.tones ?? null;
  const approvalHistoryResult = normalizedFilter === "acted" || normalizedFilter === "all"
    ? await supabaseAdmin
      .from("payment_request_approvals")
      .select("payment_request_id, request_id")
      .eq("company_id", companyId)
      .eq("approver_user_id", authorization.userId)
      .eq("action", "approved")
    : { data: [], error: null };
  const approvedByCurrentUserIds = new Set(
    (approvalHistoryResult.data ?? [])
      .flatMap((row) => [row.payment_request_id, row.request_id])
      .filter((id): id is string => Boolean(id))
  );
  const normalizedSearch = String(filters.search ?? "").trim().toLowerCase();
  const statusScopedRequests = unscopedRequests.filter((request) => {
    const isCurrentAssignment = eligibleIds.has(request.id);
    const wasApprovedByCurrentUser = approvedByCurrentUserIds.has(request.id);
    if (filters.oversight) {
      if (!canOverseePayment(authorization, request)) return false;
    } else if (!isCurrentAssignment && !wasApprovedByCurrentUser) return false;
    const requestStatus = String(request.status ?? "").trim().toLowerCase();
    const approvalStatus = String(request.approval_status || request.status || "").trim().toUpperCase();
    if (normalizedFilter === "pending") {
      if (!isPendingPaymentApproval(request)) return false;
    } else if (normalizedFilter === "approved") {
      if (!["payment-stage-approved", "payment-stage-processing", "payment-stage-complete"].includes(paymentApprovalStatusTone(request) ?? "")) return false;
    } else if (normalizedFilter === "returned") {
      if (requestStatus !== "returned" && approvalStatus !== "RETURNED") return false;
    } else if (normalizedFilter === "rejected") {
      if (requestStatus !== "rejected" && approvalStatus !== "REJECTED") return false;
    } else if (normalizedFilter === "acted") {
      if (!wasApprovedByCurrentUser) return false;
    }
    if (stageTones && !stageTones.includes(paymentApprovalStatusTone(request) ?? "")) return false;
    return true;
  });
  const stationOptions = [...new Set(statusScopedRequests.map((request) => request.location_code).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
    .map((value) => ({ value, label: value }));
  const paymentHeadById = new Map<string, PaymentApprovalFilterOption>();
  for (const request of statusScopedRequests) {
    if (!request.payment_head_id || paymentHeadById.has(request.payment_head_id)) continue;
    const name = request.payment_heads?.name?.trim() || request.payment_heads?.code?.trim() || "Unnamed payment head";
    const code = request.payment_heads?.code?.trim();
    paymentHeadById.set(request.payment_head_id, {
      value: request.payment_head_id,
      label: code && code.toLowerCase() !== name.toLowerCase() ? `${name} (${code})` : name
    });
  }
  const paymentHeadOptions = [...paymentHeadById.values()].sort((left, right) => left.label.localeCompare(right.label));
  const dateOptions = [...new Set(statusScopedRequests.map((request) => paymentApprovalDateKey(request.created_at)).filter(Boolean))]
    .sort((left, right) => right.localeCompare(left))
    .map((value) => ({ value, label: formatDashboardDate(value) }));
  const allowedStations = new Set(stationOptions.map((option) => option.value));
  const allowedPaymentHeads = new Set(paymentHeadOptions.map((option) => option.value));
  const allowedDates = new Set(dateOptions.map((option) => option.value));
  const selectedFilters: PaymentApprovalFacetSelection = {
    stations: filters.stations.filter((value) => allowedStations.has(value)),
    paymentHeads: filters.paymentHeads.filter((value) => allowedPaymentHeads.has(value)),
    dates: filters.dates.filter((value) => allowedDates.has(value))
  };
  const requests = statusScopedRequests.filter((request) => {
    if (!matchesPaymentApprovalFacets(request, selectedFilters)) return false;
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
  const ownerIds = [...new Set(requests.map(row => row.current_approver_user_id).filter((id): id is string => Boolean(id)))];
  const roleIds = [...new Set(requests.map(row => row.current_approver_role_id).filter((id): id is string => Boolean(id)))];
  const [owners, roles] = await Promise.all([
    ownerIds.length ? supabaseAdmin.from("profiles").select("id,full_name,email").eq("company_id", companyId).in("id", ownerIds) : { data: [] },
    roleIds.length ? supabaseAdmin.from("user_roles").select("id,name").eq("company_id", companyId).in("id", roleIds) : { data: [] }
  ]);
  const ownerNames = new Map((owners.data ?? []).map(row => [row.id, row.full_name || row.email]));
  const roleNames = new Map((roles.data ?? []).map(row => [row.id, row.name]));
  return {
    requests: requests.map(row => ({ ...row,
      currentOwner: ownerNames.get(row.current_approver_user_id) ?? (isPendingPaymentApproval(row) ? "Approver not configured" : "—"),
      currentRole: roleNames.get(row.current_approver_role_id) ?? ""
    })),
    eligibleIds,
    canDownloadProcessData: Boolean(authorization.roleId && (processHeadsResult.count ?? 0) > 0),
    filterOptions: { stations: stationOptions, paymentHeads: paymentHeadOptions, dates: dateOptions },
    selectedFilters,
    error: requestsResult.error?.message || processHeadsResult.error?.message || approvalHistoryResult.error?.message || null
  };
}

export const dynamic = "force-dynamic";

export default async function PaymentApprovalsPage({
  searchParams
}: {
  searchParams?: ApprovalSearchParams;
}) {
  const oversight = firstSearchParam(searchParams?.view) === "scope";
  const pageCode = "payment_approvals";
  const authorization = await requirePagePermission(pageCode, "access");
  const companyId = requireCompanyId(authorization);
  const pagePermission = authorization.permissions[pageCode];
  const requestedStatus = firstSearchParam(searchParams?.status);
  const requestedStage = firstSearchParam(searchParams?.stage);
  const currentStage = APPROVAL_STAGES.some((stage) => stage.value === requestedStage) ? requestedStage : "";
  // A milestone chip looks across everything assigned to or approved by the user, not just the pending queue.
  const currentStatus = currentStage
    ? "all"
    : ["pending", "acted", "approved", "returned", "rejected", "all"].includes(requestedStatus) ? requestedStatus : "pending";
  const currentSearch = firstSearchParam(searchParams?.search);
  const requestedFilters: PaymentApprovalFacetSelection = {
    stations: selectedPaymentApprovalValues(searchParams?.station),
    paymentHeads: selectedPaymentApprovalValues(searchParams?.head),
    dates: selectedPaymentApprovalValues(searchParams?.date)
  };
  const { requests: matchingRequests, eligibleIds, canDownloadProcessData, filterOptions, selectedFilters, error } = await loadApprovals(companyId, authorization, {
    oversight,
    status: currentStatus,
    search: currentSearch,
    stage: currentStage,
    ...requestedFilters
  });
  const pageSize = 50;
  const pageCount = Math.max(1, Math.ceil(matchingRequests.length / pageSize));
  const pageNumber = Math.min(pageCount, Math.max(1, Math.floor(Number(firstSearchParam(searchParams?.page)) || 1)));
  const requests = matchingRequests.slice((pageNumber - 1) * pageSize, pageNumber * pageSize);
  const currentParams = new URLSearchParams();
  if (pageNumber > 1) currentParams.set("page", String(pageNumber));
  currentParams.set("status", currentStatus);
  if (oversight) currentParams.set("view", "scope");
  if (currentStage) currentParams.set("stage", currentStage);
  if (currentSearch) currentParams.set("search", currentSearch);
  selectedFilters.stations.forEach((value) => currentParams.append("station", value));
  selectedFilters.paymentHeads.forEach((value) => currentParams.append("head", value));
  selectedFilters.dates.forEach((value) => currentParams.append("date", value));
  const stageHref = (stage: string) => {
    const next = new URLSearchParams(currentParams);
    next.delete("page");
    next.set("status", stage ? "all" : "pending");
    if (stage) next.set("stage", stage);
    else next.delete("stage");
    return `/payments/approvals?${next.toString()}`;
  };
  const isDatabaseUnreachable = error === DATABASE_UNREACHABLE_MESSAGE;
  const manageId = firstSearchParam(searchParams?.manage);
  const selectedRequest = manageId ? matchingRequests.find((request) => request.id === manageId) ?? null : null;

  const reviewSummary = (request: RequestRow): PaymentApprovalReviewSummary => {
    const displayAmount = paymentApprovalAmount(request);
    return {
      accountHolderName: request.account_holder_name,
      amountActual: request.amount,
      amountEstimated: displayAmount.isEstimated,
      amountRequested: request.amount_requested,
      amountText: displayAmount.text,
      approvalRoutingReason: request.approval_routing_reason,
      bankAccountNo: request.bank_account_no,
      contactNo: request.contact_no,
      currentOwner: request.currentOwner ?? "Unassigned",
      currentRole: request.currentRole ?? "",
      currentStep: request.current_step_order,
      email: request.email,
      id: request.id,
      ifsc: request.ifsc,
      locationCode: request.location_code,
      locationId: request.location_id,
      paymentHeadCode: request.payment_heads?.code ?? null,
      paymentHeadName: request.payment_heads?.name ?? "Payment request",
      paymentMode: request.payment_mode,
      paymentPortal: request.payment_portal,
      paymentReference: request.payment_reference,
      remarks: request.remarks,
      requestNo: request.request_no,
      statusLabel: paymentStatusLabel(request),
      statusTone: paymentApprovalStatusTone(request) ?? null,
      totalSteps: request.total_steps
    };
  };
  const canActOnRow = (request: RequestRow) => !oversight && pagePermission.canEdit && eligibleIds.has(request.id) && isPendingPaymentApproval(request);

  return (
    <AppShell active="Payment Approvals" pageCode={pageCode}>
      <PageHead
        eyebrow="Payments"
        title="Approvals"
        subtitle="Your approval queue across Last Mile and Dark Store, including requests assigned to you as fallback or leave cover."
        action={<span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>{isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}</span>}
      />

      <nav className="payment-approval-stage-legend" aria-label="Approval views">
        <PendingLink className={`button compact ${oversight ? "secondary" : ""}`} aria-current={!oversight ? "page" : undefined} prefetch={false} href="/payments/approvals">Needs my action</PendingLink>
        <PendingLink className={`button compact ${oversight ? "" : "secondary"}`} aria-current={oversight ? "page" : undefined} prefetch={false} href="/payments/approvals?view=scope">Track requests in my locations</PendingLink>
      </nav>
      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>{isDatabaseUnreachable ? "Approvals could not be loaded" : "Payment approval setup needed"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{isDatabaseUnreachable ? error : `${error} Run \`scripts/payment_requests_v1.sql\` in Supabase SQL Editor, then refresh.`}</p>
          </div>
        </section>
      ) : null}

      {firstSearchParam(searchParams?.approvalError) || firstSearchParam(searchParams?.approvalNotice) ? (
        <section className={`panel message-panel ${firstSearchParam(searchParams?.approvalError) ? "error" : "success"}`}>
          <div className="panel-body">
            <strong>{firstSearchParam(searchParams?.approvalError) ? "Payment approval not updated" : "Payment approval updated"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>
              {firstSearchParam(searchParams?.approvalError) || firstSearchParam(searchParams?.approvalNotice)}
            </p>
          </div>
        </section>
      ) : null}

      {!error ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>{oversight ? "Requests in my locations" : "My approval queue"}</h2>
              {oversight ? <p className="subtle">Read-only tracking across your permitted locations. See who each request is waiting with, or filter for approved and completed requests.</p> : null}
              <p className="subtle">{matchingRequests.length} records · page {pageNumber} of {pageCount}</p>
            </div>
            {!oversight && canDownloadProcessData ? (
              <a className="button secondary compact" href="/api/payments/approvals/download">Download raw Excel</a>
            ) : null}
          </div>
          {pageCount > 1 ? <div className="panel-body" style={{ display: "flex", gap: 8, padding: "8px 16px" }}>
            {pageNumber > 1 ? <PendingLink className="button secondary compact" href={`/payments/approvals?${withQueryParam(currentParams, "page", String(pageNumber - 1))}`} scroll={false}>Previous</PendingLink> : null}
            {pageNumber < pageCount ? <PendingLink className="button secondary compact" href={`/payments/approvals?${withQueryParam(currentParams, "page", String(pageNumber + 1))}`} scroll={false}>Next 50</PendingLink> : null}
          </div> : null}
          <PaymentApprovalFilters
            oversight={oversight}
            dateOptions={filterOptions.dates}
            paymentHeadOptions={filterOptions.paymentHeads}
            search={currentSearch}
            selectedDates={selectedFilters.dates}
            selectedPaymentHeads={selectedFilters.paymentHeads}
            selectedStations={selectedFilters.stations}
            stationOptions={filterOptions.stations}
            status={currentStatus}
          />
          <div className="payment-approval-stage-legend" aria-label="Filter approvals by milestone">
            <span>Milestones</span>
            <PendingLink
              className={`status-pill payment-approval-stage-chip ${currentStage || currentStatus !== "pending" ? "" : "active"}`}
              href={stageHref("")}
              scroll={false}
            >
              {oversight ? "All pending in my locations" : "Needs my action"}
            </PendingLink>
            {APPROVAL_STAGES.map((stage) => (
              <PendingLink
                className={`status-pill payment-approval-stage-chip ${stage.tone} ${currentStage === stage.value ? "active" : ""}`}
                href={stageHref(stage.value)}
                key={stage.value}
                scroll={false}
              >
                {stage.label}
              </PendingLink>
            ))}
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
                  <th>Current approver / stage</th>
                  <th>Pending since</th>
                  <th>Created</th>
                  <th>{oversight ? "Details" : "Action"}</th>
                </tr>
              </thead>
              <tbody>
                {requests.length ? requests.map((request) => {
                  const displayAmount = paymentApprovalAmount(request);
                  return (
                    <tr key={request.id}>
                      <td><strong>{request.request_no}</strong></td>
                      <td>{request.location_code}</td>
                      <td>{request.payment_heads?.name ?? "-"}</td>
                      <td>
                        <span>{displayAmount.text}</span>
                        {displayAmount.isEstimated ? <small className="subtle" style={{ display: "block" }}>Estimated</small> : null}
                      </td>
                      <td>{request.profiles?.full_name ?? request.profiles?.email ?? "-"}</td>
                      <td><StatusPill status={paymentStatusLabel(request)} tone={paymentApprovalStatusTone(request)} /></td>
                      <td><strong>{request.currentOwner}</strong><small className="subtle" style={{ display: "block" }}>{request.currentRole}{request.total_steps ? ` · ${request.current_step_order ?? 1} of ${request.total_steps}` : ""}</small>{request.approval_routing_reason ? <small className="subtle" style={{ display: "block", maxWidth: 240 }}>{request.approval_routing_reason}</small> : null}</td>
                      <td>{isPendingPaymentApproval(request) ? <><strong>{paymentPendingAge(request.approval_pending_since)}</strong><small className="subtle" style={{ display: "block" }}>{request.approval_pending_since ? formatDashboardDateTime(request.approval_pending_since) : ""}</small></> : "—"}</td>
                      <td>{formatDashboardDate(request.created_at)}</td>
                      <td>
                        <PaymentApprovalReviewLauncher
                          canAct={canActOnRow(request)}
                          initiallyOpen={manageId === request.id}
                          summary={reviewSummary(request)}
                        />
                      </td>
                    </tr>
                  );
                }) : (
                  <tr><td className="empty-cell" colSpan={10}>{currentStatus === "pending" ? "No approvals pending." : "No requests match this view."}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {selectedRequest && !requests.some((request) => request.id === selectedRequest.id) ? (
        <PaymentApprovalReviewLauncher
          canAct={canActOnRow(selectedRequest)}
          initiallyOpen
          showTrigger={false}
          summary={reviewSummary(selectedRequest)}
        />
      ) : null}
    </AppShell>
  );
}
