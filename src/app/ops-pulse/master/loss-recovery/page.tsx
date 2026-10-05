import { AppShell } from "@/components/app-shell";
import { requirePagePermission, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { NlRecoveryMaster } from "@/components/nl-recovery-master";
export const dynamic = "force-dynamic";
export default async function Page() {
  const auth = await requirePagePermission("ops_loss_master", "access");
  const company = requireCompanyId(auth);
  if (!supabaseAdmin) throw Error("Database unavailable.");
  const [o, s] = await Promise.all([
    supabaseAdmin
      .from("nl_recovery_outcomes")
      .select("*")
      .eq("company_id", company)
      .order("sort_order"),
    supabaseAdmin
      .from("nl_loss_sources")
      .select(
        "recoverable_statuses,allow_equal_split,allow_custom_split,include_inactive_people,history_months,updated_at",
      )
      .eq("company_id", company)
      .maybeSingle(),
  ]);
  if (o.error || s.error)
    throw Error("Loss Recovery Master could not be loaded.");
  return (
    <AppShell active="Ops Masters" pageCode="ops_loss_master">
    <NlRecoveryMaster
      outcomes={o.data ?? []}
      settings={s.data}
      canEdit={!auth.readOnly && hasPermission(auth, "ops_loss_master", "edit")}
    />
    </AppShell>
  );
}
