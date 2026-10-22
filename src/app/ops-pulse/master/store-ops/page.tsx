import { AppShell } from "@/components/app-shell";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { context, db } from "@/lib/ops-pulse/store-ops/server";
import { StoreOpsMasterClient } from "./master-client";

export const dynamic = "force-dynamic";

export default async function Page() {
  const auth = await requirePagePermission("store_ops_master", "access");
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
    throw Error("Store operations configuration options could not be loaded.");
  return (
    <AppShell active="Ops Masters" pageCode="store_ops_master">
      <StoreOpsMasterClient
        master={c.master}
        roles={roles.data || []}
        models={models.data || []}
        editable={
          !auth.readOnly && hasPermission(auth, "store_ops_master", "edit")
        }
      />
    </AppShell>
  );
}
