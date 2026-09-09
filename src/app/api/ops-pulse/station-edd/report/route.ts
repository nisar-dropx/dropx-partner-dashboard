import { NextResponse } from "next/server";
import { isStationEddApiDenied, stationEddApiContext } from "@/lib/ops-pulse/station-edd-access";
import { loadEddStations } from "@/lib/ops-pulse/edd-stations";
import { STATION_EDD_RULE, stationEddReportSheets, stationEddToday, stationEddSelection, stationEddPackageMatches, stationEddSearchMatches, stationEddPackageRow } from "@/lib/ops-pulse/station-edd";
import { fetchEddStation } from "@/lib/ops-pulse/edd-worker";
import { compressedWorkbookResponse } from "@/lib/report-workbook";

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
    const params = new URL(request.url).searchParams;
    if (params.get("report") === "filtered") {
      const { day, position } = stationEddSelection(params.get("day"), params.get("position"));
      const state = params.get("state") || "";
      const query = params.get("query") || "";
      const packages = [...new Map(result.payload.packages.filter(p => p.trackingId).map(p => [p.trackingId, p])).values()];
      const rows = packages.filter(p => stationEddPackageMatches(p, position, day, today) && stationEddSearchMatches(p, state, query))
        .map(p => stationEddPackageRow(p, stationCode, station.name, result.payload.fetchedAt, today));
      return await compressedWorkbookResponse([
        { name: "Tracking IDs", rows },
        { name: "Report Details", rows: [{ Station: stationCode, "EDD Day (IST)": today, Period: day, Position: position, "Raw Status": state || "All", Search: query, "Matching TIDs": rows.length, "Snapshot Refreshed UTC": result.payload.fetchedAt, Definition: STATION_EDD_RULE }] }
      ], `edd-${stationCode}-${position}-${day}-${today}.xlsx`);
    }
    return await compressedWorkbookResponse(stationEddReportSheets(result.payload, station.name, today), `station-edd-${stationCode}-${today}.xlsx`);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to build station report." }, { status: 500 });
  }
}
