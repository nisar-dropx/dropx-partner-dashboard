import { NextResponse } from "next/server";
import { requireEddApi } from "@/lib/ops-pulse/edd-access";
import { backfillLoadFlashBoard } from "@/lib/ops-pulse/edd-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const denied = await requireEddApi();
    if (denied) return denied;
    const url = new URL(request.url);
    const days = Number(url.searchParams.get("days") ?? 7) || 7;
    const startIndex = Number(url.searchParams.get("startIndex") ?? 0) || 0;
    const date = String(url.searchParams.get("date") ?? "").trim();
    const concurrency = Math.max(1, Math.min(25, Number(url.searchParams.get("concurrency") ?? 25) || 25));
    const retryRaw = String(url.searchParams.get("retryJobs") ?? "").trim();
    const retryJobs = retryRaw
      ? retryRaw.split(",").map((part) => part.trim()).filter(Boolean)
      : undefined;
    const reset = String(url.searchParams.get("reset") ?? "").trim() === "1";
    const outcome = await backfillLoadFlashBoard({
      days,
      startIndex,
      date: date || undefined,
      concurrency,
      retryJobs,
      reset,
    });
    return NextResponse.json(outcome);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to backfill the station board.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
