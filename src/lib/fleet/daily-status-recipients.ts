import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { adHocOpsRoles } from "@/lib/adhoc-digest-scope";
import type { CodLocationRow } from "@/lib/ops-pulse/cod";

type Station = CodLocationRow & { station_email?: string | null };
type Membership = { user_id: string; role_id: string; has_all_location_access: boolean; location_scope_ids: string[] | null };
type Role = { id: string; code: string; location_access_mode: string | null };
type Profile = { id: string; full_name: string | null; email: string | null };

export type FleetMailRecipient = { email: string; name: string; stationCodes: string[]; source: "people" | "station" };
export type FleetManualMailRecipient = { email: string | null; name?: string | null; stationCodes: string[] };
export type FleetMailDeliveryRecipient = { email: string; name: string; stationCodes: string[]; sources: Array<"people" | "station" | "manual"> };

const address = (value: unknown) => {
  const result = String(value ?? "").trim().toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(result) ? result : null;
};

/** Merge automatic and manual audiences into one station-scoped delivery per email address. */
export function resolveFleetDailyStatusDeliveryRecipients(
  automatic: FleetMailRecipient[],
  manual: FleetManualMailRecipient[],
  allStationCodes: string[],
  triggerStationCodes: string[],
  onlyAffected: boolean
) {
  const allowed = new Set(allStationCodes.map((value) => String(value).trim().toUpperCase()).filter(Boolean));
  const triggers = new Set(triggerStationCodes.map((value) => String(value).trim().toUpperCase()).filter(Boolean));
  const recipients = new Map<string, FleetMailDeliveryRecipient>();
  const merge = (emailValue: unknown, name: unknown, stationCodes: string[], source: FleetMailDeliveryRecipient["sources"][number]) => {
    const email = address(emailValue);
    if (!email) return;
    const scoped = [...new Set(stationCodes.map((value) => String(value).trim().toUpperCase()).filter((value) => allowed.has(value)))].sort();
    if (!scoped.length) return;
    const current = recipients.get(email) ?? { email, name: String(name ?? "").trim() || email, stationCodes: [], sources: [] };
    current.stationCodes = [...new Set([...current.stationCodes, ...scoped])].sort();
    current.sources = [...new Set([...current.sources, source])];
    recipients.set(email, current);
  };
  automatic.forEach((recipient) => merge(recipient.email, recipient.name, recipient.stationCodes, recipient.source));
  manual.forEach((recipient) => merge(recipient.email, recipient.name, recipient.stationCodes.length ? recipient.stationCodes : [...allowed], "manual"));
  return [...recipients.values()]
    .filter((recipient) => !onlyAffected || recipient.stationCodes.some((value) => triggers.has(value)))
    .sort((left, right) => left.email.localeCompare(right.email));
}

async function allRows<T>(query: (offset: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>) {
  const rows: T[] = [];
  for (let offset = 0; offset < 30_000; offset += 1_000) {
    const result = await query(offset);
    if (result.error) throw new Error(result.error.message);
    rows.push(...(result.data ?? []) as T[]);
    if ((result.data?.length ?? 0) < 1_000) return rows;
  }
  throw new Error("Fleet mail recipient scope exceeds the supported size.");
}

/** Resolve only active Operations users whose People/product scope includes a report station. */
export async function loadFleetDailyStatusRecipients(db: SupabaseClient, companyId: string, stations: Station[], options: { includeMappedOperations?: boolean; includeAllLocationOperations?: boolean; includeStationMailboxes?: boolean } = {}) {
  const includeMappedOperations = options.includeMappedOperations !== false;
  const includeAllLocationOperations = options.includeAllLocationOperations !== false;
  const includeStationMailboxes = options.includeStationMailboxes !== false;
  const [memberships, roles, profiles] = await Promise.all([
    allRows<Membership>((offset) => db.from("company_product_memberships")
      .select("user_id,role_id,has_all_location_access,location_scope_ids")
      .eq("company_id", companyId).eq("product_code", "operations").eq("is_active", true).order("id").range(offset, offset + 999)),
    allRows<Role>((offset) => db.from("user_roles").select("id,code,location_access_mode")
      .eq("company_id", companyId).eq("is_active", true).order("id").range(offset, offset + 999)),
    allRows<Profile>((offset) => db.from("profiles").select("id,full_name,email")
      .eq("company_id", companyId).eq("is_active", true).order("id").range(offset, offset + 999))
  ]);
  const roleById = new Map(roles.filter((role) => adHocOpsRoles.has(role.code)).map((role) => [role.id, role]));
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const recipients = new Map<string, FleetMailRecipient>();
  for (const membership of memberships) {
    const role = roleById.get(membership.role_id);
    const profile = profileById.get(membership.user_id);
    const email = address(profile?.email);
    if (!role || !profile || !email) continue;
    const allLocations = membership.has_all_location_access || role.location_access_mode === "all_locations";
    const scoped = stations.filter((station) => allLocations
      ? includeAllLocationOperations
      : includeMappedOperations && membership.location_scope_ids?.includes(station.id));
    if (!scoped.length) continue;
    const current = recipients.get(email) ?? { email, name: profile.full_name || email, stationCodes: [], source: "people" as const };
    current.stationCodes = [...new Set([...current.stationCodes, ...scoped.map((station) => String(station.station_code ?? "").trim().toUpperCase()).filter(Boolean)])].sort();
    recipients.set(email, current);
  }
  // Station-manager mailboxes remain a safe fallback because the station itself owns that mapping.
  for (const station of includeStationMailboxes ? stations : []) {
    const email = address(station.station_manager_email);
    const code = String(station.station_code ?? "").trim().toUpperCase();
    if (!email || !code) continue;
    const current = recipients.get(email) ?? { email, name: `${code} operations`, stationCodes: [], source: "station" as const };
    current.stationCodes = [...new Set([...current.stationCodes, code])].sort();
    recipients.set(email, current);
  }
  return [...recipients.values()].sort((a, b) => a.email.localeCompare(b.email));
}
