import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { TrackingIdSearch } from "@/components/tracking-id-search";
import { requireCompanyId } from "@/lib/company-scope";
import { requireEddAccess } from "@/lib/ops-pulse/edd-access";
import { fetchEddNetwork, isEddWorkerConfigured, type EddNetworkRunStatus, type EddNetworkStation } from "@/lib/ops-pulse/edd-worker";
import { loadCodLocations, loadCodStationSettings } from "@/lib/ops-pulse/cod";
import { EddNetworkClient } from "./edd-network-client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export type EddStationOption = {
  code: string;
  label: string;
  name: string;
};

export default async function EddDashboardPage() {
  const authorization = await requireEddAccess();
  const companyId = requireCompanyId(authorization);

  const [locationsResult, settingsResult] = await Promise.all([
    loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess),
    loadCodStationSettings(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess)
  ]);

  const portalCodeByLocation = new Map(
    settingsResult.rows
      .filter((row) => row.portal_station_code)
      .map((row) => [row.location_id, String(row.portal_station_code).trim().toUpperCase()])
  );

  const stations: EddStationOption[] = locationsResult.locations
    .map((location) => {
      const amazonCode = portalCodeByLocation.get(location.id) || String(location.station_code ?? "").trim().toUpperCase();
      if (!amazonCode) return null;
      const name = location.station_name ? String(location.station_name) : "";
      return { code: amazonCode, label: name ? `${amazonCode} — ${name}` : amazonCode, name };
    })
    .filter((row): row is EddStationOption => Boolean(row))
    .sort((a, b) => a.code.localeCompare(b.code));

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
    <AppShell active="Delivery Performance" pageCode="edd_dashboard">
      <div className="ops-command-center">
        <PageHead
          eyebrow="Ops Pulse · Live tracking"
          title="Delivery Performance"
          subtitle="Ageing (live tracking IDs by Estimated Delivery Date) and assigned/delivered/returned/held performance, by station. Open a station for the full breakdown."
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
