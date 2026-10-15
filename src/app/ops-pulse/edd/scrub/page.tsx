import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { TrackingIdSearch } from "@/components/tracking-id-search";
import { requireCompanyId } from "@/lib/company-scope";
import { requireEddAccess } from "@/lib/ops-pulse/edd-access";
import { loadEddStations } from "@/lib/ops-pulse/edd-stations";
import { isEddWorkerConfigured } from "@/lib/ops-pulse/edd-worker";
import { EddSectionTabs } from "../edd-section-tabs";
import { ScrubReportView } from "./scrub-report-view";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export default async function ScrubReportPage({ searchParams }: { searchParams?: { type?: string } }) {
  const authorization = await requireEddAccess();
  const companyId = requireCompanyId(authorization);
  const stations = await loadEddStations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const workerConfigured = isEddWorkerConfigured();

  return (
    <AppShell active="Delivery Performance" pageCode="edd_dashboard">
      <div className="ops-command-center">
        <PageHead
          eyebrow="Ops Pulse · Scrub Report"
          title="Scrub Report"
          subtitle="Last In-Station and On-Road scrub per station, read live from Amazon's Station Command Center. Stations not scrubbed today are listed first."
          action={(
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <TrackingIdSearch />
              <span className={`status-pill ${workerConfigured ? "good" : "warn"}`}>{workerConfigured ? "Live" : "Setup needed"}</span>
            </div>
          )}
        />
        <EddSectionTabs active="scrub" />
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
            initialType={searchParams?.type === "on-road" ? "onRoad" : "inStation"}
          />
        ) : null}
      </div>
    </AppShell>
  );
}
