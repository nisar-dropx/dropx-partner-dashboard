import { loadCodLocations, loadCodStationSettings } from "@/lib/ops-pulse/cod";
import { fetchEddAllowedStations } from "@/lib/ops-pulse/edd-worker";

export type EddStationOption = {
  code: string;
  label: string;
  name: string;
};

/**
 * The caller's own stations, intersected with the worker's own
 * ALLOWED_STATIONS list — without this, master-data rows that aren't real
 * Amazon-tracked delivery stations (head-office entries, test rows, etc.)
 * show up on the EDD network pages as permanent "not in this worker's
 * allowed station list" / session errors, since the worker rightly rejects
 * them. If the worker call fails (not configured, network error), falls
 * back to the unfiltered list rather than showing nothing.
 */
export async function loadEddStations(
  companyId: string,
  locationScopeIds: string[],
  hasAllLocationAccess: boolean
): Promise<EddStationOption[]> {
  const [locationsResult, settingsResult] = await Promise.all([
    loadCodLocations(companyId, locationScopeIds, hasAllLocationAccess),
    loadCodStationSettings(companyId, locationScopeIds, hasAllLocationAccess)
  ]);

  const portalCodeByLocation = new Map(
    settingsResult.rows
      .filter((row) => row.portal_station_code)
      .map((row) => [row.location_id, String(row.portal_station_code).trim().toUpperCase()])
  );

  const stations: EddStationOption[] = locationsResult.locations
    .map((location) => {
      const amazonCode = portalCodeByLocation.get(location.id) || String(location.station_code ?? "").trim().toUpperCase();
      if (!amazonCode) return null;
      const name = location.station_name ? String(location.station_name) : "";
      return { code: amazonCode, label: name ? `${amazonCode} — ${name}` : amazonCode, name };
    })
    .filter((row): row is EddStationOption => Boolean(row))
    .sort((a, b) => a.code.localeCompare(b.code));

  let allowed: Set<string> | null = null;
  try {
    allowed = await fetchEddAllowedStations();
  } catch {
    allowed = null;
  }

  return allowed ? stations.filter((station) => allowed!.has(station.code)) : stations;
}
