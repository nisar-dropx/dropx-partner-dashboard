import "server-only";

import type { AuthorizationContext } from "@/lib/authorization";
import {
  isRegionalManagerSeat,
  mergeRosterLocationScopeIds,
  shouldResolveRegionalManagerReporteeScope
} from "@/lib/ops-pulse/roster-manager-scope-logic";
import { supabaseAdmin } from "@/lib/supabase-admin";

export {
  isRegionalManagerSeat,
  mergeRosterLocationScopeIds,
  shouldResolveRegionalManagerReporteeScope
} from "@/lib/ops-pulse/roster-manager-scope-logic";

/**
 * Regional Managers / Regional Heads inherit Ops stations from direct People
 * reportees (e.g. City Managers posted at HO_TS who manage Dark Store scopes),
 * so Rostering can edit those stations even when membership lags.
 */
function indiaToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

function db() {
  if (!supabaseAdmin) throw new Error("Database service is unavailable.");
  return supabaseAdmin;
}

async function allRows<T>(query: { range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }> }) {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const result = await query.range(offset, offset + 999);
    if (result.error) throw new Error(result.error.message);
    rows.push(...(result.data ?? []));
    if ((result.data ?? []).length < 1000) return rows;
  }
}

const scopeCache = new WeakMap<AuthorizationContext, Promise<string[]>>();

export async function loadRegionalManagerReporteeStationIds(authorization: AuthorizationContext): Promise<string[]> {
  if (!authorization.companyId || authorization.hasAllLocationAccess) return [];
  if (!shouldResolveRegionalManagerReporteeScope({
    designationName: authorization.designationName,
    roleCodes: authorization.effectiveRoleCodes
  })) {
    return [];
  }

  const companyId = authorization.companyId;
  const today = indiaToday();

  const link = await db().from("hr_user_person_links")
    .select("person_id,status")
    .eq("company_id", companyId)
    .eq("user_id", authorization.userId)
    .eq("status", "active")
    .maybeSingle();
  if (link.error) throw new Error(link.error.message);
  if (!link.data?.person_id) return [];

  const engagement = await db().from("hr_engagements")
    .select("id")
    .eq("company_id", companyId)
    .eq("person_id", link.data.person_id)
    .eq("status", "active")
    .lte("start_date", today)
    .or(`end_date.is.null,end_date.gte.${today}`)
    .order("start_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (engagement.error) throw new Error(engagement.error.message);
  if (!engagement.data?.id) return [];

  const assignment = await db().from("hr_work_assignments")
    .select("id,designation_id")
    .eq("company_id", companyId)
    .eq("engagement_id", engagement.data.id)
    .eq("is_primary", true)
    .lte("effective_from", today)
    .or(`effective_to.is.null,effective_to.gte.${today}`)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (assignment.error) throw new Error(assignment.error.message);
  if (!assignment.data?.id) return [];

  const designation = assignment.data.designation_id
    ? await db().from("designations").select("code,name").eq("company_id", companyId).eq("id", assignment.data.designation_id).maybeSingle()
    : { data: null, error: null };
  if (designation.error) throw new Error(designation.error.message);

  if (!isRegionalManagerSeat({
    designationCode: designation.data?.code,
    designationName: designation.data?.name ?? authorization.designationName,
    roleCodes: authorization.effectiveRoleCodes
  })) {
    return [];
  }

  const relationships = await allRows<{ subject_assignment_id: string }>(
    db().from("hr_reporting_relationships")
      .select("subject_assignment_id")
      .eq("company_id", companyId)
      .eq("manager_assignment_id", assignment.data.id)
      .eq("relationship_type", "solid_line")
      .eq("is_primary", true)
      .lte("effective_from", today)
      .or(`effective_to.is.null,effective_to.gte.${today}`)
      .order("id")
  );
  const subjectIds = [...new Set(relationships.map((row) => row.subject_assignment_id).filter(Boolean))];
  if (!subjectIds.length) return [];

  const subjects = await allRows<{ id: string; engagement_id: string; location_id: string | null }>(
    db().from("hr_work_assignments")
      .select("id,engagement_id,location_id")
      .eq("company_id", companyId)
      .in("id", subjectIds)
      .lte("effective_from", today)
      .or(`effective_to.is.null,effective_to.gte.${today}`)
      .order("id")
  );
  const engagementIds = [...new Set(subjects.map((row) => row.engagement_id))];
  const engagements = engagementIds.length
    ? await allRows<{ id: string; person_id: string; status: string }>(
      db().from("hr_engagements").select("id,person_id,status").eq("company_id", companyId).in("id", engagementIds).order("id")
    )
    : [];
  const activeEngagementById = new Map(
    engagements.filter((row) => row.status === "active").map((row) => [row.id, row])
  );
  const personIds = [...new Set(
    [...activeEngagementById.values()].map((row) => row.person_id).filter(Boolean)
  )];
  if (!personIds.length) return [];

  const stationIds = new Set<string>();
  for (const subject of subjects) {
    if (!activeEngagementById.has(subject.engagement_id)) continue;
    if (subject.location_id) stationIds.add(subject.location_id);
  }

  const personScopes = await allRows<{ location_scope_ids: string[] | null }>(
    db().from("people_person_access_scopes")
      .select("location_scope_ids")
      .eq("company_id", companyId)
      .in("person_id", personIds)
      .order("person_id")
  );
  for (const row of personScopes) {
    for (const id of row.location_scope_ids ?? []) {
      if (id) stationIds.add(id);
    }
  }

  const userLinks = await allRows<{ user_id: string }>(
    db().from("hr_user_person_links")
      .select("user_id")
      .eq("company_id", companyId)
      .in("person_id", personIds)
      .eq("status", "active")
      .order("user_id")
  );
  const userIds = [...new Set(userLinks.map((row) => row.user_id).filter(Boolean))];
  if (userIds.length) {
    const memberships = await allRows<{ location_scope_ids: string[] | null; has_all_location_access: boolean | null }>(
      db().from("company_product_memberships")
        .select("location_scope_ids,has_all_location_access")
        .eq("company_id", companyId)
        .eq("product_code", "operations")
        .eq("is_active", true)
        .in("user_id", userIds)
        .order("id")
    );
    for (const row of memberships) {
      // Reportee with all-locations would otherwise dump the whole network onto the RM.
      if (row.has_all_location_access) continue;
      for (const id of row.location_scope_ids ?? []) {
        if (id) stationIds.add(id);
      }
    }
  }

  return [...stationIds];
}

export async function resolveOpsRosterLocationScopeIds(authorization: AuthorizationContext): Promise<string[]> {
  if (authorization.hasAllLocationAccess) return [];
  const cached = scopeCache.get(authorization);
  if (cached) return cached;

  const pending = (async () => {
    const inherited = await loadRegionalManagerReporteeStationIds(authorization);
    return mergeRosterLocationScopeIds(authorization.locationScopeIds, inherited, false);
  })();

  scopeCache.set(authorization, pending);
  try {
    return await pending;
  } catch (error) {
    scopeCache.delete(authorization);
    throw error;
  }
}
