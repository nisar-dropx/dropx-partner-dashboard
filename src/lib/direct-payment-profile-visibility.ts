import { workforceProfileStatus, type WorkforceProfileStatusSource } from "./workforce-register-policy.ts";

export type DirectPaymentAudience = "workforce" | "helpers";
export type DirectPaymentProfileSource = WorkforceProfileStatusSource;


/**
 * The direct-pay register follows the status shown by the corresponding
 * people register. In particular, a Workforce onboarding row can be Pending
 * while its activation flag is still false; that is not an Inactive profile.
 */
export function directPaymentProfileStatus(
  source: DirectPaymentProfileSource,
  audience: DirectPaymentAudience
) {
  if (audience === "workforce") return workforceProfileStatus(source);
  if (source.deleted_at || source.is_active !== true) return "Inactive";
  return workforceProfileStatus(source);
}

export function directPaymentProfileIsVisible(
  source: DirectPaymentProfileSource,
  audience: DirectPaymentAudience
) {
  // Visibility is not payment eligibility: keep historical and view-only
  // workflow records visible even when the simplified label is Inactive.
  if (source.deleted_at) return false;
  const onboarding = String(source.onboarding_status ?? "").trim().toLowerCase();
  if (audience === "helpers") return source.is_active === true && onboarding !== "inactive";
  const lifecycle = String(source.people_lifecycle_status ?? source.lifecycle_status ?? "").trim().toLowerCase();
  if (lifecycle === "inactive") return false;
  if (lifecycle && !["active", "onboarding"].includes(lifecycle)) return true;
  if (onboarding === "inactive") return false;
  if (onboarding && onboarding !== "active") return true;
  return source.is_active === true;
}

/** Keep UI write eligibility aligned with the direct-allocation RPC policy. */
export function directPaymentProfileIsEditable(
  source: DirectPaymentProfileSource,
  audience: DirectPaymentAudience
) {
  if (source.deleted_at) return false;
  if (source.is_active === true) {
    return audience === "workforce"
      || String(source.onboarding_status ?? "").trim().toLowerCase() === "active";
  }
  if (audience !== "workforce") return false;

  // A Workforce profile awaiting app registration is intentionally not
  // operationally active yet, but its pay can still be configured in advance.
  // Keep terminal and genuinely inactive profiles read-only.
  const onboarding = String(source.onboarding_status ?? "").trim().toLowerCase();
  const lifecycle = String(source.people_lifecycle_status ?? source.lifecycle_status ?? "").trim().toLowerCase();
  return ["pending", "under_review", "returned", "approved"].includes(onboarding)
    && ["", "onboarding", "active"].includes(lifecycle);
}
