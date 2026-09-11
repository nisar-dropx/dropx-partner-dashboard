import { NextResponse } from "next/server";
import { captureReviewEddHistory } from "@/lib/ops-pulse/review-operations-data";
import { isEddCronHost } from "@/lib/ops-pulse/edd-cron-scope";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 300;
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isEddCronHost(new URL(request.url).hostname)) return NextResponse.json({ skipped: "Review history runs only on OpsPulse." });
  try {
    const result = await captureReviewEddHistory();
    if (result.staleStations?.length || result.failedSources?.length) console.warn("[edd-review-history] degraded", result);
    else console.info("[edd-review-history] captured", result);
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  }
  catch (error) {
    console.error("[edd-review-history] capture failed", error instanceof Error ? error.message : "Unknown error");
    return NextResponse.json({ error: "EDD history capture failed." }, { status: 500 });
  }
}
