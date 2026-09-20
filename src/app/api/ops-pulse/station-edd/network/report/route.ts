import { NextResponse } from "next/server";
import { isStationEddApiDenied, stationEddApiContext } from "@/lib/ops-pulse/station-edd-access";
import { loadEddStations } from "@/lib/ops-pulse/edd-stations";
import { STATION_EDD_RULE, stationEddFreshness, stationEddToday, stationEddPackageMatches, stationEddPackageRow, stationEddSelection } from "@/lib/ops-pulse/station-edd";
import { loadStationEddNetwork } from "@/lib/ops-pulse/station-edd-data";
import { compressedWorkbookResponse } from "@/lib/report-workbook";
import { readNetworkControls, selectEddStations } from "@/lib/ops-pulse/edd-table-controls";
import { eddCurrentState } from "@/lib/ops-pulse/edd-verification";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(request: Request) {
  try {
    const context = await stationEddApiContext();
    if (isStationEddApiDenied(context)) return context;
    const authorizedStations = await loadEddStations(context.companyId, context.authorization.locationScopeIds, context.authorization.hasAllLocationAccess);
    const params = new URL(request.url).searchParams;
    const selectedCodes = (params.get("stations") || "").split(",").filter(Boolean);
    if (selectedCodes.some(code => !authorizedStations.some(station => station.code === code)))
      return NextResponse.json({ error: "Station access required." }, { status: 403 });
    const stations = selectedCodes.length ? authorizedStations.filter(station => selectedCodes.includes(station.code)) : authorizedStations;
    const names = new Map(stations.map(s => [s.code, s.name]));
    const pending = params.get("report") === "pending";
    const statusReport = params.get("report") === "statuses";
    const selectedStatuses = (params.get("statuses") || "").split(",").filter(Boolean);
    if (selectedStatuses.length > 60 || selectedStatuses.some(status => !/^[A-Z0-9_ ()>\/-]{1,80}$/.test(status)))
      return NextResponse.json({ error: "Choose valid source statuses." }, { status: 400 });
    const selection = stationEddSelection(params.get("day") || "pending", "atStation");
    const day = selection.day === "all" ? "pending" : selection.day;
    const pendingRows: Record<string, unknown>[] = [];
    const network = await loadStationEddNetwork(stations.map(s => s.code), pending || statusReport ? (code, packages, fetchedAt, today) => {
      const unique = new Map(packages.filter(p => p.trackingId).map(p => [p.trackingId, p]));
      for (const pkg of unique.values()) {
        if (stationEddPackageMatches(pkg, statusReport ? "all" : "atStation", day, today)
          && (!statusReport || !selectedStatuses.length || selectedStatuses.includes(eddCurrentState(pkg)))) pendingRows.push(stationEddPackageRow(pkg, code, names.get(code) ?? "", fetchedAt, today));
      }
    } : undefined);
    const controls = readNetworkControls(params);
    const data = selectEddStations(network, names, controls);
    const ranks = new Map(data.map((row, index) => [row.stationCode, index]));
    const selectedPending = pendingRows.filter(row => ranks.has(String(row["Station Code"]))).sort((a, b) => ranks.get(String(a["Station Code"]))! - ranks.get(String(b["Station Code"]))! || String(a["Tracking ID"]).localeCompare(String(b["Tracking ID"]), "en", { numeric: true }));
    const rows = data.map(row => ({
      "Station Code": row.stationCode, "Station Name": names.get(row.stationCode) ?? "",
      "EDD Day (IST)": row.today, "At Station EDD Today": row.hasSnapshot ? row.todayAtStation : "",
      "Overdue At Station": row.hasSnapshot ? row.overdueAtStation : "",
      "Total Pending At Station": row.hasSnapshot ? row.todayAtStation + row.overdueAtStation : "",
      "On Road EDD Today": row.hasSnapshot ? row.todayOnRoad : "",
      "Other Status EDD Today": row.hasSnapshot ? row.todayOther : "",
      "Known EDD Today": row.hasSnapshot ? row.todayTotal : "",
      "Delivered EDD Today": row.hasSnapshot ? row.todayDelivered : "",
      "HFR EDD Today": row.hasSnapshot ? row.todayHfr : "",
      "HCR EDD Today": row.hasSnapshot ? row.todayHcr : "",
      "Observed INDUCTED / RECEIVED": row.hasSnapshot ? row.todayObservedAtStation : "",
      "Attempted EDD Today": row.hasSnapshot ? row.todayAttempted : "",
      "History To Verify EDD Today": row.hasSnapshot ? row.todayUnverified : "",
      "Unconfirmed EDD Date": row.hasSnapshot ? row.missingDate : "",
      "Snapshot Refreshed UTC": row.fetchedAt ?? "", Freshness: stationEddFreshness(row.fetchedAt)
    }));
    return await compressedWorkbookResponse([
      { name: "Station EDD", rows },
      ...(pending || statusReport ? [{ name: pending ? "Pending TIDs" : "Selected status TIDs", rows: selectedPending }] : []),
      { name: "Export filters", rows: [{ Stations: selectedCodes.join(", ") || "All authorized matching stations", Statuses: statusReport ? selectedStatuses.join(", ") || "All source statuses" : "Pending first dispatch", "EDD period": day, "Matching TIDs": selectedPending.length, "Generated UTC": new Date().toISOString() }] },
      { name: "Definitions", rows: [{ Definition: STATION_EDD_RULE, Selection: pending ? `Confirmed pending first dispatch; EDD period: ${day}. Only stations matching the table filters.` : "Station summaries matching the table filters", Search: controls.query, Workload: controls.focus, "Freshness filter": controls.freshness, Sort: controls.sort, Direction: controls.direction, "Matching Stations": data.length, Coverage: "Known EDD cohort from retained observations seen within seven days. Missing dates and unverified histories are explicit and excluded from confirmed pending. Totals are not full-source coverage until verification is complete.", Freshness: "Recorded observations, not continuous live tracking. Missing data is blank, not zero.", Delivered: "Retained delivery outcomes with a known EDD; prior-day attempts stay in HFR." }] },
      { name: "Source Statuses", rows: data.flatMap(row => row.statuses.map(s => ({ Station: row.stationCode, Status: s.state, "EDD Today": s.today, Overdue: s.overdue, "All Dates": s.total, "Snapshot Refreshed UTC": row.fetchedAt }))) }
    ], `${pending ? `pending-edd-all-locations-${day}` : statusReport ? `edd-selected-statuses-${day}` : "station-edd"}-${stationEddToday()}.xlsx`);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to build the EDD report." }, { status: 500 });
  }
}
