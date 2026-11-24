import { AppShell } from "@/components/app-shell";
import { DsOperationsTabs } from "@/components/ds-operations-tabs";
import { PageHead } from "@/components/page-head";
import { canViewDsOperations } from "@/lib/ops-pulse/ds-live-performance-access";
import { requireDsOperationsAccess } from "@/lib/ops-pulse/ds-live-performance-guard";
import { loadDsLivePerformance, loadDsLiveStoreDetail } from "@/lib/ops-pulse/ds-live-performance";
import { DsPpiView } from "./ds-ppi-view";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

export default async function DarkStorePpiPage({
  searchParams
}: {
  searchParams?: { date?: string; station?: string };
}) {
  const authorization = await requireDsOperationsAccess("ds_ppi");
  const canViewLive = canViewDsOperations(authorization, "ds_live_performance");
  const canViewPpi = canViewDsOperations(authorization, "ds_ppi");
  const canViewSite = canViewDsOperations(authorization, "ds_site_summary");
  const date = String(searchParams?.date ?? "").trim();
  const station = String(searchParams?.station ?? "").trim().toUpperCase();

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
    error = err instanceof Error ? err.message : "Unable to load PPI.";
  }

  return (
    <AppShell active="Operations" pageCode="ds_ppi">
      <main className="ops-command-center performance-workspace dark-store">
        <PageHead
          eyebrow="Ops Pulse · Dark Store"
          title="PPI"
          subtitle="Pick-per-item report for the selected store — associate output, sum PPT, and hourly rollups from the VM feed."
          action={<span className="status-pill good">FSD · Admin · IST</span>}
        />
        <DsOperationsTabs active="ppi" canViewLive={canViewLive} canViewPpi={canViewPpi} canViewSite={canViewSite} />
        {error ? (
          <section className="panel message-panel error">
            <div className="panel-body">
              <strong>Unable to load PPI</strong>
              <p className="subtle" style={{ marginTop: 6 }}>{error}</p>
            </div>
          </section>
        ) : network ? (
          <DsPpiView network={network} initialDetail={detail} initialStation={detail?.stationCode ?? station} />
        ) : null}
      </main>
    </AppShell>
  );
}
