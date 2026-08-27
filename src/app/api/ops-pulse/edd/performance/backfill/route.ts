import { NextResponse } from "next/server";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { backfillEddPerformanceHistory } from "@/lib/ops-pulse/edd-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

/** Kicks off a background backfill of the last N days for one station — "download all the monthly data" for the Day-wise ledger. Returns immediately. */
export async function POST(request: Request) {
  try {
    const denied = await requireEddApi();
    if (denied) return denied;

    const url = new URL(request.url);
    const stationCode = url.searchParams.get("stationCode")?.trim().toUpperCase() ?? "";
    const days = Number(url.searchParams.get("days") ?? 30) || 30;
    if (!stationCode) {
      return NextResponse.json({ error: "stationCode is required." }, { status: 400 });
    }

    const result = await backfillEddPerformanceHistory({ stationCode, days });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to start the backfill.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
