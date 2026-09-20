import { NextResponse } from "next/server";
import { isStationEddApiDenied, stationEddApiContext } from "@/lib/ops-pulse/station-edd-access";
import { loadEddStations } from "@/lib/ops-pulse/edd-stations";
import { STATION_EDD_RULE, stationEddReportSheets, stationEddToday, stationEddPackageRow, summarizeStationEdd } from "@/lib/ops-pulse/station-edd";
import { loadVerifiedEddStation } from "@/lib/ops-pulse/edd-ledger";
import { readEddControls, selectEddHolds, selectEddAssociates, selectEddStatuses, selectEddTids } from "@/lib/ops-pulse/edd-table-controls";
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
    const result = await loadVerifiedEddStation(stationCode);
    if (result.status === "no_snapshot") return NextResponse.json({ error: "No EDD snapshot is available." }, { status: 404 });
    const today = stationEddToday();
    const params = new URL(request.url).searchParams;
    const controls = readEddControls(params);
    const metadata = { Station: stationCode, "EDD Day (IST)": today, Period: controls.day, "Snapshot Refreshed UTC": result.payload.fetchedAt, Definition: STATION_EDD_RULE, "Export scope": "All rows matching these filters; pagination is not applied. Counts can change as the source refreshes." };
    if (params.get("report") === "holds") {
      const rows = selectEddHolds(result.payload.packages,params.get("category") || "all",params.get("query") || "",params.get("sort") || "attempt",params.get("direction") || "asc")
        .map(row=>stationEddPackageRow(row.pkg,stationCode,station.name,result.payload.fetchedAt,today));
      return await compressedWorkbookResponse([{name:"Attempt lifecycle",rows},{name:"Report Details",rows:[{...metadata,Period:"All observed dates",Category:params.get("category") || "all",Search:params.get("query") || "",Sort:params.get("sort") || "attempt",Direction:params.get("direction") || "asc","Hold rule":"48h start policy unconfirmed. Return and second-attempt timestamps are evidence, not source-confirmed Ready for FC."}]}],`edd-${stationCode}-holds-${today}.xlsx`);
    }
    if (params.get("report") === "associates") {
      const rows = selectEddAssociates(result.payload.packages, controls, today).map(a => ({ Associate: a.name, "Driver ID": a.id, Sent: a.sent, Delivered: a.delivered, "Still On Road": a.onRoad, "Attempted / Returned": a.attempted, "Delivery Rate (%)": Math.round(a.delivered / a.sent * 10000) / 100 }));
      return await compressedWorkbookResponse([
        { name: "Associates", rows },
        { name: "Report Details", rows: [{ ...metadata, Search: controls.associateQuery, Filter: controls.focus, Sort: controls.associateSort, Direction: controls.associateDirection, "Matching Associates": rows.length, Cohort: "Unique dispatched TIDs with known EDD in the selected period. Prior-day HFR excluded." }] }
      ], `edd-${stationCode}-associates-${controls.day}-${today}.xlsx`);
    }
    if (params.get("report") === "statuses") {
      const summary = summarizeStationEdd(stationCode, result.payload.packages, result.payload.fetchedAt, today);
      const rows = selectEddStatuses(summary.statuses, controls).map(row => ({ "Source Status": row.state, "Selected Period": row.count, "All Observed Dates": row.total }));
      return await compressedWorkbookResponse([
        { name: "Source Statuses", rows },
        { name: "Report Details", rows: [{ ...metadata, Search: controls.statusQuery, Sort: controls.statusSort, Direction: controls.statusDirection, "Matching Statuses": rows.length }] }
      ], `edd-${stationCode}-statuses-${controls.day}-${today}.xlsx`);
    }
    if (params.get("report") === "filtered") {
      const { day, position } = controls;
      const rows = selectEddTids(result.payload.packages, controls, today)
        .map(p => stationEddPackageRow(p, stationCode, station.name, result.payload.fetchedAt, today));
      return await compressedWorkbookResponse([
        { name: "Tracking IDs", rows },
        { name: "Report Details", rows: [{ ...metadata, Position: position, "Raw Status": controls.state || "All", Search: controls.query, Associate: controls.associate || "All", "Dispatched Cohort Only": controls.sentOnly ? "Yes" : "No", History: controls.history, Sort: controls.sort, Direction: controls.direction, "Matching TIDs": rows.length }] }
      ], `edd-${stationCode}-${position}-${day}-${today}.xlsx`);
    }
    return await compressedWorkbookResponse(stationEddReportSheets(result.payload, station.name, today), `station-edd-${stationCode}-${today}.xlsx`);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to build station report." }, { status: 500 });
  }
}
