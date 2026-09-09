import { NextResponse } from "next/server";
import { isStationEddApiDenied, stationEddApiContext } from "@/lib/ops-pulse/station-edd-access";
import { loadEddStations } from "@/lib/ops-pulse/edd-stations";
import { refreshEddStation } from "@/lib/ops-pulse/edd-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const context = await stationEddApiContext();
    if (isStationEddApiDenied(context)) return context;
    const stationCode = new URL(request.url).searchParams.get("stationCode")?.trim().toUpperCase() ?? "";
    if (!stationCode) return NextResponse.json({ error: "stationCode is required." }, { status: 400 });
    const stations = await loadEddStations(context.companyId, context.authorization.locationScopeIds, context.authorization.hasAllLocationAccess);
    if (!stations.some((station) => station.code === stationCode)) {
      return NextResponse.json({ error: "Station is outside your assigned location scope." }, { status: 403 });
    }
    return NextResponse.json(await refreshEddStation({ stationCode, timeoutMs: 280000 }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to refresh station EDD." }, { status: 500 });
  }
}
