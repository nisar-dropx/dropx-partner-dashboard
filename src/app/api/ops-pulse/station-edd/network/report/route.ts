import { NextResponse } from "next/server";
import { isStationEddApiDenied, stationEddApiContext } from "@/lib/ops-pulse/station-edd-access";
import { loadEddStations } from "@/lib/ops-pulse/edd-stations";
import { STATION_EDD_RULE, stationEddFreshness, stationEddToday } from "@/lib/ops-pulse/station-edd";
import { loadStationEddNetwork } from "@/lib/ops-pulse/station-edd-data";
import { compressedWorkbookResponse } from "@/lib/report-workbook";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET() {
  try {
    const context = await stationEddApiContext();
    if (isStationEddApiDenied(context)) return context;
    const stations = await loadEddStations(context.companyId, context.authorization.locationScopeIds, context.authorization.hasAllLocationAccess);
    const names = new Map(stations.map(s => [s.code, s.name]));
    const data = await loadStationEddNetwork(stations.map(s => s.code));
    const rows = data.map(row => ({
      "Station Code": row.stationCode, "Station Name": names.get(row.stationCode) ?? "",
      "EDD Day (IST)": row.today, "At Station EDD Today": row.hasSnapshot ? row.todayAtStation : "",
      "Overdue At Station": row.hasSnapshot ? row.overdueAtStation : "",
      "On Road EDD Today": row.hasSnapshot ? row.todayOnRoad : "",
      "Other Status EDD Today": row.hasSnapshot ? row.todayOther : "",
      "All Active EDD Today": row.hasSnapshot ? row.todayTotal : "",
      "Snapshot Refreshed UTC": row.fetchedAt ?? "", Freshness: stationEddFreshness(row.fetchedAt)
    }));
    return await compressedWorkbookResponse([
      { name: "Station EDD", rows },
      { name: "Definitions", rows: [{ Definition: STATION_EDD_RULE, Freshness: "Counts include available stale snapshots. Missing data is blank, not zero.", Delivered: "See Performance for completed deliveries; this is the active backlog." }] },
      { name: "Source Statuses", rows: data.flatMap(row => row.statuses.map(s => ({ Station: row.stationCode, Status: s.state, "EDD Today": s.today, Overdue: s.overdue, "All Dates": s.total, "Snapshot Refreshed UTC": row.fetchedAt }))) }
    ], `station-edd-${stationEddToday()}.xlsx`);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to build the EDD report." }, { status: 500 });
  }
}
