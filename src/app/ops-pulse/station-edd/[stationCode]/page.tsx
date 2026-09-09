import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCodLocations, loadCodStationSettings } from "@/lib/ops-pulse/cod";
import { requireStationEddAccess } from "@/lib/ops-pulse/station-edd-access";
import { fetchEddAllowedStations, isEddWorkerConfigured } from "@/lib/ops-pulse/edd-worker";
import { StationEddDetailClient } from "./station-edd-detail-client";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export default async function StationEddDetailPage({ params }: { params: { stationCode: string } }) {
  const authorization = await requireStationEddAccess();
  const companyId = requireCompanyId(authorization);
  const stationCode = decodeURIComponent(String(params.stationCode ?? "")).trim().toUpperCase();
  const [locationsResult, settingsResult] = await Promise.all([
    loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess),
    loadCodStationSettings(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess)
  ]);
  const portalCodeByLocation = new Map(
    settingsResult.rows
      .filter((row) => row.portal_station_code)
      .map((row) => [row.location_id, String(row.portal_station_code).trim().toUpperCase()])
  );
  const location = locationsResult.locations.find((entry) => {
    const code = portalCodeByLocation.get(entry.id) || String(entry.station_code ?? "").trim().toUpperCase();
    return code === stationCode;
  });
  const scopeCodes = new Set(locationsResult.locations.map((entry) => portalCodeByLocation.get(entry.id) || String(entry.station_code ?? "").trim().toUpperCase()).filter(Boolean));
  const workerConfigured = isEddWorkerConfigured();
  let workerAllowed = true;
  if (workerConfigured) {
    try {
      workerAllowed = (await fetchEddAllowedStations()).has(stationCode);
    } catch {
      workerAllowed = true;
    }
  }
  const authorized = Boolean(stationCode && scopeCodes.has(stationCode) && workerAllowed);
  const stationName = String(location?.station_name ?? "").trim();
  const place = [location?.city, location?.state].filter(Boolean).join(", ");

  return (
    <AppShell active="EDD" pageCode="station_edd">
      <div className="ops-command-center">
        <PageHead
          eyebrow="Ops Pulse · Station EDD"
          title={stationCode || "Station EDD"}
          subtitle={stationName ? `${stationName}${place ? ` · ${place}` : ""} · today's expected-delivery position` : "Today's expected-delivery position and tracking-ID detail."}
          action={<span className={`status-pill ${workerConfigured ? "good" : "warn"}`}>{workerConfigured ? "Live" : "Setup needed"}</span>}
        />

        {!workerConfigured ? (
          <section className="panel message-panel error"><div className="panel-body"><strong>EDD worker is not configured.</strong></div></section>
        ) : !authorized ? (
          <section className="panel message-panel error">
            <div className="panel-body">
              <strong>Station not available</strong>
              <p className="subtle" style={{ marginTop: 6 }}>{stationCode || "This station"} is not in your assigned location scope. <Link href="/station-edd">Return to EDD</Link>.</p>
            </div>
          </section>
        ) : (
          <StationEddDetailClient stationCode={stationCode} />
        )}
      </div>
    </AppShell>
  );
}
