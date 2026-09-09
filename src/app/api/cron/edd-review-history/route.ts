import { NextResponse } from "next/server";
import { captureReviewEddHistory } from "@/lib/ops-pulse/review-operations-data";
import { isEddCronHost } from "@/lib/ops-pulse/edd-cron-scope";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isEddCronHost(new URL(request.url).hostname)) return NextResponse.json({ skipped: "Review history runs only on OpsPulse." });
  try { return NextResponse.json(await captureReviewEddHistory()); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "EDD history capture failed." }, { status: 500 }); }
}
