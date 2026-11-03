import { NextResponse } from "next/server";
import { requireEddAgeingPerformanceApi } from "@/lib/ops-pulse/edd-access";
import { fetchEddPerformanceStation } from "@/lib/ops-pulse/edd-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Fast cached read — see ./refresh for the manual per-station refresh. */
export async function GET(request: Request) {
  try {
    const denied = await requireEddAgeingPerformanceApi("edd_performance");
    if (denied) return denied;

    const url = new URL(request.url);
    const stationCode = url.searchParams.get("stationCode")?.trim().toUpperCase() ?? "";
    if (!stationCode) {
      return NextResponse.json({ error: "stationCode is required." }, { status: 400 });
    }

    const result = await fetchEddPerformanceStation({ stationCode });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load the performance report.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
