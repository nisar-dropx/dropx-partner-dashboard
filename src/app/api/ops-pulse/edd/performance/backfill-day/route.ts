import { NextResponse } from "next/server";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { backfillEddPerformanceDay } from "@/lib/ops-pulse/edd-worker";

export const dynamic = "force-dynamic";
// One station, one day, live from Amazon — same cost as a single sweep tick.
export const maxDuration = 60;

/** Pulls and archives one specific past day — used by "By date" when the picked day isn't in the archive yet. */
export async function POST(request: Request) {
  try {
    const denied = await requireEddApi();
    if (denied) return denied;

    const url = new URL(request.url);
    const stationCode = url.searchParams.get("stationCode")?.trim().toUpperCase() ?? "";
    const date = url.searchParams.get("date")?.trim() ?? "";
    if (!stationCode) {
      return NextResponse.json({ error: "stationCode is required." }, { status: 400 });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "date is required, as YYYY-MM-DD." }, { status: 400 });
    }

    const day = await backfillEddPerformanceDay({ stationCode, date });
    return NextResponse.json({ status: "ok", day });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to fetch that day's performance.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
