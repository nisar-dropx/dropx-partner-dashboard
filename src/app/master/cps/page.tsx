import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { CpsTargets, type CpsTargetRevision } from "@/components/cps-targets";
import { requirePagePermission, hasPermission } from "@/lib/authorization";
import { cpsScope } from "@/lib/ops-pulse/cps-data";
import { todayKolkata } from "@/lib/ops-pulse/cod";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";
import "../../cps/cps.css";

export const dynamic = "force-dynamic";
export default async function Page() {
  const auth = await requirePagePermission("cps_inputs", "access");
  const scope = await cpsScope(auth, {});
  const stations = scope.all.filter(station => !station.is_xpt).map(station => station.station_code).sort();
  if (!supabaseAdmin) throw Error("CPS Master is temporarily unavailable.");
  const result = stations.length ? await readAllRows(supabaseAdmin.from("cps_station_targets")
    .select("id,station_code,target_cps,effective_from,is_active")
    .eq("company_id", scope.companyId).in("station_code", stations)
    .order("effective_from", { ascending: false }).order("id")) : { data: [], error: null };
  if (result.error) throw Error("CPS targets could not be loaded. Please retry.");
  return <AppShell active="CPS Master" pageCode="cps_inputs">
    <div className="ops-command-center cps-workspace">
      <PageHead eyebrow="OPS MASTERS" title="CPS Master" subtitle="Configure station CPS targets for OpsPulse and DropX One." />
      <CpsTargets targets={(result.data ?? []) as CpsTargetRevision[]} stations={stations} today={todayKolkata()}
        canAdd={!auth.readOnly && hasPermission(auth, "cps_inputs", "add")} />
      {!stations.length && <p>No parent or standalone stations are available in your access. Contact your CPS administrator.</p>}
    </div>
  </AppShell>;
}
