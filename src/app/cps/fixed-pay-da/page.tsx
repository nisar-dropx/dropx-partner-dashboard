import { AppShell } from '@/components/app-shell';
import { requirePagePermission, hasPermission } from '@/lib/authorization';
import { cpsScope, loadCpsSnapshot } from '@/lib/ops-pulse/cps-data';
import { todayKolkata } from '@/lib/ops-pulse/cod';
import { fixedPayRows } from '@/lib/ops-pulse/fixed-pay-insights';
import { FixedPayInsights } from '@/components/fixed-pay-insights';
import '../cps.css';
import './fixed-pay.css';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export default async function FixedPayPage({ searchParams = {} }: { searchParams?: { from?: string; to?: string; scope?: string } }) {
  const auth = await requirePagePermission('cps_overview', 'access');
  const today = todayKolkata();
  try {
    const { companyId, selected, period } = await cpsScope(auth, {
      period: 'custom', from: searchParams.from || `${today.slice(0,7)}-01`, to: searchParams.to || today, scope: searchParams.scope,
    });
    const data = await loadCpsSnapshot(companyId, period.from, period.to, selected);
    const rows = fixedPayRows(data.da_details ?? [], selected.map(l => ({ code:l.station_code, name:l.station_name || l.station_code,
      cluster:l.cluster_manager || l.aom || 'Unassigned', region:l.region || 'Unassigned' })));
    return <AppShell active="CPS" pageCode="cps_overview"><FixedPayInsights key={`${period.from}:${period.to}:${searchParams.scope || "all"}`} rows={rows} from={period.from} to={period.to} today={today} sourceDate={data.source_dates?.shipments || null} canExport={hasPermission(auth,'cps_reports','access')} /></AppShell>;
  } catch (error) {
    console.error('Fixed pay insights', error instanceof Error ? error.message : 'Load failed');
    return <AppShell active="CPS" pageCode="cps_overview"><section className="panel panel-body"><h1>Fixed Pay DA</h1><p>Costs could not be loaded. Please retry. Date ranges can cover up to 93 days.</p><a className="button" href="/cps/fixed-pay-da">Reload current month</a></section></AppShell>;
  }
}
