import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { requireCompanyId } from "@/lib/company-scope";
import { requireEddAccess } from "@/lib/ops-pulse/edd-access";
import { loadEddStations } from "@/lib/ops-pulse/edd-stations";
import { isEddWorkerConfigured } from "@/lib/ops-pulse/edd-worker";
import { loadFlashClusters } from "@/lib/ops-pulse/load-flash-access";
import { ScrubReportView } from "./scrub-report-view";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export default async function ScrubReportPage() {
  const authorization = await requireEddAccess();
  const companyId = requireCompanyId(authorization);
  const stations = await loadEddStations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const workerConfigured = isEddWorkerConfigured();
  const clusters = workerConfigured ? await loadFlashClusters(companyId, stations) : [];

  return (
    <AppShell active="Scrub" pageCode="edd_dashboard">
      <div className="ops-command-center">
        <PageHead
          eyebrow="Operations"
          title="Scrub"
          subtitle="In-station and on-road · all stations in scope"
        />
        {!workerConfigured ? (
          <section className="panel message-panel error">
            <div className="panel-body">
              <strong>EDD worker is not configured</strong>
              <p className="subtle" style={{ marginTop: 6 }}>Set EDD_WORKER_URL and EDD_WORKER_ADMIN_KEY, then reload.</p>
            </div>
          </section>
        ) : null}
        {workerConfigured && !stations.length ? (
          <section className="panel message-panel error">
            <div className="panel-body"><strong>No stations found</strong><p className="subtle" style={{ marginTop: 6 }}>No Amazon stations are in your location scope.</p></div>
          </section>
        ) : null}
        {workerConfigured && stations.length ? (
          <ScrubReportView
            stationNames={Object.fromEntries(stations.map((station) => [station.code, station.name]))}
            clusters={clusters}
          />
        ) : null}
      </div>
    </AppShell>
  );
}
