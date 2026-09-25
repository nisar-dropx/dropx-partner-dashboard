import { CodSectionTabs } from "@/components/cod-section-tabs";
import { PageHead } from "@/components/page-head";
import { requireCompanyId } from "@/lib/company-scope";
import { requireCiaAccess } from "@/lib/ops-pulse/cia-access";
import { formatAmount, formatDateTime, loadCodLocations } from "@/lib/ops-pulse/cod";
import { fetchCiaNetwork, isCashReconWorkerConfigured, workerErrorCode } from "@/lib/ops-pulse/cash-recon-worker";
import { CiaNetworkClient } from "./cia-client";
import { CiaEmptyState } from "./cia-empty-state";
import { CiaSummaryMetrics } from "./cia-summary-metrics";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export default async function CashInAssociateNetworkPage() {
  const authorization = await requireCiaAccess();
  const companyId = requireCompanyId(authorization);

  let error: string | null = null;
  let errorCode: string | null = null;
  let payload: Awaited<ReturnType<typeof fetchCiaNetwork>> | null = null;

  if (!isCashReconWorkerConfigured()) {
    error = "Cash recon worker is not configured. Set CASH_RECON_WORKER_URL and CASH_RECON_ADMIN_KEY.";
    errorCode = "WORKER_NOT_CONFIGURED";
  } else {
    try {
      payload = await fetchCiaNetwork();
    } catch (err) {
      error = err instanceof Error ? err.message : "Unable to load Cash In Associate network snapshot.";
      errorCode = workerErrorCode(err);
    }
  }

  // The cash-recon worker's network snapshot has no location filter of its
  // own and returns every station in the company — scope it down to the
  // viewer's own station(s) here, the same way every other ops-pulse/cod
  // page does via loadCodLocations, instead of showing every station to
  // anyone who merely has CIA access.
  if (payload && !authorization.hasAllLocationAccess) {
    const { locations } = await loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
    const scopedStationCodes = new Set(locations.map((location) => String(location.station_code ?? "").trim().toUpperCase()));
    const scopedStations = payload.stations.filter((station) => scopedStationCodes.has(String(station.stationCode ?? "").trim().toUpperCase()));
    // Recompute the summary totals from the scoped station list too — the
    // worker's totals reflect the full unfiltered network snapshot.
    const scopedTotals = scopedStations.reduce((acc, station) => ({
      ciaTotal: acc.ciaTotal + (Number(station.ciaTotal) || 0),
      cashAtStationTotal: acc.cashAtStationTotal + (Number(station.cashAtStationTotal) || 0),
      ageingTotal: acc.ageingTotal + (Number(station.ageingTotal) || 0),
      depositedTotal: acc.depositedTotal + (Number(station.depositedTotal) || 0),
      pendingLiability: acc.pendingLiability + (Number(station.pendingLiability) || 0),
      clearedInWindow: acc.clearedInWindow,
      cashDifference: acc.cashDifference + (Number(station.cashDifference) || 0),
      difference: acc.difference + (Number(station.cashDifference) || 0),
      shipmentCount: acc.shipmentCount,
      pendingDriverCount: acc.pendingDriverCount + (Number(station.pendingDriverCount) || 0),
      limitedByRemittanceWindow: acc.limitedByRemittanceWindow
    }), { ...payload.totals, ciaTotal: 0, cashAtStationTotal: 0, ageingTotal: 0, depositedTotal: 0, pendingLiability: 0, cashDifference: 0, difference: 0, pendingDriverCount: 0 });
    payload = { ...payload, stations: scopedStations, totals: scopedTotals };
  }

  const totals = payload?.totals;
  // The refresh-progress banner ("Refresh X/38 stations") reflects the
  // network-wide refresh run, the same thing "Refresh all stations" starts —
  // a location-scoped user can't see that button (cia-client.tsx hides it
  // for them), so they must not see its progress either. Without this, a
  // scoped user loading the page while someone else's (or the background
  // cron's) network-wide refresh was running saw "Refresh 38/38" banners
  // and counts for a run that has nothing to do with their own 1-station
  // view, which read as if the station filtering itself were broken.
  const refresh = authorization.hasAllLocationAccess ? payload?.refreshProgress : null;
  const refreshActive = Boolean(refresh && refresh.status === "running");

  return (
    <>
      <PageHead
        eyebrow="Ops Pulse · Manager analysis"
        title="Cash In Associate"
        subtitle="Cash still with delivery associates across stations. Open a station for driver detail and day-wise ledger."
        action={
          <span className={`status-pill ${payload ? "good" : "warn"}`}>
            {refreshActive
              ? `Refresh ${refresh?.stationsOk ?? 0}/${refresh?.stationsTotal ?? "…"}`
              : payload?.run?.status
                ? `Report ${payload.run.status}`
                : errorCode === "NO_CIA_SNAPSHOT"
                  ? "No snapshot"
                  : errorCode === "CIA_SCHEMA_MISSING" || errorCode === "WORKER_NOT_CONFIGURED"
                    ? "Setup needed"
                    : error
                      ? "Unavailable"
                      : "Loading"}
          </span>
        }
      />
      <CodSectionTabs active="cash-in-associate" />

      {error ? <CiaEmptyState code={errorCode} message={error} /> : null}

      {payload && totals ? (
        <>
          <CiaSummaryMetrics totals={totals} />

          <section className="panel cia-run-meta">
            <div className="panel-body">
              <div className="cia-run-meta-grid">
                <div>
                  <span>As of</span>
                  <strong>{payload.asOfDate || "—"}</strong>
                </div>
                <div>
                  <span>Stations shown</span>
                  <strong>
                    {payload.stations.length}
                    /{payload.run?.stationsTotal ?? payload.stations.length}
                  </strong>
                </div>
                <div>
                  <span>{refreshActive ? "Refresh started" : "Fetched"}</span>
                  <strong>
                    {refreshActive && refresh?.startedAt
                      ? formatDateTime(refresh.startedAt)
                      : payload.run?.finishedAt
                        ? formatDateTime(payload.run.finishedAt)
                        : "—"}
                  </strong>
                </div>
                <div>
                  <span>Cash at station</span>
                  <strong>₹{formatAmount(totals.cashAtStationTotal)}</strong>
                </div>
              </div>
            </div>
          </section>

          <CiaNetworkClient
            stations={payload.stations}
            asOfDate={payload.asOfDate}
            windowFrom={payload.window.from}
            windowTo={payload.window.to}
            runStatus={refreshActive ? "running" : payload.run?.status ?? null}
            initialRefreshProgress={refresh ?? null}
            backgroundCron={payload.backgroundCron ?? null}
            hasAllLocationAccess={authorization.hasAllLocationAccess}
          />
        </>
      ) : null}
    </>
  );
}
