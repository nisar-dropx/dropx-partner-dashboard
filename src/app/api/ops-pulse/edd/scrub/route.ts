import { NextResponse } from "next/server";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { fetchScrubNetwork } from "@/lib/ops-pulse/edd-worker";
import { loadFlashViewerStations } from "@/lib/ops-pulse/load-flash-access";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function respond(refresh: boolean, request?: Request) {
  try {
    const denied = await requireEddApi("edd_scrub");
    if (denied) return denied;
    const viewer = await loadFlashViewerStations();
    const allowed = new Set(viewer.map(station => station.code));
    if (refresh) {
      const body = await request?.json().catch(() => null);
      if (!Array.isArray(body?.stations) || !body.stations.length || body.stations.some((code: unknown) => typeof code !== 'string' || !allowed.has(code))) {
        return NextResponse.json({ error: 'Select stations within your access.' }, { status: 400 });
      }
      await fetchScrubNetwork([...new Set<string>(body.stations)], { refresh: true });
    }
    const payload = await fetchScrubNetwork([...allowed]);
    return NextResponse.json({...payload, stations: payload.stations.filter(station => allowed.has(station.stationCode))}, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load scrub activity.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** The saved scrub report for the viewer's own stations (morning sweep or last manual fetch). */
export async function GET() {
  return respond(false);
}

/** Fetch now: asks Amazon for the viewer's stations and saves the result. */
export async function POST(request: Request) {
  return respond(true, request);
}
