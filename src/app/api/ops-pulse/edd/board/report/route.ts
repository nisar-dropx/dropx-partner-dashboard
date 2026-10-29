import { NextResponse } from "next/server";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { fetchLoadFlashBoard } from "@/lib/ops-pulse/edd-worker";
import { loadFlashViewerStations, pickFlashStations } from "@/lib/ops-pulse/load-flash-access";
import {
  filterStationsByRegion,
  stationBoardFilename,
  stationBoardSheets,
  type StationBoardNetwork,
  type StationBoardView,
} from "@/lib/ops-pulse/station-board";
import type { StationBoardRegionId } from "@/lib/ops-pulse/station-board-regions";
import { compressedWorkbookResponse } from "@/lib/report-workbook";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const VIEWS = new Set<StationBoardView | "full">(["edd", "creturn", "dsr", "zero", "full"]);
const REGIONS = new Set<StationBoardRegionId | "ALL">(["ALL", "KL", "AP", "ODCG", "OTHER"]);

export async function GET(request: Request) {
  try {
    const denied = await requireEddApi();
    if (denied) return denied;
    const url = new URL(request.url);
    const date = url.searchParams.get("date") ?? "";
    const requested = url.searchParams.get("report") ?? "full";
    const view: StationBoardView | "full" = VIEWS.has(requested as StationBoardView | "full")
      ? (requested as StationBoardView | "full")
      : "full";
    const regionParam = (url.searchParams.get("region") ?? "ALL").toUpperCase();
    const region: StationBoardRegionId | "ALL" = REGIONS.has(regionParam as StationBoardRegionId | "ALL")
      ? (regionParam as StationBoardRegionId | "ALL")
      : "ALL";

    const viewer = await loadFlashViewerStations();
    const stations = pickFlashStations(viewer, url.searchParams.get("stations"));
    const allowed = new Set(stations.map((station) => station.code));

    const payload = await fetchLoadFlashBoard(date || undefined, stations.map((s) => s.code));
    payload.stations = payload.stations.filter((row) => allowed.has(row.stationCode));
    const scoped = filterStationsByRegion(payload.stations, region);
    const network: StationBoardNetwork = {
      asOf: payload.asOf,
      businessDate: payload.businessDate,
      dates: payload.dates,
      stations: scoped,
      run: payload.run,
    };
    const sheets = stationBoardSheets(network, view, scoped);
    if (!sheets.length) {
      return NextResponse.json({ error: "No rows to export for this view." }, { status: 404 });
    }
    const scope = [
      region === "ALL" ? "" : region.toLowerCase(),
      stations.length === 1 ? stations[0]!.code : stations.length < viewer.length ? `${stations.length}-stations` : "",
    ]
      .filter(Boolean)
      .join("-");
    return await compressedWorkbookResponse(sheets, stationBoardFilename(payload.businessDate || date || "report", view, scope));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to build the station board workbook.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
