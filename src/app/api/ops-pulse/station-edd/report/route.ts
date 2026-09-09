import { NextResponse } from "next/server";
import { isStationEddApiDenied, stationEddApiContext } from "@/lib/ops-pulse/station-edd-access";
import { loadEddStations } from "@/lib/ops-pulse/edd-stations";
import { stationEddReportSheets, stationEddToday } from "@/lib/ops-pulse/station-edd";
import { fetchEddStation } from "@/lib/ops-pulse/edd-worker";
import { workbookResponse } from "@/lib/report-workbook";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
export async function GET(request: Request) {
  try {
    const context = await stationEddApiContext();
    if (isStationEddApiDenied(context)) return context;
    const stationCode = new URL(request.url).searchParams.get("stationCode")?.trim().toUpperCase() ?? "";
    if (!stationCode) return NextResponse.json({ error: "stationCode is required." }, { status: 400 });
    const stations = await loadEddStations(context.companyId, context.authorization.locationScopeIds, context.authorization.hasAllLocationAccess);
    const station = stations.find(entry => entry.code === stationCode);
    if (!station) return NextResponse.json({ error: "Station is outside your assigned location scope." }, { status: 403 });
    const result = await fetchEddStation({ stationCode });
    if (result.status === "no_snapshot") return NextResponse.json({ error: "No EDD snapshot is available." }, { status: 404 });
    const today = stationEddToday();
    return workbookResponse(stationEddReportSheets(result.payload, station.name, today), `station-edd-${stationCode}-${today}.xlsx`);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to build station report." }, { status: 500 });
  }
}
