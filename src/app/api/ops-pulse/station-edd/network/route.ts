import { NextResponse } from "next/server";
import { isStationEddApiDenied, stationEddApiContext } from "@/lib/ops-pulse/station-edd-access";
import { loadEddStations } from "@/lib/ops-pulse/edd-stations";
import { loadStationEddNetworkSummary } from "@/lib/ops-pulse/station-edd-summary";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Cached per-station counts. Anything not ready inside the time budget comes
 * back in `pending`; the open tab asks again rather than holding the request. */
export async function GET() {
  try {
    const context = await stationEddApiContext();
    if (isStationEddApiDenied(context)) return context;
    const stations = await loadEddStations(context.companyId, context.authorization.locationScopeIds, context.authorization.hasAllLocationAccess);
    return NextResponse.json(await loadStationEddNetworkSummary(stations.map(s => s.code)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load EDD." }, { status: 500 });
  }
}
