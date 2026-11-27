import { AppShell } from "@/components/app-shell";
import { DsOperationsTabs } from "@/components/ds-operations-tabs";
import { PageHead } from "@/components/page-head";
import { canViewDsOperations } from "@/lib/ops-pulse/ds-live-performance-access";
import { requireDsOperationsAccess } from "@/lib/ops-pulse/ds-live-performance-guard";
import { loadDsWorkforcePulse } from "@/lib/ops-pulse/ds-workforce-pulse";
import { DsWorkforcePulseView } from "./ds-workforce-pulse-view";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function DarkStoreWorkforcePulsePage({
  searchParams
}: {
  searchParams?: { date?: string };
}) {
  const authorization = await requireDsOperationsAccess("ds_workforce_pulse");
  const canViewLive = canViewDsOperations(authorization, "ds_live_performance");
  const canViewPpi = canViewDsOperations(authorization, "ds_ppi");
  const canViewSite = canViewDsOperations(authorization, "ds_site_summary");
  const canViewDatoms = canViewDsOperations(authorization, "ds_datoms");
  const canViewPulse = canViewDsOperations(authorization, "ds_workforce_pulse");
  const canViewPolicies = canViewDsOperations(authorization, "ds_message_policies");
  const date = String(searchParams?.date ?? "").trim();

  let error: string | null = null;
  let payload = null;
  try {
    payload = await loadDsWorkforcePulse(authorization, {
      businessDate: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined
    });
  } catch (err) {
    error = err instanceof Error ? err.message : "Unable to load Workforce Pulse.";
  }

  return (
    <AppShell active="Operations" pageCode="ds_workforce_pulse">
      <main className="ops-command-center performance-workspace dark-store">
        <PageHead
          eyebrow="Ops Pulse · Dark Store"
          title="Workforce Pulse"
          subtitle="Rostered vs live HC, order spikes, and required headcount by hour from PPI demand ÷ productivity targets."
          action={<span className="status-pill good">Live + planner · IST</span>}
        />
        <DsOperationsTabs
          active="pulse"
          canViewLive={canViewLive}
          canViewPpi={canViewPpi}
          canViewSite={canViewSite}
          canViewDatoms={canViewDatoms}
          canViewPulse={canViewPulse}
          canViewPolicies={canViewPolicies}
        />
        {error ? (
          <section className="panel message-panel error">
            <div className="panel-body">
              <strong>Unable to load Workforce Pulse</strong>
              <p className="subtle" style={{ marginTop: 6 }}>{error}</p>
            </div>
          </section>
        ) : payload ? (
          <DsWorkforcePulseView initial={payload} />
        ) : null}
      </main>
    </AppShell>
  );
}
