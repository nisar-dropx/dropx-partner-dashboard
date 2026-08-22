import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { requireCompanyId } from "@/lib/company-scope";
import { requireEddAccess } from "@/lib/ops-pulse/edd-access";
import { isEddWorkerConfigured } from "@/lib/ops-pulse/edd-worker";
import { loadCodLocations, loadCodStationSettings } from "@/lib/ops-pulse/cod";
import { EddClient } from "./edd-client";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export type EddStationOption = {
  code: string;
  label: string;
};

export default async function EddDashboardPage({
  searchParams
}: {
  searchParams: { station?: string };
}) {
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
      return {
        code: amazonCode,
        label: location.station_name ? `${amazonCode} — ${location.station_name}` : amazonCode
      };
    })
    .filter((row): row is EddStationOption => Boolean(row))
    .sort((a, b) => a.code.localeCompare(b.code));

  const requestedStation = String(searchParams.station ?? "").trim().toUpperCase();
  const initialStation = stations.find((row) => row.code === requestedStation)?.code || stations[0]?.code || "";

  const workerConfigured = isEddWorkerConfigured();

  return (
    <AppShell active="EDD Dashboard" pageCode="edd_dashboard">
      <div className="ops-command-center">
        <PageHead
          eyebrow="Ops Pulse · Live tracking"
          title="EDD Dashboard"
          subtitle="Every live tracking ID at a station, bucketed by Estimated Delivery Date — pulled live from Amazon's station ageing dashboard."
          action={<span className={`status-pill ${workerConfigured ? "good" : "warn"}`}>{workerConfigured ? "Live" : "Setup needed"}</span>}
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

        {workerConfigured && stations.length ? (
          <EddClient stations={stations} initialStation={initialStation} />
        ) : null}
      </div>
    </AppShell>
  );
}
