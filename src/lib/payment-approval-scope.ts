import type { AuthorizationContext } from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { isPendingPaymentApproval, matchesCurrentPaymentAssignee } from "@/lib/payment-stage-policy";
import { initialApprovalReadyIds } from "@/lib/payment-initial-approval-gate";
import { loadPaymentReportingHierarchy } from "@/lib/payment-reporting-hierarchy";

export type PaymentApprovalScopeRequest = {
  id: string;
  status?: string | null;
  approval_status?: string | null;
  location_id: string | null;
  location_model_id?: string | null;
  requested_by: string | null;
  current_approver_user_id: string | null;
  current_approver_role_id?: string | null;
  current_approver_role_ids?: string[] | null;
};

export function canAccessPaymentLocation(
  authorization: AuthorizationContext,
  locationId: string | null | undefined
) {
  return authorization.hasAllLocationAccess || Boolean(
    locationId && authorization.locationScopeIds.includes(locationId)
  );
}

/** A master-managed capability; it never changes assignments or reminder recipients. */
export function hasPaymentFinalApprovalAuthority(authorization: AuthorizationContext) {
  return !authorization.readOnly && !authorization.isPreview && Boolean(
    authorization.permissions?.payment_approvals?.canEdit &&
    authorization.permissions?.payment_final_approval_bypass?.canEdit
  );
}

/**
 * Business models (stations.location_model_id, e.g. Amazon EDSP vs Amazon
 * Now) covered by this authorization's own station scope - a defense-in-depth
 * check alongside canAccessPaymentLocation: a Regional Manager whose stations
 * are all "Now" model has no business acting on an "EDSP" model station's
 * request even if a data mistake ever put that station in their location
 * scope. null means hasAllLocationAccess (covers every model already).
 */
async function authorizationModelIds(companyId: string, authorization: AuthorizationContext): Promise<Set<string> | null> {
  if (authorization.hasAllLocationAccess || !supabaseAdmin) return null;
  if (!authorization.locationScopeIds.length) return new Set();
  const result = await supabaseAdmin.from("stations").select("location_model_id").eq("company_id", companyId).in("id", authorization.locationScopeIds);
  if (result.error) throw new Error("Could not verify payment location scope. Please retry.");
  return new Set((result.data ?? []).map((row) => row.location_model_id).filter((id): id is string => Boolean(id)));
}

async function approvalEligibility(
  companyId: string,
  authorization: AuthorizationContext,
  requests: PaymentApprovalScopeRequest[],
  includeReportingManagers: boolean
) {
  // Owner takeover authority belongs to the team view, not the personal inbox.
  if (includeReportingManagers && (authorization.roleCode === "OWNER" || authorization.isMasterOwner)) {
    return new Set(requests.map((request) => request.id));
  }
  const eligibleIds = new Set<string>();
  const bypassIds = new Set<string>();
  const canFinalize = includeReportingManagers && hasPaymentFinalApprovalAuthority(authorization);
  const modelIds = await authorizationModelIds(companyId, authorization);
  const hierarchy = includeReportingManagers && !canFinalize ? await loadPaymentReportingHierarchy(companyId) : null;

  for (const request of requests) {
    if (!canAccessPaymentLocation(authorization, request.location_id)) {
      continue;
    }

    if (request.location_model_id && modelIds && !modelIds.has(request.location_model_id)) continue;
    if (canFinalize && request.status != null && isPendingPaymentApproval(request.status, request.approval_status ?? null)) {
      bypassIds.add(request.id);
      continue;
    }
    const assigned = matchesCurrentPaymentAssignee(authorization.userId, authorization.effectiveRoleIds, request);
    const reportingManager = Boolean(
      includeReportingManagers &&
      request.current_approver_user_id &&
      hierarchy?.isStrictlyAbove(authorization.userId, request.current_approver_user_id)
    );
    if (!assigned && !reportingManager) continue;
    if (request.location_model_id && modelIds && !modelIds.has(request.location_model_id)) continue;
    eligibleIds.add(request.id);
  }

  const ready = await initialApprovalReadyIds(companyId, [...eligibleIds], supabaseAdmin);
  return new Set([...ready, ...bypassIds]);
}

/** Personal queue and reminder eligibility: only the named assignee or an
 * unnamed configured role pool. Higher managers deliberately do not appear
 * here; they take over from the team view without receiving assignee mail. */
export async function getPaymentApprovalEligibility(companyId: string, authorization: AuthorizationContext, requests: PaymentApprovalScopeRequest[]) {
  return approvalEligibility(companyId, authorization, requests, false);
}

/** Decision eligibility for the team/location view and server actions. */
export async function getPaymentApprovalActionEligibility(companyId: string, authorization: AuthorizationContext, requests: PaymentApprovalScopeRequest[]) {
  return approvalEligibility(companyId, authorization, requests, true);
}

export async function canActOnPaymentRequest(companyId: string, authorization: AuthorizationContext, request: PaymentApprovalScopeRequest) {
  const eligibleIds = await getPaymentApprovalActionEligibility(companyId, authorization, [request]);
  return eligibleIds.has(request.id);
}
