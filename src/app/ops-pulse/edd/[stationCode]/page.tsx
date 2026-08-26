import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { requireCompanyId } from "@/lib/company-scope";
import { requireEddAccess } from "@/lib/ops-pulse/edd-access";
import { isEddWorkerConfigured } from "@/lib/ops-pulse/edd-worker";
import { loadCodLocations, loadCodStationSettings } from "@/lib/ops-pulse/cod";
import { EddStationTabs } from "./edd-station-tabs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function EddStationPage({
  params
}: {
  params: { stationCode: string };
}) {
  const authorization = await requireEddAccess();
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

  const allowedCodes = new Set(
    locationsResult.locations
      .map((location) => portalCodeByLocation.get(location.id) || String(location.station_code ?? "").trim().toUpperCase())
      .filter(Boolean)
  );
  const location = locationsResult.locations.find((entry) => {
    const code = portalCodeByLocation.get(entry.id) || String(entry.station_code ?? "").trim().toUpperCase();
    return code === stationCode;
  });

  const workerConfigured = isEddWorkerConfigured();
  const authorized = allowedCodes.has(stationCode);
  const stationName = String(location?.station_name ?? "").trim();
  const placeBits = [location?.city, location?.state].filter(Boolean).join(", ");

  return (
    <AppShell active="Delivery Performance" pageCode="edd_dashboard">
      <div className="ops-command-center">
        <Link className="edd-back-link" href="/edd" prefetch={false}>
          <ArrowLeft size={14} /> All stations
        </Link>

        <PageHead
          eyebrow="Ops Pulse · Station drill-down"
          title={stationCode || "Station"}
          subtitle={
            stationName
              ? `${stationName}${placeBits ? ` · ${placeBits}` : ""} · Ageing and delivery performance`
              : "Ageing (live tracking IDs by Estimated Delivery Date) and assigned/delivered/returned/held performance for this station."
          }
          action={<span className={`status-pill ${workerConfigured ? "good" : "warn"}`}>{workerConfigured ? "Live" : "Setup needed"}</span>}
        />

        {!workerConfigured ? (
          <section className="panel message-panel error">
            <div className="panel-body">
              <strong>EDD worker is not configured</strong>
              <p className="subtle" style={{ marginTop: 6 }}>
                Set <code>EDD_WORKER_URL</code> and <code>EDD_WORKER_ADMIN_KEY</code> in this deployment&apos;s environment
                variables, pointing at the amazon-edd-worker service, then reload this page.
              </p>
            </div>
          </section>
        ) : !stationCode || !authorized ? (
          <section className="panel message-panel error">
            <div className="panel-body">
              <strong>Station not available</strong>
              <p className="subtle" style={{ marginTop: 6 }}>
                {stationCode
                  ? `${stationCode} isn't in your assigned stations. Go back to All stations to pick one you have access to.`
                  : "No station code was given."}
              </p>
            </div>
          </section>
        ) : (
          <EddStationTabs stationCode={stationCode} />
        )}
      </div>
    </AppShell>
  );
}
