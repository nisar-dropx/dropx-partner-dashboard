import { NextResponse } from "next/server";
import { isEddCronHost } from "@/lib/ops-pulse/edd-cron-scope";
import { runPortalDatomsReportsSnapshot } from "@/lib/ops-pulse/datoms-alerts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/** Gravity reports cache — session reuse only (no login). */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isEddCronHost(new URL(request.url).hostname)) {
    return NextResponse.json({ skipped: "Datoms reports run on OpsPulse only" });
  }

  try {
    const result = await runPortalDatomsReportsSnapshot({ allowLogin: false });
    return NextResponse.json({ ok: true, egress: "vercel-opspulse", ...result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
