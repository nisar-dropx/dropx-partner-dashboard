import { NextResponse } from "next/server";
import { requireCiaApi } from "@/lib/ops-pulse/cia-access";
import { continueCiaSnapshot } from "@/lib/ops-pulse/cash-recon-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const denied = await requireCiaApi();
    if (denied) return denied;

    const body = (await request.json().catch(() => ({}))) as { runId?: string };
    const runId = String(body.runId ?? "").trim() || undefined;
    return NextResponse.json(await continueCiaSnapshot(runId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to advance Cash In Associate refresh.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
