import { AppShell } from "@/components/app-shell";
import { DsOperationsTabs } from "@/components/ds-operations-tabs";
import { PageHead } from "@/components/page-head";
import { canViewDsOperations } from "@/lib/ops-pulse/ds-live-performance-access";
import { requireDsOperationsAccess } from "@/lib/ops-pulse/ds-live-performance-guard";
import { loadDsLivePerformance } from "@/lib/ops-pulse/ds-live-performance";
import { DsLiveView } from "./ds-live-view";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

export default async function DarkStoreLivePerformancePage({
  searchParams
}: {
  searchParams?: { date?: string };
}) {
  const authorization = await requireDsOperationsAccess("ds_live_performance");
  const canViewLive = canViewDsOperations(authorization, "ds_live_performance");
  const canViewPpi = canViewDsOperations(authorization, "ds_ppi");
  const canViewSite = canViewDsOperations(authorization, "ds_site_summary");
  const canViewColdChain = canViewDsOperations(authorization, "ds_cold_chain_alerts");
  const date = String(searchParams?.date ?? "").trim();

  let error: string | null = null;
  let payload = null;
  try {
    payload = await loadDsLivePerformance(authorization, {
      businessDate: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined
    });
  } catch (err) {
    error = err instanceof Error ? err.message : "Unable to load Dark Store live performance.";
  }

  return (
    <AppShell active="Operations" pageCode="ds_live_performance">
      <main className="ops-command-center performance-workspace dark-store">
        <PageHead
          eyebrow="Ops Pulse · Dark Store"
          title="Live performance"
          subtitle="Network PPI, Site Summary acceptance, and inbound from the WorkSpaces VM — board polls lightly; store detail loads on select."
          action={<span className="status-pill good">FSD · Admin · IST</span>}
        />
        <DsOperationsTabs active="live" canViewLive={canViewLive} canViewPpi={canViewPpi} canViewSite={canViewSite} canViewColdChain={canViewColdChain} />
        {error ? (
          <section className="panel message-panel error">
            <div className="panel-body">
              <strong>Unable to load live performance</strong>
              <p className="subtle" style={{ marginTop: 6 }}>{error}</p>
            </div>
          </section>
        ) : payload ? (
          <DsLiveView initial={payload} />
        ) : null}
      </main>
    </AppShell>
  );
}
