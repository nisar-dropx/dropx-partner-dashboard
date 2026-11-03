import { NextResponse } from "next/server";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { fetchLoadFlashTracking } from "@/lib/ops-pulse/edd-worker";
import { loadFlashViewerStations } from "@/lib/ops-pulse/load-flash-access";
import {
  BOARD_TID_KIND_BUCKETS,
  mapBoardTidExportRows,
  type StationBoardTidKind,
} from "@/lib/ops-pulse/station-board-tids";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const KINDS = new Set<StationBoardTidKind>(["edd", "creturn", "dsr", "zero", "ageing"]);

/**
 * Station-wise tracking IDs for Station board drill-down / Excel All TIDs sheet.
 * Always board Refresh buckets — never Ops Live Inducted/Delivered/OOR census.
 * Pass `station=` (one) or `stations=` (comma-separated).
 */
export async function GET(request: Request) {
  try {
    const denied = await requireEddApi("edd_station_board");
    if (denied) return denied;
    const params = new URL(request.url).searchParams;
    const date = String(params.get("date") ?? "").trim();
    const kind = String(params.get("kind") ?? "creturn").trim().toLowerCase() as StationBoardTidKind;
    const stationList = [
      ...String(params.get("stations") ?? "")
        .split(",")
        .map((value) => value.trim().toUpperCase())
        .filter(Boolean),
      ...String(params.get("station") ?? "")
        .split(",")
        .map((value) => value.trim().toUpperCase())
        .filter(Boolean),
    ];
    const stations = [...new Set(stationList)];
    if (!stations.length) return NextResponse.json({ error: "Choose a station." }, { status: 400 });
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "Choose a valid date." }, { status: 400 });
    }
    if (!KINDS.has(kind)) {
      return NextResponse.json({ error: "Unknown report kind." }, { status: 400 });
    }
    const viewer = await loadFlashViewerStations();
    const allowed = new Set(viewer.map((row) => row.code));
    const deniedStation = stations.find((code) => !allowed.has(code));
    if (deniedStation) {
      return NextResponse.json({ error: "Station access required." }, { status: 403 });
    }

    const flash = (await fetchLoadFlashTracking(date || undefined, stations, {
      buckets: BOARD_TID_KIND_BUCKETS[kind],
    })).filter((row) => allowed.has(row.stationCode) && stations.includes(row.stationCode));

    const mapped = mapBoardTidExportRows(flash, kind);
    const rows = mapped.map(({ stationCode, trackingId, status, edd, driverId, driverName }) => ({
      stationCode,
      trackingId,
      status,
      edd,
      driverId,
      driverName,
    }));

    return NextResponse.json(
      { station: stations.length === 1 ? stations[0] : undefined, stations, kind, rows },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load tracking IDs.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
