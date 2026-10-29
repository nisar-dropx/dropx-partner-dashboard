import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { TrackingIdSearch } from "@/components/tracking-id-search";
import { requireCompanyId } from "@/lib/company-scope";
import { requireEddAccess } from "@/lib/ops-pulse/edd-access";
import { loadEddStations } from "@/lib/ops-pulse/edd-stations";
import { fetchEddNetwork, isEddWorkerConfigured, type EddNetworkRunStatus, type EddNetworkStation } from "@/lib/ops-pulse/edd-worker";
import { EddSectionTabs } from "./edd-section-tabs";
import { EddNetworkClient } from "./edd-network-client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function EddDashboardPage() {
  const authorization = await requireEddAccess();
  const companyId = requireCompanyId(authorization);
  const stations = await loadEddStations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const workerConfigured = isEddWorkerConfigured();

  let error: string | null = null;
  let network: EddNetworkStation[] = [];
  let run: EddNetworkRunStatus | null = null;
  if (workerConfigured && stations.length) {
    try {
      const payload = await fetchEddNetwork();
      const byCode = new Map(payload.stations.map((row) => [row.stationCode, row]));
      network = stations.map((station) => byCode.get(station.code) ?? {
        stationCode: station.code,
        hasSnapshot: false,
        fetchedAt: null,
        totalCount: 0,
        buckets: { overdue: 0, dueToday: 0, dueTomorrow: 0, future: 0, unknown: 0 }
      });
      run = payload.run;
    } catch (err) {
      error = err instanceof Error ? err.message : "Unable to load the EDD network overview.";
    }
  }

  return (
    <AppShell active="Live performance" pageCode="edd_dashboard">
      <div className="ops-command-center">
        <PageHead
          eyebrow="Ops Pulse · Live tracking"
          title="Live performance"
          subtitle="Ageing: live tracking IDs bucketed by Estimated Delivery Date. Open a station for the full breakdown."
          action={(
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <TrackingIdSearch />
              <span className={`status-pill ${workerConfigured ? "good" : "warn"}`}>{workerConfigured ? "Live" : "Setup needed"}</span>
            </div>
          )}
        />
        <EddSectionTabs active="ageing" />

        {!workerConfigured ? (
          <section className="panel message-panel error">
            <div className="panel-body">
              <strong>EDD worker is not configured</strong>
              <p className="subtle" style={{ marginTop: 6 }}>
                Set <code>EDD_WORKER_URL</code> and <code>EDD_WORKER_ADMIN_KEY</code> in this deployment&apos;s environment
                variables, pointing at the amazon-edd-worker service, then reload this page.
              </p>
            </div>
          </section>
        ) : null}

        {workerConfigured && !stations.length ? (
          <section className="panel message-panel error">
            <div className="panel-body">
              <strong>No stations found</strong>
              <p className="subtle" style={{ marginTop: 6 }}>
                Add an active station under Ops Masters &gt; Station Master (optionally with a Portal Station Code in
                COD Master if it differs from the internal station code) before using the EDD dashboard.
              </p>
            </div>
          </section>
        ) : null}

        {error ? (
          <section className="panel message-panel error">
            <div className="panel-body">
              <strong>Unable to load the network overview</strong>
              <p className="subtle" style={{ marginTop: 6 }}>{error}</p>
            </div>
          </section>
        ) : null}

        {workerConfigured && stations.length ? (
          <EddNetworkClient stations={stations} initialNetwork={network} initialRun={run} />
        ) : null}
      </div>
    </AppShell>
  );
}
