import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { TrackingIdSearch } from "@/components/tracking-id-search";
import { requireCompanyId } from "@/lib/company-scope";
import { requireEddAccess } from "@/lib/ops-pulse/edd-access";
import { loadEddStations } from "@/lib/ops-pulse/edd-stations";
import { fetchLoadFlashNetwork, isEddWorkerConfigured, type LoadFlashNetworkPayload } from "@/lib/ops-pulse/edd-worker";
import { EddSectionTabs } from "../edd-section-tabs";
import { LoadFlashView } from "./load-flash-view";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function todayKolkata() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export default async function LoadFlashPage({ searchParams }: { searchParams?: { date?: string } }) {
  const authorization = await requireEddAccess();
  const companyId = requireCompanyId(authorization);
  const stations = await loadEddStations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const workerConfigured = isEddWorkerConfigured();
  const requested = String(searchParams?.date ?? "").trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : todayKolkata();

  let error: string | null = null;
  let payload: LoadFlashNetworkPayload | null = null;
  if (workerConfigured && stations.length) {
    try {
      payload = await fetchLoadFlashNetwork(date);
      const allowed = new Set(stations.map((station) => station.code));
      payload = { ...payload, stations: payload.stations.filter((row) => allowed.has(row.stationCode)) };
    } catch (err) {
      error = err instanceof Error ? err.message : "Unable to load the station load report.";
    }
  }

  return (
    <AppShell active="Delivery Performance" pageCode="edd_dashboard">
      <div className="ops-command-center">
        <PageHead
          eyebrow="Ops Pulse · Ops Live"
          title="Ops Live"
          subtitle="The day's delivery report: how much of the morning load is delivered, what is on the road, and which stations need attention. Refreshed hourly, 6:05am to 11:05pm IST."
          action={(
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <TrackingIdSearch />
              <span className={`status-pill ${workerConfigured ? "good" : "warn"}`}>{workerConfigured ? "Hourly" : "Setup needed"}</span>
            </div>
          )}
        />
        <EddSectionTabs active="flash" />
        {!workerConfigured ? (
          <section className="panel message-panel error">
            <div className="panel-body">
              <strong>EDD worker is not configured</strong>
              <p className="subtle" style={{ marginTop: 6 }}>Set EDD_WORKER_URL and EDD_WORKER_ADMIN_KEY, then reload.</p>
            </div>
          </section>
        ) : null}
        {error ? (
          <section className="panel message-panel error">
            <div className="panel-body"><strong>Unable to load the report</strong><p className="subtle" style={{ marginTop: 6 }}>{error}</p></div>
          </section>
        ) : null}
        {workerConfigured && payload ? <LoadFlashView initial={payload} stationNames={Object.fromEntries(stations.map((station) => [station.code, station.name]))} /> : null}
      </div>
    </AppShell>
  );
}
