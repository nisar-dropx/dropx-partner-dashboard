import { workforceProfileStatus, type WorkforceProfileStatusSource } from "./workforce-register-policy.ts";

export type DirectPaymentAudience = "workforce" | "helpers";
export type DirectPaymentProfileSource = WorkforceProfileStatusSource;

function humanizedStatus(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

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
  const onboardingStatus = String(source.onboarding_status ?? "active").trim().toLowerCase() || "active";
  return humanizedStatus(onboardingStatus);
}

export function directPaymentProfileIsVisible(
  source: DirectPaymentProfileSource,
  audience: DirectPaymentAudience
) {
  return directPaymentProfileStatus(source, audience).toLowerCase() !== "inactive";
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
