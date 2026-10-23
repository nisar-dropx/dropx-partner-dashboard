import { unstable_cache } from "next/cache";
import { cache } from "react";
import { accessPages } from "@/lib/access-pages";
import { loadPeopleDesignations } from "@/lib/people-designation";
import { supabaseAdmin } from "@/lib/supabase-admin";

/**
 * Company, role and page-permission rows are read on every authenticated
 * request but change only when an administrator edits them. They are shared
 * across requests for a short window instead of being re-read each time; the
 * Users & Roles actions clear the tag so edits made here apply immediately.
 * Edits made elsewhere (for example from HRMS) apply within the window.
 *
 * Each loader throws on a query error so a failure is never cached.
 */
export const ACCESS_CACHE_TAG = "access-matrix";
const ACCESS_CACHE_SECONDS = 60;

function isMissingColumnError(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return message.includes("column") && (message.includes("does not exist") || message.includes("schema cache"));
}

export const loadCompanyAccessRow = unstable_cache(async (companyId: string) => {
  const { data, error } = await supabaseAdmin!
    .from("companies")
    .select("id, code, name, is_master, is_active")
    .eq("id", companyId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}, ["access-company-row-v1"], { revalidate: ACCESS_CACHE_SECONDS, tags: [ACCESS_CACHE_TAG] });

const loadActiveRolesCached = unstable_cache(async (companyId: string, roleIds: string[]) => {
  const { data, error } = await supabaseAdmin!
    .from("user_roles")
    .select("id, name, code, location_access_mode, is_system, is_active")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .in("id", roleIds);
  if (error) throw new Error(error.message);
  return data ?? [];
}, ["access-active-roles-v1"], { revalidate: ACCESS_CACHE_SECONDS, tags: [ACCESS_CACHE_TAG] });

export function loadActiveRoles(companyId: string, roleIds: string[]) {
  return loadActiveRolesCached(companyId, [...roleIds].sort());
}

const loadRolePageGrantsCached = unstable_cache(async (companyId: string, roleIds: string[]) => {
  let pagesResult = await supabaseAdmin!
    .from("app_pages")
    .select("id, code")
    .eq("company_id", companyId)
    .eq("is_active", true);

  if (pagesResult.error && isMissingColumnError(pagesResult.error)) {
    pagesResult = await supabaseAdmin!.from("app_pages").select("id, code").eq("is_active", true);
  }
  if (!pagesResult.error && !(pagesResult.data ?? []).length) {
    pagesResult = await supabaseAdmin!
      .from("app_pages")
      .select("id, code")
      .in("code", accessPages.map((page) => page.code))
      .is("company_id", null)
      .eq("is_active", true);
  }

  let grantsResult = await supabaseAdmin!
    .from("role_page_permissions")
    .select("page_id, can_view, can_add, can_edit")
    .eq("company_id", companyId)
    .in("role_id", roleIds);

  if (grantsResult.error && isMissingColumnError(grantsResult.error)) {
    grantsResult = await supabaseAdmin!
      .from("role_page_permissions")
      .select("page_id, can_view, can_add, can_edit")
      .in("role_id", roleIds);
  }

  if (pagesResult.error) throw new Error(pagesResult.error.message);
  if (grantsResult.error) throw new Error(grantsResult.error.message);
  return { pages: pagesResult.data ?? [], grants: grantsResult.data ?? [] };
}, ["access-role-page-grants-v1"], { revalidate: ACCESS_CACHE_SECONDS, tags: [ACCESS_CACHE_TAG] });

export function loadRolePageGrants(companyId: string, roleIds: string[]) {
  return loadRolePageGrantsCached(companyId, [...roleIds].sort());
}

// Authorization and user preview both need the signed-in user's designation;
// resolve it once per request.
export const loadPeopleDesignation = cache(async (companyId: string, userId: string) => {
  return (await loadPeopleDesignations(companyId, [userId])).get(userId);
});
