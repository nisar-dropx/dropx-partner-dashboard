import { NextResponse } from "next/server";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { fetchScrubNetwork } from "@/lib/ops-pulse/edd-worker";
import { loadFlashViewerStations } from "@/lib/ops-pulse/load-flash-access";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Live scrub activity for the viewer's own stations; `refresh=1` skips the worker's one-minute reuse. */
export async function GET(request: Request) {
  try {
    const denied = await requireEddApi();
    if (denied) return denied;
    const refresh = new URL(request.url).searchParams.get("refresh") === "1";
    const viewer = await loadFlashViewerStations();
    const payload = await fetchScrubNetwork(viewer.map((station) => station.code), { refresh });
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load scrub activity.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
