import { AppShell } from "@/components/app-shell";
import { DsOperationsTabs } from "@/components/ds-operations-tabs";
import { PageHead } from "@/components/page-head";
import { canViewDsOperations } from "@/lib/ops-pulse/ds-live-performance-access";
import { requireDsOperationsAccess } from "@/lib/ops-pulse/ds-live-performance-guard";
import { datomsWorkerConfigured, loadDatomsAlerts } from "@/lib/ops-pulse/datoms-alerts";
import { DsColdChainView } from "./ds-cold-chain-view";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export default async function DarkStoreColdChainPage() {
  const authorization = await requireDsOperationsAccess("ds_cold_chain_alerts");
  const canViewLive = canViewDsOperations(authorization, "ds_live_performance");
  const canViewPpi = canViewDsOperations(authorization, "ds_ppi");
  const canViewSite = canViewDsOperations(authorization, "ds_site_summary");
  const canViewColdChain = canViewDsOperations(authorization, "ds_cold_chain_alerts");

  let error: string | null = null;
  let alerts: Awaited<ReturnType<typeof loadDatomsAlerts>> = [];
  try {
    alerts = await loadDatomsAlerts(authorization);
  } catch (err) {
    error = err instanceof Error ? err.message : "Unable to load cold-chain alerts.";
  }

  return (
    <AppShell active="Operations" pageCode="ds_cold_chain_alerts">
      <main className="ops-command-center performance-workspace dark-store">
        <PageHead
          eyebrow="Ops Pulse · Dark Store"
          title="Cold chain alerts"
          subtitle="Datoms L2 and L3 door/temperature violations for DropX stores — WhatsApp war rooms get a card image plus caption."
          action={<span className="status-pill good">L2 · L3 live</span>}
        />
        <DsOperationsTabs
          active="cold-chain"
          canViewLive={canViewLive}
          canViewPpi={canViewPpi}
          canViewSite={canViewSite}
          canViewColdChain={canViewColdChain}
        />
        {error ? (
          <section className="panel message-panel error">
            <div className="panel-body">
              <strong>Unable to load cold-chain alerts</strong>
              <p className="subtle" style={{ marginTop: 6 }}>{error}</p>
            </div>
          </section>
        ) : (
          <DsColdChainView initialAlerts={alerts} workerConfigured={datomsWorkerConfigured()} />
        )}
      </main>
    </AppShell>
  );
}
