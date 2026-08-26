import { NextResponse } from "next/server";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { refreshAllEddPerformanceNetwork } from "@/lib/ops-pulse/edd-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Kicks off (or reports the progress of) a network-wide performance sweep — see eddPerformanceSweep.ts on the worker. */
export async function POST() {
  try {
    const denied = await requireEddApi();
    if (denied) return denied;

    const run = await refreshAllEddPerformanceNetwork();
    return NextResponse.json({ status: "ok", run });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to start the network performance sweep.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
