import { AppShell } from "@/components/app-shell";
import { requirePagePermission } from "@/lib/authorization";
import { context, db } from "@/lib/ops-pulse/store-audits/server";
import { StoreAuditMaster } from "./master-client";
export const dynamic = "force-dynamic";
export default async function Page() {
  await requirePagePermission("store_audit_master", "access");
  const c = await context(false, true);
  const [roles, models] = await Promise.all([
    db()
      .from("user_roles")
      .select("id,name")
      .eq("company_id", c.companyId)
      .eq("is_active", true)
      .order("name"),
    db()
      .from("location_models")
      .select("id,name")
      .eq("company_id", c.companyId)
      .eq("is_active", true)
      .order("name"),
  ]);
  if (roles.error || models.error)
    throw Error("Audit configuration options could not be loaded.");
  return (
    <AppShell active="Ops Masters" pageCode="store_audit_master">
      <StoreAuditMaster
        master={c.master}
        roles={roles.data || []}
        models={models.data || []}
        editable={
          !c.auth.readOnly &&
          Boolean(
            c.auth.isMasterOwner ||
            c.auth.permissions.store_audit_master?.canEdit,
          )
        }
      />
    </AppShell>
  );
}
