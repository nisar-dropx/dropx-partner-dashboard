import type { SupabaseClient } from "@supabase/supabase-js";

/** Trust only an active, company-scoped People link and server-managed owner flag. */
export async function hasConnectCompanyOwnerAccess(db: SupabaseClient, companyId: string, personId: string) {
  const links = await db.from("hr_user_person_links").select("user_id")
    .eq("company_id", companyId).eq("person_id", personId).eq("status", "active");
  if (links.error) throw new Error("Unable to verify company-owner access.");
  const userIds = [...new Set((links.data ?? []).map((row) => String(row.user_id)).filter(Boolean))];
  if (!userIds.length) return false;
  const owners = await db.from("profiles").select("id")
    .eq("company_id", companyId).in("id", userIds).eq("is_active", true).eq("is_master_owner", true).limit(1);
  if (owners.error) throw new Error("Unable to verify company-owner access.");
  return Boolean(owners.data?.length);
}
