import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PerformanceWorkspaceTabs } from "@/components/performance-workspace-tabs";
import { CortexWorkspace } from "@/components/cortex-workspace";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCodLocations, todayKolkata } from "@/lib/ops-pulse/cod";
import { resolveOperatingContext } from "@/lib/ops-pulse/operating-context";
import {
  loadCortexBoard,
  loadCortexStations,
} from "@/lib/ops-pulse/cortex-data";

export const dynamic = "force-dynamic";

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const selectedIds = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value : [value || ""])
    .flatMap((item) => item.split(","))
    .map((item) => item.trim())
    .filter(Boolean);
const MAX_SELECTED_STATIONS = 8;

export default async function CortexPerformancePage({
  searchParams = {},
}: {
  searchParams?: Params;
}) {
  const auth = await requirePagePermission("performance", "access");
  const companyId = requireCompanyId(auth);
  const scope = await loadCodLocations(
    companyId,
    auth.locationScopeIds,
    auth.hasAllLocationAccess,
  );
  const operating = resolveOperatingContext(scope.locations);
  const darkStore = operating.mode === "amazon_now";

  if (darkStore) {
    return (
      <AppShell active="Cortex" pageCode="performance">
        <div className="ops-command-center">
          <PageHead
            eyebrow="Performance"
            title="Cortex"
            subtitle="Amazon itinerary board is available on Amazon EDSP stations."
          />
          <PerformanceWorkspaceTabs
            active="cortex"
            canViewReviews={hasPermission(auth, "performance_review", "access")}
            canViewReviewStatus={hasPermission(auth, "performance_review_status", "access")}
            darkStore
          />
          <section className="panel message-panel">
            <div className="panel-body">
              <strong>Not available in Dark Store mode</strong>
              <p className="subtle">
                Switch the operating mode to Amazon EDSP to open Cortex for last-mile stations.
              </p>
            </div>
          </section>
        </div>
      </AppShell>
    );
  }

  const today = todayKolkata();
  const defaultDay = today;
  const requestedDate = one(searchParams.date) || defaultDay;
  const date =
    /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) && requestedDate <= today
      ? requestedDate
      : defaultDay;

  const stations = await loadCortexStations(
    companyId,
    auth.locationScopeIds,
    auth.hasAllLocationAccess,
  );
  const allowedIds = new Set(stations.map((station) => station.id));
  const requestedStationIds = selectedIds(searchParams.stations ?? searchParams.station)
    .filter((id) => allowedIds.has(id))
    .slice(0, MAX_SELECTED_STATIONS);
  const effectiveStationIds = requestedStationIds.length
    ? requestedStationIds
    : stations[0]
      ? [stations[0].id]
      : [];
  const selectedStations = effectiveStationIds
    .map((id) => stations.find((station) => station.id === id))
    .filter((station): station is NonNullable<typeof station> => Boolean(station));
  const query = one(searchParams.q) || "";

  let boards: Awaited<ReturnType<typeof loadCortexBoard>>[] = [];
  let loadError = scope.error ? "Station access could not be loaded." : "";
  if (!stations.length && !loadError) {
    loadError =
      "No Amazon EDSP/XPT stations with a service area are in your approved locations.";
  } else if (selectedStations.length) {
    try {
      boards = await Promise.all(
        selectedStations.map((station) => loadCortexBoard({ companyId, station, date })),
      );
    } catch (e) {
      loadError = e instanceof Error ? e.message : "Cortex board could not be loaded.";
    }
  }

  return (
    <AppShell active="Cortex" pageCode="performance">
      <div className="ops-command-center">
        <PageHead
          eyebrow="Performance"
          title="Cortex"
          subtitle="Live Amazon routes for your approved stations — drivers, deliveries, map, and stop detail."
        />
        <PerformanceWorkspaceTabs
          active="cortex"
          canViewReviews={hasPermission(auth, "performance_review", "access")}
          canViewReviewStatus={hasPermission(auth, "performance_review_status", "access")}
        />
        {loadError ? (
          <section className="panel message-panel error">
            <div className="panel-body">
              <strong>Cortex unavailable</strong>
              <p className="subtle">{loadError}</p>
            </div>
          </section>
        ) : (
          <CortexWorkspace
            stations={stations}
            boards={boards}
            selectedStationIds={effectiveStationIds}
            initialQuery={query}
            key={`${effectiveStationIds.join(",") || "none"}-${date}`}
          />
        )}
      </div>
    </AppShell>
  );
}
