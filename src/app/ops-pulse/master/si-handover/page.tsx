import { AppShell } from "@/components/app-shell";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { context, db } from "@/lib/ops-pulse/si-handover/server";
import { SiHandoverMasterClient } from "./master-client";

export const dynamic = "force-dynamic";

export default async function Page() {
  const auth = await requirePagePermission("si_handover_master", "access");
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
    throw Error("SI handover configuration options could not be loaded.");
  return (
    <AppShell active="Ops Masters" pageCode="si_handover_master">
      <SiHandoverMasterClient
        master={c.master}
        roles={roles.data || []}
        models={models.data || []}
        editable={
          !auth.readOnly && hasPermission(auth, "si_handover_master", "edit")
        }
      />
    </AppShell>
  );
}
