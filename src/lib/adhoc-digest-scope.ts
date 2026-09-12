import type { SupabaseClient } from "@supabase/supabase-js";
import type { CodLocationRow } from "./ops-pulse/cod";

export const adHocOpsRoles = new Set([
  "OPERATIONS_LOCATION", "OPERATIONS_TL", "OPERATIONS_SSA", "OPERATIONS_SIC",
  "OPERATIONS_STM", "OPERATIONS_SM", "OPERATIONS_SRSM", "OPERATIONS_CLM",
  "OPERATIONS_CLUSTER_HEAD", "OPERATIONS_AOM", "OPERATIONS_CM", "OPERATIONS_RM",
  "OPERATIONS_PGM", "OPERATIONS_BH", "OPERATIONS_NH"
]);

export type AdHocMailStation = CodLocationRow & { station_email?: string | null };
export type AdHocMailRecipient = { email: string; name: string; stationIds: string[] };
export type AdHocMembership = { user_id: string; role_id: string; has_all_location_access: boolean; location_scope_ids: string[] | null };
export type AdHocRole = { id: string; code: string; location_access_mode: string | null };
export type AdHocProfile = { id: string; full_name: string | null; email: string | null };

function relationCode(relation: CodLocationRow["providers"]) {
  const row = Array.isArray(relation) ? relation[0] : relation;
  return String(row?.code || "").trim().toUpperCase();
}

export function adHocProgram(station: CodLocationRow) {
  const provider = relationCode(station.providers), model = relationCode(station.location_models);
  if (provider === "AMAZON" && ["EDSP", "XPT"].includes(model)) return `Amazon ${model}`;
  if (provider === "FLIPKART" && ["ODH", "MDH"].includes(model)) return `Flipkart ${model}`;
  return null;
}

export function resolveAdHocRecipients(
  stations: AdHocMailStation[], memberships: AdHocMembership[], roles: AdHocRole[],
  profiles: AdHocProfile[], domain: string
): AdHocMailRecipient[] {
  const allowedStations = stations.filter(station => !station.hide_from_location_list && adHocProgram(station));
  const roleById = new Map(roles.filter(role => adHocOpsRoles.has(role.code)).map(role => [role.id, role]));
  const profileById = new Map(profiles.map(profile => [profile.id, profile]));
  const recipients = new Map<string, AdHocMailRecipient>();
  for (const membership of memberships) {
    const role = roleById.get(membership.role_id), profile = profileById.get(membership.user_id);
    const email = String(profile?.email || "").trim().toLowerCase();
    if (!role || !profile || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) || email.split("@")[1] !== domain.toLowerCase()) continue;
    const scoped = allowedStations.filter(station => membership.has_all_location_access || role.location_access_mode === "all_locations"
      || membership.location_scope_ids?.includes(station.id)
      || (role.code === "OPERATIONS_LOCATION" && station.station_email?.trim().toLowerCase() === email));
    if (!scoped.length) continue;
    const recipient = recipients.get(email) ?? { email, name: profile.full_name || email, stationIds: [] };
    recipient.stationIds = [...new Set([...recipient.stationIds, ...scoped.map(station => station.id)])].sort();
    recipients.set(email, recipient);
  }
  return [...recipients.values()].sort((a, b) => a.email.localeCompare(b.email));
}

// Page every source; a capped recipient list must never silently omit a station team.
async function allRows<T>(query: (offset: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; offset < 30000; offset += 1000) {
    const result = await query(offset);
    if (result.error) throw new Error(result.error.message);
    rows.push(...(result.data ?? []) as T[]);
    if ((result.data?.length ?? 0) < 1000) return rows;
  }
  throw new Error("Ad hoc recipient scope exceeds the supported size.");
}

export async function loadAdHocMailScope(db: SupabaseClient, companyId: string, domain: string) {
  const [stations, memberships, roles, profiles] = await Promise.all([
    allRows<AdHocMailStation>(offset => db.from("stations")
      .select("id,station_code,station_name,station_email,hide_from_location_list,providers(code,name),location_models(code,name)")
      .eq("company_id", companyId).eq("is_active", true).order("id").range(offset, offset + 999)),
    allRows<AdHocMembership>(offset => db.from("company_product_memberships")
      .select("user_id,role_id,has_all_location_access,location_scope_ids")
      .eq("company_id", companyId).eq("product_code", "operations").eq("is_active", true).order("id").range(offset, offset + 999)),
    allRows<AdHocRole>(offset => db.from("user_roles").select("id,code,location_access_mode")
      .eq("company_id", companyId).eq("is_active", true).order("id").range(offset, offset + 999)),
    allRows<AdHocProfile>(offset => db.from("profiles").select("id,full_name,email")
      .eq("company_id", companyId).eq("is_active", true).order("id").range(offset, offset + 999))
  ]);
  const included = stations.filter(station => !station.hide_from_location_list && adHocProgram(station));
  return { stations: included, recipients: resolveAdHocRecipients(included, memberships, roles, profiles, domain) };
}
