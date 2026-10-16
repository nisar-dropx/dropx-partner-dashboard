import { NextResponse } from "next/server";
import { isEddCronHost } from "@/lib/ops-pulse/edd-cron-scope";
import { runReportBotCycle } from "@/lib/report-bot/pipeline";
import { reportBotDb, type ReportBotSettings } from "@/lib/report-bot/settings";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Free hosts (Render's free tier) put a service to sleep after 15 minutes without
 * incoming requests. A health ping every minute keeps the worker awake; it stores
 * nothing on its disk, so even when the host does restart it, it reconnects by itself.
 * Every company with a worker is pinged, including bots that are Off, so linking
 * WhatsApp from setup never waits for a cold start.
 */
async function keepWorkersAwake() {
  const workers = await reportBotDb().from("report_bot_settings").select("worker_url").not("worker_url", "is", null);
  await Promise.allSettled((workers.data ?? []).map(async ({ worker_url: url }) => {
    if (typeof url !== "string" || !url.startsWith("https://")) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      await fetch(`${url.replace(/\/+$/, "")}/health`, { cache: "no-store", signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }));
}

/** Every minute: keep workers awake, then daily requests, reminders, image analysis and the send queue. */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isEddCronHost(new URL(request.url).hostname)) return NextResponse.json({ skipped: "Report Bot runs on OpsPulse only" });
  const deadline = Date.now() + 280_000;
  const db = reportBotDb();
  await keepWorkersAwake();
  const companies = await db.from("report_bot_settings").select("*").neq("mode", "off");
  if (companies.error) return NextResponse.json({ error: companies.error.message }, { status: 500 });
  const results = [];
  for (const row of (companies.data ?? []) as ReportBotSettings[]) {
    const settings = { ...row, auto_send_min_confidence: Number(row.auto_send_min_confidence) };
    try {
      results.push(await runReportBotCycle(settings, deadline));
    } catch (error) {
      console.error("[report-bot] cycle failed", { companyId: settings.company_id, error });
      results.push({ company_id: settings.company_id, error: error instanceof Error ? error.message : "Cycle failed" });
    }
  }
  return NextResponse.json({ ok: true, results });
}
