import { NextResponse } from "next/server";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { refreshEddStation } from "@/lib/ops-pulse/edd-worker";

export const dynamic = "force-dynamic";
// The full live pull + bulk enrichment takes ~60-90s against a large
// station's backlog — this route only serves the manual "Refresh live"
// button, never the page's initial load (see ../route.ts for the fast
// cached read).
export const maxDuration = 180;

export async function POST(request: Request) {
  try {
    const denied = await requireEddApi();
    if (denied) return denied;

    const url = new URL(request.url);
    const stationCode = url.searchParams.get("stationCode")?.trim().toUpperCase() ?? "";
    if (!stationCode) {
      return NextResponse.json({ error: "stationCode is required." }, { status: 400 });
    }

    const payload = await refreshEddStation({ stationCode });
    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to refresh the EDD dashboard.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
