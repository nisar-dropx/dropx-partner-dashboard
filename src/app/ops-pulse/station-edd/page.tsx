import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { TrackingIdSearch } from "@/components/tracking-id-search";
import { requireCompanyId } from "@/lib/company-scope";
import { requireStationEddAccess } from "@/lib/ops-pulse/station-edd-access";
import { loadEddStations } from "@/lib/ops-pulse/edd-stations";
import {
  fetchEddPerformanceNetwork,
  isEddWorkerConfigured,
  type EddNetworkRunStatus,
  type EddPerformanceNetworkStation
} from "@/lib/ops-pulse/edd-worker";
import { StationEddNetworkClient } from "./station-edd-network-client";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const emptyStation = (stationCode: string): EddPerformanceNetworkStation => ({
  stationCode,
  hasSnapshot: false,
  fetchedAt: null,
  assigned: 0,
  delivered: 0,
  returned: 0,
  held: 0,
  yetToDispatch: 0,
  deliveredPct: 0,
  returnedPct: 0,
  heldPct: 0
});

export default async function StationEddPage() {
  const authorization = await requireStationEddAccess();
  const companyId = requireCompanyId(authorization);
  const stations = await loadEddStations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const workerConfigured = isEddWorkerConfigured();

  let error: string | null = null;
  let network: EddPerformanceNetworkStation[] = [];
  let run: EddNetworkRunStatus | null = null;

  if (workerConfigured && stations.length) {
    try {
      const payload = await fetchEddPerformanceNetwork();
      const byCode = new Map(payload.stations.map((row) => [row.stationCode, row]));
      network = stations.map((station) => byCode.get(station.code) ?? emptyStation(station.code));
      run = payload.run;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Unable to load today's EDD position.";
    }
  }

  return (
    <AppShell active="EDD" pageCode="station_edd">
      <div className="ops-command-center">
        <PageHead
          eyebrow="Ops Pulse · Today at station"
          title="EDD"
          subtitle="Station-level view of today's expected deliveries: what is still at station, already assigned, delivered, held, or returned."
          action={(
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <TrackingIdSearch />
              <span className={`status-pill ${workerConfigured ? "good" : "warn"}`}>{workerConfigured ? "Live" : "Setup needed"}</span>
            </div>
          )}
        />

        {!workerConfigured ? (
          <section className="panel message-panel error">
            <div className="panel-body">
              <strong>EDD worker is not configured</strong>
              <p className="subtle" style={{ marginTop: 6 }}>Connect the Amazon EDD worker in this deployment, then reload this page.</p>
            </div>
          </section>
        ) : null}

        {workerConfigured && !stations.length ? (
          <section className="panel message-panel error">
            <div className="panel-body">
              <strong>No EDD stations are available in your location scope.</strong>
            </div>
          </section>
        ) : null}

        {error ? (
          <section className="panel message-panel error">
            <div className="panel-body">
              <strong>Unable to load EDD</strong>
              <p className="subtle" style={{ marginTop: 6 }}>{error}</p>
            </div>
          </section>
        ) : null}

        {workerConfigured && stations.length ? (
          <StationEddNetworkClient stations={stations} initialNetwork={network} initialRun={run} />
        ) : null}
      </div>
    </AppShell>
  );
}
