import { AppShell } from "@/components/app-shell";
import { DsOperationsTabs } from "@/components/ds-operations-tabs";
import { PageHead } from "@/components/page-head";
import { canViewDsOperations } from "@/lib/ops-pulse/ds-live-performance-access";
import { requireDsOperationsAccess } from "@/lib/ops-pulse/ds-live-performance-guard";
import { loadDsLivePerformance, loadDsLiveStoreDetail } from "@/lib/ops-pulse/ds-live-performance";
import { DsSiteSummaryView } from "./ds-site-summary-view";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

export default async function DarkStoreSiteSummaryPage({
  searchParams
}: {
  searchParams?: { station?: string; date?: string };
}) {
  const authorization = await requireDsOperationsAccess("ds_site_summary");
  const canViewLive = canViewDsOperations(authorization, "ds_live_performance");
  const canViewPpi = canViewDsOperations(authorization, "ds_ppi");
  const canViewSite = canViewDsOperations(authorization, "ds_site_summary");
  const station = String(searchParams?.station ?? "").trim().toUpperCase();
  const date = String(searchParams?.date ?? "").trim();

  let error: string | null = null;
  let network = null;
  let detail = null;
  try {
    network = await loadDsLivePerformance(authorization, {
      businessDate: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined
    });
    const selected = station && network.stores.some((s) => s.stationCode === station)
      ? station
      : network.stores[0]?.stationCode ?? "";
    if (selected) {
      detail = await loadDsLiveStoreDetail(authorization, selected, { businessDate: network.businessDate });
    }
  } catch (err) {
    error = err instanceof Error ? err.message : "Unable to load Site Summary.";
  }

  return (
    <AppShell active="Operations" pageCode="ds_site_summary">
      <main className="ops-command-center performance-workspace dark-store">
        <PageHead
          eyebrow="Ops Pulse · Dark Store"
          title="Site Summary"
          subtitle="Associate status and active orders from the Site Summary monitor — Actual / Target clocks highlight SLA breaches."
          action={<span className="status-pill good">Live feed · IST</span>}
        />
        <DsOperationsTabs active="site" canViewLive={canViewLive} canViewPpi={canViewPpi} canViewSite={canViewSite} />
        {error ? (
          <section className="panel message-panel error">
            <div className="panel-body">
              <strong>Unable to load Site Summary</strong>
              <p className="subtle" style={{ marginTop: 6 }}>{error}</p>
            </div>
          </section>
        ) : network ? (
          <DsSiteSummaryView network={network} initialDetail={detail} initialStation={detail?.stationCode ?? station} />
        ) : null}
      </main>
    </AppShell>
  );
}
