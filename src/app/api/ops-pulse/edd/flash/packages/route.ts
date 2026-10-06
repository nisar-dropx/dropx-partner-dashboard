import { NextResponse } from "next/server";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { fetchLoadFlashTracking } from "@/lib/ops-pulse/edd-worker";
import { loadFlashViewerStations } from "@/lib/ops-pulse/load-flash-access";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Tracking IDs with drivers for one station — the Ops Live station and driver drill-down. */
export async function GET(request: Request) {
  try {
    const denied = await requireEddApi();
    if (denied) return denied;
    const params = new URL(request.url).searchParams;
    const station = String(params.get("station") ?? "").trim().toUpperCase();
    const date = String(params.get("date") ?? "").trim();
    if (!station) return NextResponse.json({ error: "Choose a station." }, { status: 400 });
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "Choose a valid date." }, { status: 400 });
    const viewer = await loadFlashViewerStations();
    if (!viewer.some((row) => row.code === station)) return NextResponse.json({ error: "Station access required." }, { status: 403 });
    const rows = (await fetchLoadFlashTracking(date || undefined, [station])).filter((row) => row.stationCode === station);
    return NextResponse.json({ station, rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load this station's tracking IDs.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
