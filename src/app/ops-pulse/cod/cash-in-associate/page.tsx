import { CodSectionTabs } from "@/components/cod-section-tabs";
import { PageHead } from "@/components/page-head";
import { requireCiaAccess } from "@/lib/ops-pulse/cia-access";
import { formatAmount, formatDateTime } from "@/lib/ops-pulse/cod";
import { fetchCiaNetwork, isCashReconWorkerConfigured, workerErrorCode } from "@/lib/ops-pulse/cash-recon-worker";
import { CiaNetworkClient } from "./cia-client";
import { CiaEmptyState } from "./cia-empty-state";
import { CiaSummaryMetrics } from "./cia-summary-metrics";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export default async function CashInAssociateNetworkPage() {
  await requireCiaAccess();

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

  const totals = payload?.totals;
  const refresh = payload?.refreshProgress;
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
          />
        </>
      ) : null}
    </>
  );
}
