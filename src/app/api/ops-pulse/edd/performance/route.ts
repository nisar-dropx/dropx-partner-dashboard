import { NextResponse } from "next/server";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { fetchEddPerformance } from "@/lib/ops-pulse/edd-worker";

export const dynamic = "force-dynamic";
// Live Amazon fetch every time (never cached) — see fetchEddPerformance.
export const maxDuration = 100;

export async function GET(request: Request) {
  try {
    const denied = await requireEddApi();
    if (denied) return denied;

    const url = new URL(request.url);
    const stationCode = url.searchParams.get("stationCode")?.trim().toUpperCase() ?? "";
    const from = url.searchParams.get("from")?.trim() ?? "";
    const to = url.searchParams.get("to")?.trim() ?? "";
    if (!stationCode) {
      return NextResponse.json({ error: "stationCode is required." }, { status: 400 });
    }

    const payload = await fetchEddPerformance({ stationCode, from, to });
    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load the performance report.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
