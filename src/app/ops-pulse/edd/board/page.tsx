import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { TrackingIdSearch } from "@/components/tracking-id-search";
import { requireCompanyId } from "@/lib/company-scope";
import { requireEddAccess } from "@/lib/ops-pulse/edd-access";
import { loadEddStations } from "@/lib/ops-pulse/edd-stations";
import { fetchLoadFlashBoard, isEddWorkerConfigured, type LoadFlashBoardNetwork } from "@/lib/ops-pulse/edd-worker";
import { EddSectionTabs } from "../edd-section-tabs";
import { StationBoardView } from "./station-board-view";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function todayKolkata() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export default async function StationBoardPage({
  searchParams,
}: {
  searchParams?: { date?: string; region?: string; view?: string };
}) {
  const authorization = await requireEddAccess();
  const companyId = requireCompanyId(authorization);
  const stations = await loadEddStations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
  const workerConfigured = isEddWorkerConfigured();
  const requested = String(searchParams?.date ?? "").trim();
  const today = todayKolkata();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : today;

  let error: string | null = null;
  let payload: LoadFlashBoardNetwork | null = null;
  if (workerConfigured && stations.length) {
    try {
      payload = await fetchLoadFlashBoard(date);
      const allowed = new Set(stations.map((station) => station.code));
      payload = { ...payload, stations: payload.stations.filter((row) => allowed.has(row.stationCode)) };
    } catch (err) {
      error = err instanceof Error ? err.message : "Unable to load the station board.";
    }
  }

  return (
    <AppShell active="Live performance" pageCode="edd_dashboard">
      <div className="ops-command-center">
        <PageHead
          eyebrow="Ops Pulse · Station board"
          title="Live performance"
          subtitle="EDD, C-Return, DSR and zero-delivery boards by station — hourly Ops Live refresh, Excel, WhatsApp images and tracking IDs."
          action={(
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <TrackingIdSearch />
              <span className={`status-pill ${workerConfigured ? "good" : "warn"}`}>{workerConfigured ? "Hourly" : "Setup needed"}</span>
            </div>
          )}
        />
        <EddSectionTabs active="board" />
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
            <div className="panel-body">
              <strong>Unable to load the board</strong>
              <p className="subtle" style={{ marginTop: 6 }}>{error}</p>
            </div>
          </section>
        ) : null}
        {workerConfigured && payload ? (
          <StationBoardView
            initial={payload}
            stationNames={Object.fromEntries(stations.map((station) => [station.code, station.name]))}
            initialRegion={String(searchParams?.region ?? "")}
            initialView={String(searchParams?.view ?? "")}
          />
        ) : null}
      </div>
    </AppShell>
  );
}
