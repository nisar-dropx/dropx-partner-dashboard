import { NextResponse } from "next/server";
import { isEddCronHost } from "@/lib/ops-pulse/edd-cron-scope";
import { runReportBotCycle } from "@/lib/report-bot/pipeline";
import { reportBotDb, type ReportBotSettings } from "@/lib/report-bot/settings";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Every minute: daily requests, reminders, image analysis and the send queue for each company. */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isEddCronHost(new URL(request.url).hostname)) return NextResponse.json({ skipped: "Report Bot runs on OpsPulse only" });
  const deadline = Date.now() + 280_000;
  const db = reportBotDb();
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
