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
  if (!scope.allLocations && !scope.locationIds.length) {
    return { employeeIds: new Set<string>(), contractorIds: new Set<string>(), allowAll: false };
  }

  // Match People's source registers even for company-wide reviewers. An all-
  // location grant must never include Workforce requests or deleted profiles.
  // Inactive (but not deleted) People profiles retain historical HR requests.
  const loadWorkers = async (table: "employees" | "contractors", workerType: "employee" | "contractor") => {
    const rows: Array<{ id: string; location_id: string | null }> = [];
    for (let from = 0; ; from += 1000) {
      const result = await db().from(table).select("id,location_id")
        .eq("company_id", account.companyId).is("deleted_at", null)
        .order("id").range(from, from + 999);
      if (result.error) throw new Error(result.error.message);
      rows.push(...(result.data ?? []));
      if ((result.data ?? []).length < 1000) break;
    }
    if (scope.allLocations) return new Set(rows.map(row => row.id));
    const locations = new Map(rows.map(row => [row.id, row.location_id]));
    const workerColumn = workerType === "employee" ? "employee_id" : "contractor_id";
    const today = todayInIndia();
    for (let from = 0; from < rows.length; from += 100) {
      const engagements = await db().from("hr_engagements")
        .select("id,employee_id,contractor_id").eq("company_id", account.companyId)
        .eq("worker_type", workerType).eq("status", "active")
        .in(workerColumn, rows.slice(from, from + 100).map(row => row.id));
      if (engagements.error) throw new Error(engagements.error.message);
      const items = engagements.data ?? [];
      if (!items.length) continue;
      const assignments = await db().from("hr_work_assignments")
        .select("engagement_id,location_id,effective_from").eq("company_id", account.companyId)
        .eq("is_primary", true).in("engagement_id", items.map(row => row.id))
        .lte("effective_from", today).or(`effective_to.is.null,effective_to.gte.${today}`)
        .order("effective_from", { ascending: false });
      if (assignments.error) throw new Error(assignments.error.message);
      const workerByEngagement = new Map(items.map(row => [row.id, row[workerColumn]]));
      const seen = new Set<string>();
      for (const assignment of assignments.data ?? []) {
        const id = workerByEngagement.get(assignment.engagement_id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        locations.set(id, assignment.location_id ?? locations.get(id) ?? null);
      }
    }
    return new Set(rows.filter(row => scope.locationIds.includes(locations.get(row.id) ?? "")).map(row => row.id));
  };
  const [employeeIds, contractorIds] = await Promise.all([
    loadWorkers("employees", "employee"), loadWorkers("contractors", "contractor")
  ]);
  return {
    employeeIds,
    contractorIds,
    allowAll: false
  };
}

export function connectWorkforceMatches(
  access: { employeeIds: Set<string> | null; contractorIds: Set<string> | null; allowAll: boolean },
  profileType: string,
  profileId: string
) {
  if (profileType !== "employee" && profileType !== "contractor") return false;
  if (access.allowAll) return true;
  if (profileType === "employee") return Boolean(access.employeeIds?.has(profileId));
  if (profileType === "contractor") return Boolean(access.contractorIds?.has(profileId));
  return false;
}
