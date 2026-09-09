import { NextResponse } from "next/server";
import { isStationEddApiDenied, stationEddApiContext } from "@/lib/ops-pulse/station-edd-access";
import { refreshAllEddPerformanceNetwork } from "@/lib/ops-pulse/edd-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST() {
  try {
    const context = await stationEddApiContext();
    if (isStationEddApiDenied(context)) return context;
    return NextResponse.json({ run: await refreshAllEddPerformanceNetwork() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to start the EDD refresh." }, { status: 500 });
  }
}
