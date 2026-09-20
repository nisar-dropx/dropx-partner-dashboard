import type { AuthorizationContext } from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";

export type PaymentApprovalScopeRequest = {
  id: string;
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
  return new Set((result.data ?? []).map((row) => row.location_model_id).filter((id): id is string => Boolean(id)));
}

export async function getPaymentApprovalEligibility(companyId: string, authorization: AuthorizationContext, requests: PaymentApprovalScopeRequest[]) {
  if (authorization.roleCode === "OWNER" || authorization.isMasterOwner) {
    return new Set(requests.map((request) => request.id));
  }
  const eligibleIds = new Set<string>();
  const modelIds = await authorizationModelIds(companyId, authorization);

  for (const request of requests) {
    if (!canAccessPaymentLocation(authorization, request.location_id)) {
      continue;
    }

    if (request.current_approver_user_id === authorization.userId) {
      eligibleIds.add(request.id);
      continue;
    }

    const roleMatch = Boolean(request.current_approver_role_id && authorization.effectiveRoleIds.includes(request.current_approver_role_id))
      || (request.current_approver_role_ids ?? []).some((roleId) => authorization.effectiveRoleIds.includes(roleId));
    if (!roleMatch) continue;
    if (request.location_model_id && modelIds && !modelIds.has(request.location_model_id)) continue;
    eligibleIds.add(request.id);
  }

  return eligibleIds;
}

export async function canActOnPaymentRequest(companyId: string, authorization: AuthorizationContext, request: PaymentApprovalScopeRequest) {
  const eligibleIds = await getPaymentApprovalEligibility(companyId, authorization, [request]);
  return eligibleIds.has(request.id);
}
