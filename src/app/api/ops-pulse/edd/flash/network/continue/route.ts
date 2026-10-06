import { NextResponse } from "next/server";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { continueLoadFlashNetwork } from "@/lib/ops-pulse/edd-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST() {
  try {
    const denied = await requireEddApi();
    if (denied) return denied;
    return NextResponse.json(await continueLoadFlashNetwork());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to advance the Ops Live refresh.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
