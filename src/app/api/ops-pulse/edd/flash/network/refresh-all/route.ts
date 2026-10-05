import { NextResponse } from "next/server";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { refreshLoadFlashNetwork } from "@/lib/ops-pulse/edd-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST() {
  try {
    const denied = await requireEddApi();
    if (denied) return denied;
    const run = await refreshLoadFlashNetwork();
    return NextResponse.json({ run });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to refresh the station load report.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
