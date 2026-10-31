import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { currentAdminAccessSurface } from "@/lib/access-surface";
import { loadRolePageGrants } from "@/lib/access-cache";
import { getAuthorization, hasPermission, isCompanyOwner, type PagePermission, type PermissionAction } from "@/lib/authorization";
import { applyFinanceProcessingAccess } from "@/lib/payment-processing-access-policy";
import { supabaseAdmin } from "@/lib/supabase-admin";

/** Shared by the processing page, manual actions, export and bank reconciliation. */
export const getPaymentProcessingAuthorization = cache(async () => {
  const authorization = await getAuthorization();
  if (!authorization || currentAdminAccessSurface() !== "dashboard" || isCompanyOwner(authorization)
    || !hasPermission(authorization, "payment_process", "access")) return authorization;
  if (!authorization.companyId || !supabaseAdmin) throw new Error("Unable to verify Finance processing access.");
  const companyId = authorization.companyId;
  const membershipResult = await supabaseAdmin.from("company_product_memberships")
    .select("role_id,is_active,has_all_location_access,location_scope_ids")
    .eq("company_id", companyId)
    .eq("user_id", authorization.userId)
    .eq("product_code", "finance");
  if (membershipResult.error) throw new Error("Unable to verify Finance processing access. Please retry.");
  const memberships = membershipResult.data ?? [];
  if (!memberships.length) return authorization;
  const roleIds = [...new Set(memberships.filter(row => row.is_active).map(row => row.role_id).filter((id): id is string => Boolean(id)))];
  if (!roleIds.length) return applyFinanceProcessingAccess(authorization, memberships, [], {});
  const roleResult = await supabaseAdmin.from("user_roles")
    .select("id,location_access_mode")
    .eq("company_id", companyId)
    .eq("product_code", "finance")
    .eq("is_active", true)
    .in("id", roleIds);
  if (roleResult.error) throw new Error("Unable to verify Finance processing roles. Please retry.");
  const roles = roleResult.data ?? [];
  if (!roles.length) return applyFinanceProcessingAccess(authorization, memberships, [], {});
  const access = await loadRolePageGrants(companyId, roles.map(role => role.id));
  const codeById = new Map(access.pages.map(page => [page.id, page.code]));
  const permissions: Record<string, PagePermission> = {};
  for (const grant of access.grants) {
    const code = codeById.get(grant.page_id);
    if (!code) continue;
    const previous = permissions[code];
    permissions[code] = {
      canView: Boolean(previous?.canView || grant.can_view || grant.can_edit),
      canAdd: Boolean(previous?.canAdd || grant.can_add),
      canEdit: Boolean(previous?.canEdit || grant.can_edit)
    };
  }
  return applyFinanceProcessingAccess(authorization, memberships, roles, permissions);
});

export async function requirePaymentProcessingPermission(action: PermissionAction) {
  const authorization = await getPaymentProcessingAuthorization();
  if (!authorization) redirect("/login");
  if (!hasPermission(authorization, "payment_process", action)) {
    redirect(`/unauthorized?page=payment_process&action=${action}`);
  }
  return authorization;
}
