import { NextResponse } from "next/server";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { refreshEddPerformanceStation } from "@/lib/ops-pulse/edd-worker";

export const dynamic = "force-dynamic";
// Much faster than the ageing refresh (a single-day pull, no bulk enrichment) — still generous in case Amazon is slow.
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const denied = await requireEddApi();
    if (denied) return denied;

    const url = new URL(request.url);
    const stationCode = url.searchParams.get("stationCode")?.trim().toUpperCase() ?? "";
    if (!stationCode) {
      return NextResponse.json({ error: "stationCode is required." }, { status: 400 });
    }

    const payload = await refreshEddPerformanceStation({ stationCode });
    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to refresh the performance report.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
