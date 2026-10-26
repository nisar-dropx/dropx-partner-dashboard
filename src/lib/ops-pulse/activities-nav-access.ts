import "server-only";
import {
  hasPermission,
  type AuthorizationContext,
} from "@/lib/authorization";
import type { NavItem } from "@/lib/app-navigation";
import {
  actorFromAuth as siActor,
  ensureMaster as ensureSiMaster,
  isManager as isSiManager,
} from "@/lib/ops-pulse/si-handover/server";
import {
  actorFromAuth as storeActor,
  ensureMaster as ensureStoreMaster,
} from "@/lib/ops-pulse/store-ops/server";
import {
  activitiesNavFlags,
  filterActivitiesNavChildren,
  type ActivitiesNavAccess,
} from "./activities-nav-access-logic";

export type { ActivitiesNavAccess };
export { activitiesNavFlags, filterActivitiesNavChildren };

function inRoleList(roleIds: string[], allow: string[]) {
  if (!allow.length) return false;
  return roleIds.some((id) => allow.includes(id));
}

export async function resolveActivitiesNavAccess(
  auth: AuthorizationContext,
): Promise<ActivitiesNavAccess> {
  const hasSi = hasPermission(auth, "si_handover", "access");
  const hasStore = hasPermission(auth, "store_ops", "access");
  let siManager = false;
  let explicitStoreFiller = false;
  let explicitStoreManager = false;
  let storeRolesConfigured = false;
  const roleCodes = [
    ...(auth.effectiveRoleCodes || []),
    ...(auth.roleCode ? [auth.roleCode] : []),
  ].map((c) => String(c || "").trim().toUpperCase());
  const isLocationAccount = roleCodes.some(
    (c) => c === "OPERATIONS_LOCATION" || c === "LOCATION",
  );

  if (auth.companyId && (hasSi || hasStore)) {
    const [siMaster, storeMaster] = await Promise.all([
      hasSi ? ensureSiMaster(auth.companyId).catch(() => null) : null,
      hasStore ? ensureStoreMaster(auth.companyId).catch(() => null) : null,
    ]);
    if (siMaster) {
      siManager = isSiManager(siActor(auth), siMaster.settings);
    }
    if (storeMaster) {
      const actor = storeActor(auth);
      const fillerRoles = storeMaster.settings.fillerRoles || [];
      const managerRoles = storeMaster.settings.managerRoles || [];
      storeRolesConfigured = fillerRoles.length > 0 || managerRoles.length > 0;
      explicitStoreFiller =
        actor.isMasterOwner || inRoleList(actor.effectiveRoleIds, fillerRoles);
      explicitStoreManager =
        actor.isMasterOwner || inRoleList(actor.effectiveRoleIds, managerRoles);
    }
  }

  return activitiesNavFlags({
    hasSi,
    hasStore,
    siManager,
    explicitStoreFiller,
    explicitStoreManager,
    storeRolesConfigured,
    isLocationAccount,
  });
}

export function applyActivitiesNavAccess(
  items: NavItem[],
  access: ActivitiesNavAccess,
): NavItem[] {
  return items.map((item) => {
    if (item.code !== "si_handover" || !item.children?.length) return item;
    return {
      ...item,
      children: filterActivitiesNavChildren(item.children, access),
    };
  });
}
