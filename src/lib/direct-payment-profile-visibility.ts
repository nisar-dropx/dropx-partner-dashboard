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

/**
 * Keep write eligibility aligned with the existing server actions/RPCs. Rows
 * made visible by this change remain read-only until they become save-eligible.
 */
export function directPaymentProfileIsEditable(
  source: DirectPaymentProfileSource,
  audience: DirectPaymentAudience
) {
  if (source.deleted_at || source.is_active !== true) return false;
  return audience === "workforce"
    || String(source.onboarding_status ?? "").trim().toLowerCase() === "active";
}
