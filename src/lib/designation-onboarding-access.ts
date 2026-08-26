import type { AuthorizationContext } from "@/lib/authorization";

export type DesignationOnboardingAccess = {
  onboarding_role_ids?: string[] | null;
};

export function canOnboardDesignation(
  designation: DesignationOnboardingAccess,
  authorization: Pick<AuthorizationContext, "effectiveRoleIds" | "isMasterOwner" | "roleCode" | "roleId">
) {
  if (authorization.isMasterOwner || authorization.roleCode === "OWNER") return true;
  const allowedRoleIds = Array.isArray(designation.onboarding_role_ids)
    ? designation.onboarding_role_ids.filter(Boolean)
    : [];
  return authorization.effectiveRoleIds.some((roleId) => allowedRoleIds.includes(roleId));
}

export function requireDesignationOnboardingAccess(
  designation: DesignationOnboardingAccess,
  authorization: Pick<AuthorizationContext, "effectiveRoleIds" | "isMasterOwner" | "roleCode" | "roleId">
) {
  if (!canOnboardDesignation(designation, authorization)) {
    throw new Error("Your user role is not allowed to onboard this designation.");
  }
}
