import { NextResponse } from "next/server";
import { refreshWorkforcePayoutPublicationJobs } from "@/lib/workforce-payout-publication-refresh";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  const deadlineAtMs = Date.now() + (maxDuration - 60) * 1000;
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await refreshWorkforcePayoutPublicationJobs({ deadlineAtMs, limit: 100 });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to refresh queued Workforce payout publications."
    }, { status: 500, headers: { "Cache-Control": "private, no-store" } });
  }
}
