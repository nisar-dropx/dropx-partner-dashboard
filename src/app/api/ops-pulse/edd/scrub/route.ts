import { NextResponse } from "next/server";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { fetchScrubNetwork } from "@/lib/ops-pulse/edd-worker";
import { loadFlashViewerStations } from "@/lib/ops-pulse/load-flash-access";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function respond(refresh: boolean) {
  try {
    const denied = await requireEddApi();
    if (denied) return denied;
    const viewer = await loadFlashViewerStations();
    const payload = await fetchScrubNetwork(viewer.map((station) => station.code), { refresh });
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
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
export async function POST() {
  return respond(true);
}
