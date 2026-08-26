import { NextResponse } from "next/server";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { fetchEddPerformanceDaily } from "@/lib/ops-pulse/edd-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

/** Cached read of the day-over-day performance archive for one station — powers "By date" / "Day-wise ledger". */
export async function GET(request: Request) {
  try {
    const denied = await requireEddApi();
    if (denied) return denied;

    const url = new URL(request.url);
    const stationCode = url.searchParams.get("stationCode")?.trim().toUpperCase() ?? "";
    const days = Number(url.searchParams.get("days") ?? 30) || 30;
    if (!stationCode) {
      return NextResponse.json({ error: "stationCode is required." }, { status: 400 });
    }

    const rows = await fetchEddPerformanceDaily({ stationCode, days });
    return NextResponse.json({ status: "ok", stationCode, days: rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load the performance history.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
