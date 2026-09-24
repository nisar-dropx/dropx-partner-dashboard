import { NextResponse } from "next/server";
import { getAuthorization } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { requireCiaApi } from "@/lib/ops-pulse/cia-access";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { fetchCiaNetwork } from "@/lib/ops-pulse/cash-recon-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  try {
    const denied = await requireCiaApi();
    if (denied) return denied;
    const payload = await fetchCiaNetwork();

    // Same scoping as the page itself — the worker's network snapshot has no
    // location filter of its own, so a location-scoped caller of this API
    // directly would otherwise still get every station's data.
    const authorization = await getAuthorization();
    if (authorization && !authorization.hasAllLocationAccess) {
      const companyId = requireCompanyId(authorization);
      const { locations } = await loadCodLocations(companyId, authorization.locationScopeIds, authorization.hasAllLocationAccess);
      const scopedStationCodes = new Set(locations.map((location) => String(location.station_code ?? "").trim().toUpperCase()));
      return NextResponse.json({
        ...payload,
        stations: payload.stations.filter((station) => scopedStationCodes.has(String(station.stationCode ?? "").trim().toUpperCase()))
      });
    }

    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load Cash In Associate network.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
