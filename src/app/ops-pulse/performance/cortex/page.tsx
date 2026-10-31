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
  pickCortexStation,
} from "@/lib/ops-pulse/cortex-data";

export const dynamic = "force-dynamic";

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function yesterdayIst(today: string) {
  return new Date(Date.parse(today + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
}

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
  const defaultDay = yesterdayIst(today);
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
  const station = pickCortexStation(stations, one(searchParams.station));
  const query = one(searchParams.q) || "";

  let board = null;
  let loadError = scope.error ? "Station access could not be loaded." : "";
  if (!stations.length && !loadError) {
    loadError =
      "No Amazon EDSP/XPT stations with a service area are in your approved locations.";
  } else if (station) {
    try {
      board = await loadCortexBoard({ companyId, station, date });
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
          subtitle="Live Amazon routes for your approved stations — drivers, deliveries, and stop detail."
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
            board={board}
            initialQuery={query}
            key={`${station?.id || "none"}-${date}`}
          />
        )}
      </div>
    </AppShell>
  );
}
