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

const terminalOnboardingStatuses = new Set(["cancelled", "rejected"]);

function status(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Changes whether a Workforce profile is enabled without changing its
 * registration or lifecycle workflow. In particular, enabling a bulk-imported
 * profile must not make a pending registration look completed. Formal
 * archived/exit states stay under Workforce Lifecycle ownership and therefore
 * cannot be reactivated by a general profile editor.
 */
export function canonicalWorkforceStatusEditPatch(
  requestedActive: boolean,
  current: CanonicalWorkforceStatusSource
): CanonicalWorkforceStatusPatch {
  const lifecycle = status(current.lifecycle_status);
  const onboarding = status(current.onboarding_status);
  const currentlyActive = current.is_active === true;

  // A normal profile save must never reinterpret registration when the
  // operator did not change the enabled flag. In particular, an enabled bulk
  // import remains Pending until the person submits registration.
  if (requestedActive === currentlyActive) {
    return { is_active: requestedActive };
  }

  if (requestedActive) {
    if (current.deleted_at || current.deactivated_at) {
      throw new Error("Archived workforce profiles cannot be reactivated from a profile edit.");
    }
    if (terminalOnboardingStatuses.has(onboarding)) {
      throw new Error("This workforce profile has a terminal registration status and cannot be reactivated from a profile edit.");
    }
    if (exitControlledLifecycles.has(lifecycle) && lifecycle !== "inactive") {
      throw new Error("This workforce profile is controlled by Workforce Lifecycle and cannot be reactivated from a profile edit.");
    }
    // Enabling a reserved, unregistered ID is allowed, but it must retain its
    // Pending/onboarding tuple. Completed registrations resume an active work
    // lifecycle without rewriting onboarding_status.
    return onboarding === "active"
      ? { lifecycle_status: "active", is_active: true }
      : { is_active: true };
  }

  // Registration remains completed when a profile is disabled; only its
  // operational lifecycle becomes inactive. Pending imports stay onboarding.
  return onboarding === "active"
    ? { lifecycle_status: "inactive", is_active: false }
    : { is_active: false };
}
