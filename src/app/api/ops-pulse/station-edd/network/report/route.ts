import { NextResponse } from "next/server";
import { isStationEddApiDenied, stationEddApiContext } from "@/lib/ops-pulse/station-edd-access";
import { loadEddStations } from "@/lib/ops-pulse/edd-stations";
import { STATION_EDD_RULE, stationEddFreshness, stationEddToday, stationEddPackageMatches, stationEddPackageRow, stationEddSelection } from "@/lib/ops-pulse/station-edd";
import { loadStationEddNetwork } from "@/lib/ops-pulse/station-edd-data";
import { compressedWorkbookResponse } from "@/lib/report-workbook";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(request: Request) {
  try {
    const context = await stationEddApiContext();
    if (isStationEddApiDenied(context)) return context;
    const stations = await loadEddStations(context.companyId, context.authorization.locationScopeIds, context.authorization.hasAllLocationAccess);
    const names = new Map(stations.map(s => [s.code, s.name]));
    const params = new URL(request.url).searchParams;
    const pending = params.get("report") === "pending";
    const selection = stationEddSelection(params.get("day") || "pending", "atStation");
    const day = selection.day === "all" ? "pending" : selection.day;
    const pendingRows: Record<string, unknown>[] = [];
    const data = await loadStationEddNetwork(stations.map(s => s.code), pending ? (code, packages, fetchedAt, today) => {
      const unique = new Map(packages.filter(p => p.trackingId).map(p => [p.trackingId, p]));
      for (const pkg of unique.values()) {
        if (stationEddPackageMatches(pkg, "atStation", day, today)) pendingRows.push(stationEddPackageRow(pkg, code, names.get(code) ?? "", fetchedAt, today));
      }
    } : undefined);
    const rows = data.map(row => ({
      "Station Code": row.stationCode, "Station Name": names.get(row.stationCode) ?? "",
      "EDD Day (IST)": row.today, "At Station EDD Today": row.hasSnapshot ? row.todayAtStation : "",
      "Overdue At Station": row.hasSnapshot ? row.overdueAtStation : "",
      "Total Pending At Station": row.hasSnapshot ? row.todayAtStation + row.overdueAtStation : "",
      "On Road EDD Today": row.hasSnapshot ? row.todayOnRoad : "",
      "Other Status EDD Today": row.hasSnapshot ? row.todayOther : "",
      "All Active EDD Today": row.hasSnapshot ? row.todayTotal : "",
      "Snapshot Refreshed UTC": row.fetchedAt ?? "", Freshness: stationEddFreshness(row.fetchedAt)
    }));
    return await compressedWorkbookResponse([
      { name: "Station EDD", rows },
      ...(pending ? [{ name: "Pending TIDs", rows: pendingRows }] : []),
      { name: "Definitions", rows: [{ Definition: STATION_EDD_RULE, Selection: pending ? `At station; EDD period: ${day}. All authorized locations, independent of table search.` : "All authorized station summaries", "Pending definition": "At station with EDD today or earlier; excludes future and unknown dates, on-road, other statuses and reverse shipments.", Freshness: "Counts include available stale snapshots. Missing data is blank, not zero.", Delivered: "See Performance for completed deliveries; this is the active backlog." }] },
      { name: "Source Statuses", rows: data.flatMap(row => row.statuses.map(s => ({ Station: row.stationCode, Status: s.state, "EDD Today": s.today, Overdue: s.overdue, "All Dates": s.total, "Snapshot Refreshed UTC": row.fetchedAt }))) }
    ], `${pending ? `pending-edd-all-locations-${day}` : "station-edd"}-${stationEddToday()}.xlsx`);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to build the EDD report." }, { status: 500 });
  }
}
