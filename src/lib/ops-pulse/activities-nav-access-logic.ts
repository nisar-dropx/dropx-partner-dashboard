export type ActivitiesNavAccess = {
  showShiftOps: boolean;
  showStoreOps: boolean;
  showShiftReport: boolean;
  showStoreReport: boolean;
};

export type ActivitiesNavChild = {
  code?: string;
  label: string;
  href?: string;
};

/**
 * Pure flags for sidebar, hub, and pages.
 *
 * Shift Incharges often inherit `store_ops` page access on the designation.
 * When store filler/manager role allowlists are configured, Store ops/report
 * only appear for people on those lists — not for SI workers who merely have
 * the page permission.
 */
export function activitiesNavFlags(input: {
  hasSi: boolean;
  hasStore: boolean;
  siManager: boolean;
  /** Explicit membership in store fillerRoles (false if list empty). */
  explicitStoreFiller: boolean;
  /** Explicit membership in store managerRoles (false if list empty). */
  explicitStoreManager: boolean;
  /** Legacy fallback when both store role lists are empty. */
  storeRolesConfigured: boolean;
}): ActivitiesNavAccess {
  const onStoreProgramme = input.storeRolesConfigured
    ? input.explicitStoreFiller || input.explicitStoreManager
    : input.hasStore;
  return {
    showShiftOps: input.hasSi,
    showStoreOps: input.hasStore && onStoreProgramme,
    showShiftReport: input.hasSi && input.siManager,
    showStoreReport:
      input.hasStore &&
      (input.storeRolesConfigured
        ? input.explicitStoreManager
        : input.hasStore),
  };
}

export function filterActivitiesNavChildren<T extends ActivitiesNavChild>(
  children: T[],
  access: ActivitiesNavAccess,
): T[] {
  return children.filter((child) => {
    const href = child.href || "";
    if (href.includes("/si-handover/report")) {
      return href.includes("tab=store")
        ? access.showStoreReport
        : access.showShiftReport;
    }
    if (href.includes("/store-ops")) return access.showStoreOps;
    if (href.includes("/si-handover")) return access.showShiftOps;
    return true;
  });
}
