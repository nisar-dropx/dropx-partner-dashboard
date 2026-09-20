import { NextResponse } from "next/server";
import { isStationEddApiDenied, stationEddApiContext } from "@/lib/ops-pulse/station-edd-access";
import { loadEddStations } from "@/lib/ops-pulse/edd-stations";
import { loadStationEddNetwork } from "@/lib/ops-pulse/station-edd-data";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const context = await stationEddApiContext();
    if (isStationEddApiDenied(context)) return context;
    const stations = await loadEddStations(context.companyId, context.authorization.locationScopeIds, context.authorization.hasAllLocationAccess);
    return NextResponse.json({ stations: await loadStationEddNetwork(stations.map(s => s.code)) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load EDD." }, { status: 500 });
  }
}
