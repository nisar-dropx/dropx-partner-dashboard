import { NextResponse } from "next/server";
import { isEddCronHost } from "@/lib/ops-pulse/edd-cron-scope";
import { loadReportBotSettings } from "@/lib/report-bot/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const COMPANY_ID = "43866344-b550-4e8a-9a2d-9d23f3d8a997";

/**
 * Datoms L2/L3 poll on OpsPulse (Vercel bom1 / India) so login + event pulls
 * do not come from Cloudflare US cron IPs. Session token lives in Supabase.
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
    const settings = await loadReportBotSettings(COMPANY_ID);
    const { runPoll } = await import("../../../../../workers/datoms-alerts/src/index.mjs");
    const env = {
      DATOMS_EMAIL: process.env.DATOMS_EMAIL || process.env.DATOMS_ID || "",
      DATOMS_PASSWORD: process.env.DATOMS_PASSWORD || process.env.DATOMS_PASSWORD_HASH || "",
      DATOMS_CUSTOMER_ID: process.env.DATOMS_CUSTOMER_ID || "17428",
      DATOMS_APPLICATION_ID: process.env.DATOMS_APPLICATION_ID || "16",
      COMPANY_ID,
      SUPABASE_URL: process.env.COMPANY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      SUPABASE_SERVICE_ROLE_KEY:
        process.env.COMPANY_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "",
      COMPANY_SUPABASE_URL: process.env.COMPANY_SUPABASE_URL || "",
      COMPANY_SUPABASE_SERVICE_ROLE_KEY: process.env.COMPANY_SUPABASE_SERVICE_ROLE_KEY || "",
      REPORT_BOT_URL: settings.worker_url || process.env.REPORT_BOT_URL || "",
      REPORT_BOT_TOKEN: settings.worker_token || process.env.REPORT_BOT_TOKEN || "",
      // No CF KV on Vercel — Supabase session + alert table are durable stores.
      ALERT_DEDUPE: null
    };

    const dryRun = new URL(request.url).searchParams.get("dry_run") === "1";
    const result = await runPoll(env, { dryRun });
    return NextResponse.json({ ok: true, egress: "vercel-opspulse", ...result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
