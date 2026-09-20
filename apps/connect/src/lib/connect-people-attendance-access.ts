import "server-only";

import type { ConnectAccount } from "./connect-auth";
import { resolveConnectActorUserIds } from "./connect-approver-identity";
import { todayInIndia } from "./india-date";
import { supabaseAdmin } from "./supabase-admin";

function db() {
  if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
  return supabaseAdmin;
}

export type ConnectAttendanceApproveScope = {
  canFinalize: boolean;
  allLocations: boolean;
  locationIds: string[];
  actorUserIds: string[];
};

/**
 * People-parity gate for attendance / WFH HR finalization in DropX One.
 * Uses attendance page can_approve + grant location/company scope (not a company-wide dump for every manager).
 */
export async function loadConnectAttendanceApproveScope(account: ConnectAccount): Promise<ConnectAttendanceApproveScope> {
  const actorUserIds = await resolveConnectActorUserIds(account);
  if (!actorUserIds.length) {
    return { canFinalize: false, allLocations: false, locationIds: [], actorUserIds: [] };
  }

  const pageResult = await db().from("hr_permission_pages")
    .select("id").eq("company_id", account.companyId).eq("code", "attendance").eq("is_active", true).maybeSingle();
  if (pageResult.error || !pageResult.data) {
    return { canFinalize: false, allLocations: false, locationIds: [], actorUserIds };
  }

  const permissionResult = await db().from("hr_role_page_permissions")
    .select("role_id").eq("company_id", account.companyId).eq("page_id", pageResult.data.id).eq("can_approve", true);
  if (permissionResult.error) throw new Error(permissionResult.error.message);
  const roleIds = [...new Set((permissionResult.data ?? []).map((row) => row.role_id).filter(Boolean))];
  if (!roleIds.length) {
    return { canFinalize: false, allLocations: false, locationIds: [], actorUserIds };
  }

  const today = todayInIndia();
  const [grants, legacy] = await Promise.all([
    db().from("hr_access_grants")
      .select("user_id,role_id,scope_type,scope_id")
      .eq("company_id", account.companyId).eq("is_active", true).in("user_id", actorUserIds).in("role_id", roleIds)
      .lte("effective_from", today).or(`effective_to.is.null,effective_to.gte.${today}`),
    db().from("hr_user_access")
      .select("user_id,role_id,all_locations,location_ids")
      .eq("company_id", account.companyId).eq("is_active", true).in("user_id", actorUserIds).in("role_id", roleIds)
  ]);
  const missingGrants = /does not exist|schema cache/i.test(grants.error?.message ?? "");
  if (grants.error && !missingGrants) throw new Error(grants.error.message);
  if (legacy.error && !/does not exist|schema cache/i.test(legacy.error.message)) throw new Error(legacy.error.message);

  const locationIds = new Set<string>();
  let allLocations = false;
  let matched = false;

  for (const row of missingGrants ? [] : grants.data ?? []) {
    matched = true;
    const scopeType = String(row.scope_type ?? "").toLowerCase();
    if (!scopeType || scopeType === "company" || scopeType === "all" || scopeType === "all_locations") {
      allLocations = true;
    } else if (scopeType === "location" && row.scope_id) {
      locationIds.add(String(row.scope_id));
    }
  }

  for (const row of legacy.data ?? []) {
    matched = true;
    if (row.all_locations) allLocations = true;
    for (const id of row.location_ids ?? []) if (id) locationIds.add(String(id));
  }

  if (!matched) {
    return { canFinalize: false, allLocations: false, locationIds: [], actorUserIds };
  }

  return {
    canFinalize: true,
    allLocations,
    locationIds: [...locationIds],
    actorUserIds
  };
}

export async function loadConnectAccessibleWorkforceIds(account: ConnectAccount, scope: ConnectAttendanceApproveScope) {
  if (!scope.canFinalize) {
    return { employeeIds: new Set<string>(), contractorIds: new Set<string>(), allowAll: false };
  }
  if (scope.allLocations) {
    // Company grant — same as People allLocations (full workforce in scope).
    return { employeeIds: null as Set<string> | null, contractorIds: null as Set<string> | null, allowAll: true };
  }
  if (!scope.locationIds.length) {
    return { employeeIds: new Set<string>(), contractorIds: new Set<string>(), allowAll: false };
  }

  const [employees, contractors] = await Promise.all([
    db().from("employees").select("id").eq("company_id", account.companyId).eq("is_active", true).is("deleted_at", null).in("location_id", scope.locationIds),
    db().from("contractors").select("id").eq("company_id", account.companyId).eq("is_active", true).is("deleted_at", null).in("location_id", scope.locationIds)
  ]);
  if (employees.error) throw new Error(employees.error.message);
  if (contractors.error) throw new Error(contractors.error.message);
  return {
    employeeIds: new Set((employees.data ?? []).map((row) => row.id)),
    contractorIds: new Set((contractors.data ?? []).map((row) => row.id)),
    allowAll: false
  };
}

export function connectWorkforceMatches(
  access: { employeeIds: Set<string> | null; contractorIds: Set<string> | null; allowAll: boolean },
  profileType: string,
  profileId: string
) {
  if (access.allowAll) return true;
  if (profileType === "employee") return Boolean(access.employeeIds?.has(profileId));
  if (profileType === "contractor") return Boolean(access.contractorIds?.has(profileId));
  return false;
}
