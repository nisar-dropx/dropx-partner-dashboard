import { NextResponse } from "next/server";
import { isEddCronHost } from "@/lib/ops-pulse/edd-cron-scope";
import { runPortalDatomsPoll } from "@/lib/ops-pulse/datoms-alerts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Datoms L2/L3 poll on OpsPulse (Vercel bom1 / India).
 * May login only when no durable Supabase session exists and login backoff is clear.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isEddCronHost(new URL(request.url).hostname)) {
    return NextResponse.json({ skipped: "Datoms alerts run on OpsPulse only" });
  }

  try {
    const dryRun = new URL(request.url).searchParams.get("dry_run") === "1";
    // Cron may refresh a dead session once; 25h backoff + login lock prevent storms.
    const result = await runPortalDatomsPoll({ dryRun, allowLogin: true });
    return NextResponse.json({ ok: true, egress: "vercel-opspulse", ...result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
