import { NextResponse } from "next/server";
import { reportBotDb, loadReportBotSettings } from "@/lib/report-bot/settings";
import { workerRequest, WorkerError } from "@/lib/report-bot/worker-client";
import { isEddCronHost } from "@/lib/ops-pulse/edd-cron-scope";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const COMPANY_ID = "43866344-b550-4e8a-9a2d-9d23f3d8a997";

// IST = UTC+5:30
function nowIST() {
  return new Date(Date.now() + 5.5 * 3600 * 1000);
}

function todayIST() {
  return nowIST().toISOString().slice(0, 10);
}

/** Format ms as "Xm Ys" or just "Xs" */
function fmtSeconds(sec: number | null) {
  if (!sec || sec <= 0) return "—";
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Build the WhatsApp message for a store's 2-hour PPI window */
function buildMessage(
  stationCode: string,
  windowLabel: string,
  dailyRows: Array<{ username: string; order_count: number; unit_count: number; avg_ppt_seconds: number | null }>,
  hourlyRows: Array<{ hour: number; order_count: number; unit_count: number; avg_ppt_seconds: number | null }>,
  windowHour: number
): string {
  const totalOrders = dailyRows.reduce((s, r) => s + r.order_count, 0);
  const totalUnits  = dailyRows.reduce((s, r) => s + r.unit_count, 0);
  const totalPptMs  = dailyRows.reduce((s, r) => s + (r.avg_ppt_seconds ?? 0) * r.order_count, 0);
  const avgPpt      = totalOrders > 0 ? totalPptMs / totalOrders : null;

  // Window rows = last 2 hours up to windowHour
  const windowHours = [windowHour - 1, windowHour].filter(h => h >= 0);
  const windowRows  = hourlyRows.filter(r => windowHours.includes(r.hour));
  const winOrders   = windowRows.reduce((s, r) => s + r.order_count, 0);
  const winUnits    = windowRows.reduce((s, r) => s + r.unit_count, 0);
  const winPptMs    = windowRows.reduce((s, r) => s + (r.avg_ppt_seconds ?? 0) * r.order_count, 0);
  const winAvgPpt   = winOrders > 0 ? winPptMs / winOrders : null;

  const lines: string[] = [
    `📦 *${stationCode} PPI Report — ${windowLabel}*`,
    "",
    `*Last 2 hrs (${windowLabel})*`,
    `Orders: ${winOrders}  |  Units: ${winUnits}  |  Avg PPT: ${fmtSeconds(winAvgPpt)}`,
    "",
    `*Day so far (${todayIST()})*`,
    `Orders: ${totalOrders}  |  Units: ${totalUnits}  |  Avg PPT: ${fmtSeconds(avgPpt)}`,
    "",
    "*Per picker (day)*",
  ];

  if (dailyRows.length === 0) {
    lines.push("No data yet.");
  } else {
    for (const row of [...dailyRows].sort((a, b) => b.order_count - a.order_count)) {
      lines.push(`• ${row.username}: ${row.order_count} orders, ${row.unit_count} units, avg ${fmtSeconds(row.avg_ppt_seconds)}`);
    }
  }

  return lines.join("\n");
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isEddCronHost(new URL(request.url).hostname)) {
    return NextResponse.json({ skipped: "Dark store PPI runs on OpsPulse only" });
  }

  const ist     = nowIST();
  const hour    = ist.getUTCHours(); // IST hour (UTC+5:30 already applied)
  const today   = todayIST();
  // Window label e.g. "08:00–10:00"
  const pad = (n: number) => String(n).padStart(2, "0");
  const windowLabel = `${pad(hour - 1)}:00–${pad(hour)}:00`;

  const db = reportBotDb();

  // Load all dark_store groups with their wa_group_id and station_code via location_id
  const { data: groups } = await db.from("report_bot_groups")
    .select("id,wa_group_id,group_name,location_id,workspace")
    .eq("company_id", COMPANY_ID)
    .eq("workspace", "dark_store")
    .eq("is_enabled", true)
    .not("location_id", "is", null);

  if (!groups?.length) return NextResponse.json({ ok: true, sent: 0, reason: "no dark_store groups" });

  // Load station codes for each location_id
  const locationIds = groups.map(g => g.location_id!);
  const { data: stations } = await db.from("stations")
    .select("id,station_code")
    .in("id", locationIds);
  const stationByLocationId = new Map((stations ?? []).map(s => [s.id, s.station_code]));

  // Load PPI data for today for all dark store station codes
  const stationCodes = [...new Set((stations ?? []).map(s => s.station_code))];
  const [dailyResult, hourlyResult] = await Promise.all([
    db.from("ds_ppi_daily")
      .select("station_code,username,order_count,unit_count,avg_ppt_seconds")
      .eq("company_id", COMPANY_ID)
      .in("station_code", stationCodes)
      .eq("business_date", today),
    db.from("ds_ppi_hourly")
      .select("station_code,hour,order_count,unit_count,avg_ppt_seconds")
      .eq("company_id", COMPANY_ID)
      .in("station_code", stationCodes)
      .eq("business_date", today)
  ]);

  const dailyByStore  = new Map<string, typeof dailyResult.data>();
  for (const row of dailyResult.data ?? []) {
    if (!dailyByStore.has(row.station_code)) dailyByStore.set(row.station_code, []);
    dailyByStore.get(row.station_code)!.push(row);
  }
  const hourlyByStore = new Map<string, typeof hourlyResult.data>();
  for (const row of hourlyResult.data ?? []) {
    if (!hourlyByStore.has(row.station_code)) hourlyByStore.set(row.station_code, []);
    hourlyByStore.get(row.station_code)!.push(row);
  }

  const settings = await loadReportBotSettings(COMPANY_ID);
  const results: Array<{ store: string; status: string }> = [];

  for (const group of groups ?? []) {
    const stationCode = stationByLocationId.get(group.location_id!);
    if (!stationCode) continue;

    const daily  = dailyByStore.get(stationCode)  ?? [];
    const hourly = hourlyByStore.get(stationCode) ?? [];
    const text   = buildMessage(stationCode, windowLabel, daily, hourly, hour);

    try {
      await workerRequest<{ id: string }>(settings, "/send", {
        method: "POST",
        body: { to: group.wa_group_id, text, client_ref: `ppi-${stationCode}-${today}-${hour}` },
        timeoutMs: 20000
      });
      results.push({ store: stationCode, status: "sent" });
    } catch (err) {
      const msg = err instanceof WorkerError ? err.message : String(err);
      results.push({ store: stationCode, status: `error: ${msg}` });
    }
  }

  return NextResponse.json({ ok: true, hour, windowLabel, results });
}
