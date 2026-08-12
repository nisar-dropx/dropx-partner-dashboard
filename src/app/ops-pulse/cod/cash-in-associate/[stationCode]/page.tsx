import { Suspense } from "react";
import { CodSectionTabs } from "@/components/cod-section-tabs";
import { PageHead } from "@/components/page-head";
import { requireCompanyId } from "@/lib/company-scope";
import { requireCiaAccess } from "@/lib/ops-pulse/cia-access";
import { loadCodLocations, type CodLocationRow } from "@/lib/ops-pulse/cod";
import { fetchCiaStation, isCashReconWorkerConfigured } from "@/lib/ops-pulse/cash-recon-worker";
import { CiaStationWorkspace } from "../cia-station-workspace";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export default async function CashInAssociateStationPage({
  params
}: {
  params: { stationCode?: string; station?: string };
}) {
  const authorization = await requireCiaAccess();
  const companyId = requireCompanyId(authorization);
  const rawCode = String(params.stationCode ?? params.station ?? "").trim();
  const stationCode = decodeURIComponent(rawCode).trim().toUpperCase();

  let error: string | null = null;
  let payload: Awaited<ReturnType<typeof fetchCiaStation>> | null = null;

  if (!stationCode) {
    error = "Station code is required.";
  } else if (!isCashReconWorkerConfigured()) {
    error = "Cash recon worker is not configured. Set CASH_RECON_WORKER_URL and CASH_RECON_ADMIN_KEY.";
  } else {
    try {
      // Snapshot only on the server. Live from/to ranges are loaded client-side
      // via GET /api/ops-pulse/cod/cash-recon/cash-in-associate (same BFF pattern
      // as driver-reconciliation) so Cloudflare HTML errors never hit the UI raw.
      payload = await fetchCiaStation(stationCode);
    } catch (err) {
      error = err instanceof Error ? err.message : `Unable to load Cash In Associate for ${stationCode}.`;
    }
  }

  const displayCode = String(payload?.stationCode || stationCode || "").trim().toUpperCase();
  const locationsResult = await loadCodLocations(
    companyId,
    authorization.locationScopeIds,
    authorization.hasAllLocationAccess
  );
  const location = locationsResult.locations.find(
    (entry: CodLocationRow) => String(entry.station_code ?? "").trim().toUpperCase() === displayCode
  );
  const stationName = String(location?.station_name ?? "").trim();
  const stationTitle = location
    ? (location.station_name
      ? `${location.station_code} - ${location.station_name}`
      : String(location.station_code || displayCode))
    : (displayCode || "Station");
  const placeBits = [location?.city, location?.state].filter(Boolean).join(", ");

  return (
    <>
      <PageHead
        eyebrow="Ops Pulse · Station drill-down"
        title={displayCode || "Station"}
        subtitle={
          stationName
            ? `${stationName}${placeBits ? ` · ${placeBits}` : ""} · Cash with delivery associates`
            : "Cash still held with delivery associates — by driver, by day, or day-wise ledger"
        }
        action={
          <span className={`status-pill ${payload ? "good" : "warn"}`}>
            {payload ? "Report loaded" : error ? "Unavailable" : "Loading"}
          </span>
        }
      />
      <CodSectionTabs active="cash-in-associate" />

      <Suspense
        fallback={
          <section className="panel">
            <div className="panel-body subtle">Loading station…</div>
          </section>
        }
      >
        <CiaStationWorkspace
          stationCode={displayCode || stationCode}
          stationTitle={stationTitle}
          placeBits={placeBits}
          initialPayload={payload}
          initialError={error}
        />
      </Suspense>
    </>
  );
}
