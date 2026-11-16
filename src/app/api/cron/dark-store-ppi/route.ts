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

/** Format seconds as "Xm Ys" or "Xs". Returns "0s" for zero (valid PPT). */
function fmtSeconds(sec: number | null | undefined): string {
  if (sec == null || sec < 0) return "—";
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

type DailyRow  = { station_code: string; username: string; order_count: number; unit_count: number; avg_ppt_seconds: number | null };
type HourlyRow = { station_code: string; hour: number; order_count: number; unit_count: number; avg_ppt_seconds: number | null };

/** Build the WhatsApp text caption for a store's 2-hour PPI window */
function buildCaption(
  stationCode: string,
  windowLabel: string,
  daily: DailyRow[],
  hourly: HourlyRow[],
  windowHour: number
): string {
  const totalOrders = daily.reduce((s, r) => s + r.order_count, 0);
  const totalUnits  = daily.reduce((s, r) => s + r.unit_count, 0);
  const totalPptS   = daily.reduce((s, r) => s + (r.avg_ppt_seconds ?? 0) * r.order_count, 0);
  const avgPpt      = totalOrders > 0 ? totalPptS / totalOrders : null;

  // "Last 2 hrs" = the two completed IST hours before the cron fires (e.g. cron at 10:30 → hours 8 & 9)
  const windowHours = windowHour === 0
    ? [0]
    : [windowHour - 1, windowHour].filter(h => h >= 0 && h <= 23);
  const winRows   = hourly.filter(r => windowHours.includes(r.hour));
  const winOrders = winRows.reduce((s, r) => s + r.order_count, 0);
  const winUnits  = winRows.reduce((s, r) => s + r.unit_count, 0);
  const winPptS   = winRows.reduce((s, r) => s + (r.avg_ppt_seconds ?? 0) * r.order_count, 0);
  const winAvgPpt = winOrders > 0 ? winPptS / winOrders : null;

  const top10 = [...daily].sort((a, b) => b.order_count - a.order_count).slice(0, 10);

  const lines: string[] = [
    `📦 *${stationCode} PPI Report — ${windowLabel}*`,
    "",
    `*Last 2 hrs (${windowLabel})*`,
    `Orders: ${winOrders}  |  Units: ${winUnits}  |  Avg PPT: ${fmtSeconds(winAvgPpt)}`,
    "",
    `*Day so far (${todayIST()})*`,
    `Orders: ${totalOrders}  |  Units: ${totalUnits}  |  Avg PPT: ${fmtSeconds(avgPpt)}`,
    "",
    "*Per picker — top 10 (day)*",
  ];

  if (top10.length === 0) {
    lines.push("No data yet.");
  } else {
    for (const row of top10) {
      lines.push(`• ${row.username}: ${row.order_count} orders, ${row.unit_count} units, avg ${fmtSeconds(row.avg_ppt_seconds)}`);
    }
  }

  return lines.join("\n");
}

/** Generate a PPI dashboard image as a base64 PNG using sharp + SVG */
async function buildPpiImage(
  stationCode: string,
  windowLabel: string,
  daily: DailyRow[],
  hourly: HourlyRow[],
  windowHour: number,
  today: string
): Promise<string> {
  const sharp = (await import("sharp")).default;

  const top10 = [...daily].sort((a, b) => b.order_count - a.order_count).slice(0, 10);

  const totalOrders = daily.reduce((s, r) => s + r.order_count, 0);
  const totalUnits  = daily.reduce((s, r) => s + r.unit_count, 0);
  const totalPptS   = daily.reduce((s, r) => s + (r.avg_ppt_seconds ?? 0) * r.order_count, 0);
  const dayAvgPpt   = totalOrders > 0 ? totalPptS / totalOrders : null;

  const windowHours = windowHour === 0
    ? [0]
    : [windowHour - 1, windowHour].filter(h => h >= 0 && h <= 23);
  const winRows   = hourly.filter(r => windowHours.includes(r.hour));
  const winOrders = winRows.reduce((s, r) => s + r.order_count, 0);
  const winUnits  = winRows.reduce((s, r) => s + r.unit_count, 0);
  const winPptS   = winRows.reduce((s, r) => s + (r.avg_ppt_seconds ?? 0) * r.order_count, 0);
  const winAvgPpt = winOrders > 0 ? winPptS / winOrders : null;

  const W = 640;
  const ROW_H = 36;
  const TABLE_TOP = 240;
  const H = TABLE_TOP + (top10.length + 1) * ROW_H + 30; // header row + data rows + padding

  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const tableRows = top10.map((row, i) => {
    const bg = i % 2 === 0 ? "#1e2535" : "#252d3d";
    const y = TABLE_TOP + (i + 1) * ROW_H;
    return `
      <rect x="20" y="${y}" width="${W - 40}" height="${ROW_H}" fill="${bg}"/>
      <text x="36"       y="${y + 23}" font-size="13" fill="#e2e8f0">${i + 1}. ${esc(row.username)}</text>
      <text x="310"      y="${y + 23}" font-size="13" fill="#93c5fd" text-anchor="middle">${row.order_count}</text>
      <text x="430"      y="${y + 23}" font-size="13" fill="#86efac" text-anchor="middle">${row.unit_count}</text>
      <text x="580"      y="${y + 23}" font-size="13" fill="#fde68a" text-anchor="middle">${fmtSeconds(row.avg_ppt_seconds)}</text>
    `;
  }).join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <linearGradient id="hdr" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#1a2e4a"/>
        <stop offset="100%" stop-color="#0f2240"/>
      </linearGradient>
    </defs>
    <!-- Background -->
    <rect width="${W}" height="${H}" fill="#111827"/>

    <!-- Header bar -->
    <rect x="0" y="0" width="${W}" height="64" fill="url(#hdr)"/>
    <text x="24" y="28" font-size="20" font-weight="bold" fill="#ffffff">📦 ${esc(stationCode)} — PPI Dashboard</text>
    <text x="24" y="52" font-size="13" fill="#94a3b8">${windowLabel}  ·  ${today}</text>

    <!-- Stat tiles row 1: window -->
    <rect x="20"  y="80" width="180" height="68" rx="8" fill="#1e3a5f"/>
    <text x="110" y="105" font-size="11" fill="#94a3b8" text-anchor="middle">WINDOW ORDERS</text>
    <text x="110" y="135" font-size="26" font-weight="bold" fill="#93c5fd" text-anchor="middle">${winOrders}</text>

    <rect x="220" y="80" width="180" height="68" rx="8" fill="#1e3a5f"/>
    <text x="310" y="105" font-size="11" fill="#94a3b8" text-anchor="middle">WINDOW UNITS</text>
    <text x="310" y="135" font-size="26" font-weight="bold" fill="#86efac" text-anchor="middle">${winUnits}</text>

    <rect x="420" y="80" width="200" height="68" rx="8" fill="#1e3a5f"/>
    <text x="520" y="105" font-size="11" fill="#94a3b8" text-anchor="middle">WINDOW AVG PPT</text>
    <text x="520" y="135" font-size="26" font-weight="bold" fill="#fde68a" text-anchor="middle">${fmtSeconds(winAvgPpt)}</text>

    <!-- Stat tiles row 2: day -->
    <rect x="20"  y="164" width="180" height="56" rx="8" fill="#1e2a1e"/>
    <text x="110" y="186" font-size="11" fill="#94a3b8" text-anchor="middle">DAY ORDERS</text>
    <text x="110" y="210" font-size="22" font-weight="bold" fill="#6ee7b7" text-anchor="middle">${totalOrders}</text>

    <rect x="220" y="164" width="180" height="56" rx="8" fill="#1e2a1e"/>
    <text x="310" y="186" font-size="11" fill="#94a3b8" text-anchor="middle">DAY UNITS</text>
    <text x="310" y="210" font-size="22" font-weight="bold" fill="#6ee7b7" text-anchor="middle">${totalUnits}</text>

    <rect x="420" y="164" width="200" height="56" rx="8" fill="#1e2a1e"/>
    <text x="520" y="186" font-size="11" fill="#94a3b8" text-anchor="middle">DAY AVG PPT</text>
    <text x="520" y="210" font-size="22" font-weight="bold" fill="#fde68a" text-anchor="middle">${fmtSeconds(dayAvgPpt)}</text>

    <!-- Table header -->
    <rect x="20" y="${TABLE_TOP}" width="${W - 40}" height="${ROW_H}" rx="4" fill="#2563eb"/>
    <text x="36"  y="${TABLE_TOP + 23}" font-size="13" font-weight="bold" fill="#ffffff">PICKER</text>
    <text x="310" y="${TABLE_TOP + 23}" font-size="13" font-weight="bold" fill="#ffffff" text-anchor="middle">ORDERS</text>
    <text x="430" y="${TABLE_TOP + 23}" font-size="13" font-weight="bold" fill="#ffffff" text-anchor="middle">UNITS</text>
    <text x="580" y="${TABLE_TOP + 23}" font-size="13" font-weight="bold" fill="#ffffff" text-anchor="middle">AVG PPT</text>

    <!-- Table rows -->
    ${top10.length > 0 ? tableRows : `<text x="${W / 2}" y="${TABLE_TOP + ROW_H + 20}" font-size="14" fill="#6b7280" text-anchor="middle">No data yet</text>`}

    <!-- Footer -->
    <text x="${W / 2}" y="${H - 8}" font-size="10" fill="#374151" text-anchor="middle">DropX Logistics · Dark Store Operations</text>
  </svg>`;

  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return png.toString("base64");
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isEddCronHost(new URL(request.url).hostname)) {
    return NextResponse.json({ skipped: "Dark store PPI runs on OpsPulse only" });
  }

  const ist   = nowIST();
  const hour  = ist.getUTCHours(); // IST hour (UTC+5:30 already applied in nowIST)
  const today = todayIST();

  // Window label: cron fires at HH:30 IST — window is the two completed hours ending at HH:00
  // e.g. cron at 08:30 IST → windowHour=8 → label "06:00–08:00"
  const pad = (n: number) => String(n).padStart(2, "0");
  const windowStart = hour <= 1 ? 0 : hour - 2;
  const windowLabel = `${pad(windowStart)}:00–${pad(hour)}:00`;

  const db = reportBotDb();

  const { data: groups } = await db.from("report_bot_groups")
    .select("id,wa_group_id,group_name,location_id,workspace")
    .eq("company_id", COMPANY_ID)
    .eq("workspace", "dark_store")
    .eq("is_enabled", true)
    .not("location_id", "is", null);

  if (!groups?.length) return NextResponse.json({ ok: true, sent: 0, reason: "no dark_store groups" });

  const locationIds = groups.map(g => g.location_id!);
  const { data: stations } = await db.from("stations")
    .select("id,station_code")
    .in("id", locationIds);
  const stationByLocationId = new Map((stations ?? []).map(s => [s.id, s.station_code as string]));

  const stationCodes = [...new Set((stations ?? []).map(s => s.station_code as string))];
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
      .eq("business_date", today),
  ]);

  const dailyByStore  = new Map<string, DailyRow[]>();
  for (const row of (dailyResult.data ?? []) as DailyRow[]) {
    if (!dailyByStore.has(row.station_code)) dailyByStore.set(row.station_code, []);
    dailyByStore.get(row.station_code)!.push(row);
  }
  const hourlyByStore = new Map<string, HourlyRow[]>();
  for (const row of (hourlyResult.data ?? []) as HourlyRow[]) {
    if (!hourlyByStore.has(row.station_code)) hourlyByStore.set(row.station_code, []);
    hourlyByStore.get(row.station_code)!.push(row);
  }

  const settings = await loadReportBotSettings(COMPANY_ID);
  const results: Array<{ store: string; status: string }> = [];

  for (const group of groups) {
    const stationCode = stationByLocationId.get(group.location_id!);
    if (!stationCode) continue;

    const daily  = dailyByStore.get(stationCode)  ?? [];
    const hourly = hourlyByStore.get(stationCode) ?? [];

    const caption     = buildCaption(stationCode, windowLabel, daily, hourly, hour);
    let   image_base64: string | undefined;
    try {
      image_base64 = await buildPpiImage(stationCode, windowLabel, daily, hourly, hour, today);
    } catch {
      // image generation failure must not block the text message
    }

    try {
      await workerRequest<{ id: string }>(settings, "/send", {
        method: "POST",
        body: image_base64
          ? { to: group.wa_group_id, image_base64, mime: "image/png", caption, client_ref: `ppi-${stationCode}-${today}-${hour}` }
          : { to: group.wa_group_id, text: caption, client_ref: `ppi-${stationCode}-${today}-${hour}` },
        timeoutMs: 30000,
      });
      results.push({ store: stationCode, status: image_base64 ? "sent-image" : "sent-text" });
    } catch (err) {
      const msg = err instanceof WorkerError ? err.message : String(err);
      results.push({ store: stationCode, status: `error: ${msg}` });
    }
  }

  return NextResponse.json({ ok: true, hour, windowLabel, results });
}
