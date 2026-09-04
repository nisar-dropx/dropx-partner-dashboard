import { cache } from "react";
import { cookies, headers } from "next/headers";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { canPreviewPortalUsers, loadPeopleDesignations } from "@/lib/people-designation";

export const portalPreviewCookieName = "dropx_portal_preview_v1";
export const previewNoStoreHeaders = { "Cache-Control": "private, no-store, max-age=0", "Vary": "Cookie" };

export function previewProductCode(): string | null {
  const host = (headers().get("x-forwarded-host") ?? headers().get("host") ?? "").split(":")[0].toLowerCase();
  if (host.includes("workforce")) return "workforce";
  if (host === "ops.dropxlogistics.com" || host.startsWith("ops-") || host.startsWith("dropx-ops-pulse")) return "operations";
  if (host === "fin.dropxlogistics.com" || host === "finance.dropxlogistics.com") return "finance";
  return null;
}

// Rechecked on every request: removing a membership also ends access to its preview.
export const hasPreviewProductAccess = cache(async (companyId: string, userId: string, masterOwner: boolean) => {
  if (!supabaseAdmin) return false;
  const product = previewProductCode();
  if (!product || masterOwner) return true;
  const [membership, owner] = await Promise.all([
    supabaseAdmin.from("company_product_memberships").select("user_id")
      .eq("company_id", companyId).eq("user_id", userId).eq("product_code", product).eq("is_active", true).limit(1),
    supabaseAdmin.from("company_product_owners").select("user_id")
      .eq("company_id", companyId).eq("user_id", userId).eq("product_code", product).eq("is_active", true).limit(1)
  ]);
  return !membership.error && !owner.error && Boolean(membership.data?.length || owner.data?.length);
});

export const getSignedInPreviewProfile = cache(async () => {
  const client = createServerSupabaseClient();
  if (!client || !supabaseAdmin) return null;
  const { data } = await client.auth.getUser();
  if (!data.user) return null;
  const { data: profile, error } = await supabaseAdmin.from("profiles")
    .select("id,company_id,full_name,is_master_owner,role_id,is_active").eq("id", data.user.id).maybeSingle();
  if (error || !profile?.is_active || !profile.company_id) return null;
  return profile;
});

export const getPreviewViewer = cache(async () => {
  const profile = await getSignedInPreviewProfile();
  if (!profile || !supabaseAdmin) return null;
  const [company, role, designations] = await Promise.all([
    supabaseAdmin.from("companies").select("is_active").eq("id", profile.company_id).maybeSingle(),
    profile.role_id ? supabaseAdmin.from("user_roles").select("code,is_active").eq("company_id", profile.company_id).eq("id", profile.role_id).maybeSingle() : Promise.resolve({ data: null }),
    loadPeopleDesignations(profile.company_id, [profile.id])
  ]);
  if (!company.data?.is_active) return null;
  const eligible = canPreviewPortalUsers(Boolean(profile.is_master_owner), role.data?.is_active ? role.data.code : null, designations.get(profile.id));
  return eligible && await hasPreviewProductAccess(profile.company_id, profile.id, Boolean(profile.is_master_owner)) ? profile : null;
});

export async function listPreviewUsers(viewer: NonNullable<Awaited<ReturnType<typeof getPreviewViewer>>>) {
  if (!supabaseAdmin) return [];
  const profiles = await supabaseAdmin.from("profiles")
    .select("id,full_name,email,role_id,location_scope_ids,is_master_owner")
    .eq("company_id", viewer.company_id).eq("is_active", true).order("full_name");
  if (profiles.error) throw new Error("Unable to load portal users.");
  const product = previewProductCode();
  const [memberships, owners, roles, designations] = await Promise.all([
    product ? supabaseAdmin.from("company_product_memberships").select("user_id,role_id,location_scope_ids,has_all_location_access")
      .eq("company_id", viewer.company_id).eq("product_code", product).eq("is_active", true) : Promise.resolve({ data: [], error: null }),
    product ? supabaseAdmin.from("company_product_owners").select("user_id")
      .eq("company_id", viewer.company_id).eq("product_code", product).eq("is_active", true) : Promise.resolve({ data: [], error: null }),
    supabaseAdmin.from("user_roles").select("id,name,code,location_access_mode").eq("company_id", viewer.company_id).eq("is_active", true),
    loadPeopleDesignations(viewer.company_id, (profiles.data ?? []).map(row => row.id))
  ]);
  if (memberships.error || owners.error || roles.error) throw new Error("Unable to verify portal access.");
  const roleById = new Map((roles.data ?? []).map(row => [row.id, row]));
  const ownerIds = new Set((owners.data ?? []).map(row => row.user_id));
  return (profiles.data ?? []).flatMap(profile => {
    const grants = (memberships.data ?? []).filter(row => row.user_id === profile.id);
    if (product && !profile.is_master_owner && !grants.length && !ownerIds.has(profile.id)) return [];
    const role = roleById.get(grants.find(row => row.role_id)?.role_id ?? profile.role_id);
    const locations = [...new Set(grants.length ? grants.flatMap(row => row.location_scope_ids ?? []) : profile.location_scope_ids ?? [])];
    return [{
      id: profile.id, name: profile.full_name || profile.email || "Portal user", email: profile.email || "",
      role: designations.get(profile.id)?.name || role?.name || "Location / portal user",
      scope: profile.is_master_owner || role?.location_access_mode === "all_locations" || grants.some(row => row.has_all_location_access)
        ? "All locations" : `${locations.length} locations`
    }];
  });
}

export function selectedPreviewUserId(viewerId: string) {
  const value = cookies().get(portalPreviewCookieName)?.value ?? "";
  const [actor, target] = value.split(":");
  return actor === viewerId && /^[0-9a-f-]{36}$/i.test(target ?? "") ? target : null;
}
