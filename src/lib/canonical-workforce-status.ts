export type CanonicalWorkforceStatusSource = {
  deactivated_at?: unknown;
  deleted_at?: unknown;
  is_active?: boolean | null;
  lifecycle_status?: string | null;
  onboarding_status?: string | null;
};

export type CanonicalWorkforceStatusPatch = {
  is_active: boolean;
  lifecycle_status?: "active" | "inactive";
  onboarding_status?: "active";
};

const exitControlledLifecycles = new Set([
  "closed",
  "exited",
  "offboarded",
  "offboarding",
  "resigned",
  "resignation_pending",
  "settled",
  "settlement_pending",
  "suspended",
  "terminated",
  "termination_pending"
]);

const lifecycleControlledOnboardingStatuses = new Set([
  "approved",
  "cancelled",
  "pending",
  "rejected",
  "returned",
  "under_review"
]);

function status(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Keeps the three canonical Workforce status fields coherent when a profile
 * editor explicitly changes Active/Inactive. Formal exit/terminal states stay
 * under Workforce Lifecycle ownership and therefore cannot be reactivated by
 * a general profile editor.
 */
export function canonicalWorkforceStatusEditPatch(
  requestedActive: boolean,
  current: CanonicalWorkforceStatusSource
): CanonicalWorkforceStatusPatch {
  const lifecycle = status(current.lifecycle_status);
  const onboarding = status(current.onboarding_status);
  const currentlyActive = current.is_active === true;

  // A normal profile save must not reinterpret a lifecycle state when the
  // operator did not actually change the Active flag. The only exception is
  // the historical split tuple repaired by this release: the flag was already
  // true while onboarding still said pending.
  if (requestedActive === currentlyActive) {
    if (requestedActive && onboarding === "pending" && ["", "active", "onboarding"].includes(lifecycle)
      && !current.deleted_at && !current.deactivated_at) {
      return { onboarding_status: "active", lifecycle_status: "active", is_active: true };
    }
    return { is_active: requestedActive };
  }

  if (requestedActive) {
    if (current.deleted_at || current.deactivated_at) {
      throw new Error("Archived workforce profiles cannot be reactivated from a profile edit.");
    }
    if (lifecycleControlledOnboardingStatuses.has(onboarding)) {
      throw new Error("Complete activation in Workforce Lifecycle before marking this profile Active.");
    }
    if (exitControlledLifecycles.has(lifecycle) && lifecycle !== "inactive") {
      throw new Error("This workforce profile is controlled by Workforce Lifecycle and cannot be reactivated from a profile edit.");
    }
    return {
      onboarding_status: "active",
      lifecycle_status: "active",
      is_active: true
    };
  }

  if (current.deleted_at || current.deactivated_at || exitControlledLifecycles.has(lifecycle)
    || lifecycleControlledOnboardingStatuses.has(onboarding)) {
    return { is_active: false };
  }

  // Retain the completed onboarding record, but never leave a manually
  // deactivated profile with an impossible active lifecycle.
  return {
    lifecycle_status: "inactive",
    is_active: false
  };
}
