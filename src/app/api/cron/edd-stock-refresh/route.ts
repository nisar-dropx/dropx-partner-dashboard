import { NextResponse } from "next/server";
import { isEddCronHost } from "@/lib/ops-pulse/edd-cron-scope";
import { refreshReviewSources } from "@/lib/ops-pulse/review-source-refresh";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 300;

/** Keeps the Amazon EDD stock cache moving even when nobody opens the dashboard. */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isEddCronHost(new URL(request.url).hostname)) {
    return NextResponse.json({ skipped: "EDD stock refresh runs only on OpsPulse." });
  }
  try {
    const run = await refreshReviewSources();
    if (run.failedSources?.length) console.warn("[edd-source-refresh] degraded", run);
    else console.info("[edd-source-refresh] complete", run);
    return NextResponse.json({ status: run.failedSources?.length ? "degraded" : "ok", run }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[edd-source-refresh] failed", error instanceof Error ? error.message : "Unknown error");
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to start the EDD stock refresh." }, { status: 500 });
  }
}
