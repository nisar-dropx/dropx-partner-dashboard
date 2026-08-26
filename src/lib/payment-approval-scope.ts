import type { AuthorizationContext } from "@/lib/authorization";

export type PaymentApprovalScopeRequest = {
  id: string;
  location_id: string | null;
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

export async function getPaymentApprovalEligibility(companyId: string, authorization: AuthorizationContext, requests: PaymentApprovalScopeRequest[]) {
  void companyId;
  if (authorization.roleCode === "OWNER" || authorization.isMasterOwner) {
    return new Set(requests.map((request) => request.id));
  }
  const eligibleIds = new Set<string>();

  for (const request of requests) {
    if (!canAccessPaymentLocation(authorization, request.location_id)) {
      continue;
    }

    if (request.current_approver_user_id === authorization.userId) {
      eligibleIds.add(request.id);
      continue;
    }

    if (request.current_approver_role_id && authorization.effectiveRoleIds.includes(request.current_approver_role_id)) {
      eligibleIds.add(request.id);
      continue;
    }

    if ((request.current_approver_role_ids ?? []).some((roleId) => authorization.effectiveRoleIds.includes(roleId))) {
      eligibleIds.add(request.id);
      continue;
    }

  }

  return eligibleIds;
}

export async function canActOnPaymentRequest(companyId: string, authorization: AuthorizationContext, request: PaymentApprovalScopeRequest) {
  const eligibleIds = await getPaymentApprovalEligibility(companyId, authorization, [request]);
  return eligibleIds.has(request.id);
}
