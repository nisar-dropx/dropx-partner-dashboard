import { NextResponse } from "next/server";
import { isStationEddApiDenied, stationEddApiContext } from "@/lib/ops-pulse/station-edd-access";
import { loadEddStations } from "@/lib/ops-pulse/edd-stations";
import { fetchEddPerformanceNetwork, type EddPerformanceNetworkStation } from "@/lib/ops-pulse/edd-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const emptyStation = (stationCode: string): EddPerformanceNetworkStation => ({
  stationCode,
  hasSnapshot: false,
  fetchedAt: null,
  assigned: 0,
  delivered: 0,
  returned: 0,
  held: 0,
  yetToDispatch: 0,
  deliveredPct: 0,
  returnedPct: 0,
  heldPct: 0
});

export async function GET() {
  try {
    const context = await stationEddApiContext();
    if (isStationEddApiDenied(context)) return context;
    const [stations, payload] = await Promise.all([
      loadEddStations(context.companyId, context.authorization.locationScopeIds, context.authorization.hasAllLocationAccess),
      fetchEddPerformanceNetwork()
    ]);
    const byCode = new Map(payload.stations.map((row) => [row.stationCode, row]));
    return NextResponse.json({
      asOf: payload.asOf,
      stations: stations.map((station) => byCode.get(station.code) ?? emptyStation(station.code)),
      run: payload.run
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load EDD." }, { status: 500 });
  }
}
