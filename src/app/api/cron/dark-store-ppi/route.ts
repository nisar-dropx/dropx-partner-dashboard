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

// Testing group — PPI is only sent here until fully validated
const TESTING_GROUP_ID = "120363429732355530@g.us";

type DailyRow  = { station_code: string; username: string; order_count: number; unit_count: number; avg_ppt_seconds: number | null };
type HourlyRow = { station_code: string; hour: number; order_count: number; unit_count: number; avg_ppt_seconds: number | null };

/** Build the compact PPI caption:
 *  TCD4
 *  • PPI today as of 12:00 hrs: 42s (Improved by 8s)
 */
function buildCaption(
  stationCode: string,
  daily: DailyRow[],
  hourly: HourlyRow[],
  windowHour: number,
  prevAvgPptSeconds: number | null
): string {
  const totalOrders = daily.reduce((s, r) => s + r.order_count, 0);
  const totalPptS   = daily.reduce((s, r) => s + (r.avg_ppt_seconds ?? 0) * r.order_count, 0);
  const avgPpt      = totalOrders > 0 ? totalPptS / totalOrders : null;

  const pad = (n: number) => String(n).padStart(2, "0");
  const timeLabel = `${pad(windowHour)}:00`;

  let trendNote = "";
  if (avgPpt != null && prevAvgPptSeconds != null) {
    const diff = Math.round(prevAvgPptSeconds - avgPpt); // positive = improved (lower PPT)
    if (diff > 0)       trendNote = ` (Improved by ${diff}s)`;
    else if (diff < 0)  trendNote = ` (Declined by ${Math.abs(diff)}s)`;
    else                trendNote = " (No change)";
  }

  const pptDisplay = avgPpt != null ? fmtSeconds(avgPpt) : "No data";

  return [
    `*${stationCode}*`,
    `• PPI today as of ${timeLabel} hrs: ${pptDisplay}${trendNote}`,
  ].join("\n");
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

  const pad = (n: number) => String(n).padStart(2, "0");
  const windowLabel = `${pad(hour)}:00`;

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

  const stationCodes = [...new Set((stations ?? []).map(s => s.station_code as string))];

  // Previous window hour for trend comparison (2 hrs back)
  const prevHour = hour >= 2 ? hour - 2 : null;

  const [dailyResult, hourlyResult, prevHourlyResult] = await Promise.all([
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
    prevHour != null
      ? db.from("ds_ppi_hourly")
          .select("station_code,avg_ppt_seconds,order_count")
          .eq("company_id", COMPANY_ID)
          .in("station_code", stationCodes)
          .eq("business_date", today)
          .in("hour", [prevHour - 1, prevHour].filter(h => h >= 0))
      : Promise.resolve({ data: [] }),
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
  // Previous window avg PPT per store (for trend arrow)
  const prevPptByStore = new Map<string, number>();
  for (const row of ((prevHourlyResult as { data: { station_code: string; avg_ppt_seconds: number | null; order_count: number }[] | null }).data ?? [])) {
    if (row.avg_ppt_seconds == null) continue;
    const prev = prevPptByStore.get(row.station_code);
    // Weighted average
    prevPptByStore.set(row.station_code, prev != null ? (prev + row.avg_ppt_seconds) / 2 : row.avg_ppt_seconds);
  }

  const settings = await loadReportBotSettings(COMPANY_ID);
  const results: Array<{ store: string; group: string; status: string }> = [];

  // Build one combined message with all stores — send only to testing group
  const storeLines: string[] = [];
  for (const stationCode of stationCodes.sort()) {
    const daily  = dailyByStore.get(stationCode)  ?? [];
    const hourly = hourlyByStore.get(stationCode) ?? [];
    const prevPpt = prevPptByStore.get(stationCode) ?? null;
    storeLines.push(buildCaption(stationCode, daily, hourly, hour, prevPpt));
  }

  if (storeLines.length === 0) return NextResponse.json({ ok: true, sent: 0, reason: "no data" });

  const combinedText = storeLines.join("\n\n");

  // Build PPI image — matches the PPI Calculation Dashboard design exactly
  // White bg, green-600 header (#16a34a), alternating white/#f3f4f6 rows,
  // PPT bold green-700 (#15803d), ASCII-only trend (safe on all Android WhatsApp)
  let imageBase64: string | undefined;
  try {
    const sharp = (await import("sharp")).default;

    const W = 600;
    const BANNER_H  = 72;  // top green title banner
    const SUBHEAD_H = 36;  // date/time subtitle bar
    const COL_H     = 42;  // column header row
    const ROW_H     = 50;  // per-store data row
    const TOTAL_H   = 48;  // green total row
    const FOOTER_H  = 34;  // footer note

    // Build per-store data
    const dataRows = stationCodes.sort().map(code => {
      const daily = dailyByStore.get(code) ?? [];
      const totalOrders = daily.reduce((s, r) => s + r.order_count, 0);
      const totalUnits  = daily.reduce((s, r) => s + r.unit_count,  0);
      const totalPptS   = daily.reduce((s, r) => s + (r.avg_ppt_seconds ?? 0) * r.order_count, 0);
      const avgPpt = totalOrders > 0 ? totalPptS / totalOrders : null;
      const prevPpt = prevPptByStore.get(code) ?? null;
      const diff = avgPpt != null && prevPpt != null ? Math.round(prevPpt - avgPpt) : null;
      const trend      = diff == null ? "-" : diff > 0 ? `+${diff}s` : diff < 0 ? `-${Math.abs(diff)}s` : "=";
      const trendColor = diff == null ? "#9ca3af" : diff > 0 ? "#15803d" : diff < 0 ? "#dc2626" : "#6b7280";
      return { code, orders: totalOrders, units: totalUnits, ppt: avgPpt, trend, trendColor };
    });

    const grandOrders = dataRows.reduce((s, r) => s + r.orders, 0);
    const grandUnits  = dataRows.reduce((s, r) => s + r.units,  0);
    const grandPptS   = dataRows.reduce((s, r) => s + (r.ppt ?? 0) * r.orders, 0);
    const grandPpt    = grandOrders > 0 ? grandPptS / grandOrders : null;

    const H = BANNER_H + SUBHEAD_H + COL_H + dataRows.length * ROW_H + TOTAL_H + FOOTER_H;

    // Column x positions
    const C = { station: 24, orders: 190, units: 300, ppt: 430, trend: 578 };

    const font  = "Arial,Helvetica,sans-serif";
    const mono  = "Courier New,Courier,monospace";

    // ── Banner
    const banner = `
      <rect x="0" y="0" width="${W}" height="${BANNER_H}" fill="#16a34a"/>
      <text x="${W/2}" y="28" font-family="${font}" font-size="14" fill="#bbf7d0" text-anchor="middle" letter-spacing="2">DROPX DARK STORE</text>
      <text x="${W/2}" y="56" font-family="${font}" font-size="24" font-weight="bold" fill="#ffffff" text-anchor="middle">PPI Report</text>`;

    // ── Sub-header (date + time)
    const subY = BANNER_H;
    const subHead = `
      <rect x="0" y="${subY}" width="${W}" height="${SUBHEAD_H}" fill="#dcfce7"/>
      <text x="${W/2}" y="${subY + 24}" font-family="${font}" font-size="14" fill="#15803d" text-anchor="middle" font-weight="bold">As of ${windowLabel} hrs  |  ${today}</text>`;

    // ── Column header
    const colY = BANNER_H + SUBHEAD_H;
    const colHeader = `
      <rect x="0" y="${colY}" width="${W}" height="${COL_H}" fill="#15803d"/>
      <text x="${C.station}" y="${colY + 27}" font-family="${font}" font-size="13" font-weight="bold" fill="#ffffff">Station</text>
      <text x="${C.orders}"  y="${colY + 27}" font-family="${font}" font-size="13" font-weight="bold" fill="#ffffff" text-anchor="middle">Orders</text>
      <text x="${C.units}"   y="${colY + 27}" font-family="${font}" font-size="13" font-weight="bold" fill="#ffffff" text-anchor="middle">Units</text>
      <text x="${C.ppt}"     y="${colY + 27}" font-family="${font}" font-size="13" font-weight="bold" fill="#ffffff" text-anchor="middle">PPT (avg)</text>
      <text x="${C.trend}"   y="${colY + 27}" font-family="${font}" font-size="13" font-weight="bold" fill="#ffffff" text-anchor="end">vs prev</text>`;

    // ── Data rows
    const dataY = BANNER_H + SUBHEAD_H + COL_H;
    const rowsSvg = dataRows.map((r, i) => {
      const y   = dataY + i * ROW_H;
      const bg  = i % 2 === 0 ? "#ffffff" : "#f3f4f6";
      const pptText = r.ppt != null ? fmtSeconds(r.ppt) : "No data";
      const pptCol  = r.ppt != null ? "#15803d" : "#9ca3af";
      return `
        <rect x="0" y="${y}" width="${W}" height="${ROW_H}" fill="${bg}"/>
        <line x1="0" y1="${y+ROW_H-1}" x2="${W}" y2="${y+ROW_H-1}" stroke="#e5e7eb" stroke-width="1"/>
        <text x="${C.station}" y="${y+32}" font-family="${font}" font-size="17" font-weight="bold" fill="#111827">${r.code}</text>
        <text x="${C.orders}"  y="${y+32}" font-family="${mono}" font-size="15" fill="#374151" text-anchor="middle">${r.orders}</text>
        <text x="${C.units}"   y="${y+32}" font-family="${mono}" font-size="15" fill="#374151" text-anchor="middle">${r.units}</text>
        <text x="${C.ppt}"     y="${y+32}" font-family="${mono}" font-size="16" font-weight="bold" fill="${pptCol}" text-anchor="middle">${pptText}</text>
        <text x="${C.trend}"   y="${y+32}" font-family="${mono}" font-size="14" font-weight="bold" fill="${r.trendColor}" text-anchor="end">${r.trend}</text>`;
    }).join("\n");

    // ── Total row
    const totalY = dataY + dataRows.length * ROW_H;
    const totalPptText = grandPpt != null ? fmtSeconds(grandPpt) : "-";
    const totalRow = `
      <rect x="0" y="${totalY}" width="${W}" height="${TOTAL_H}" fill="#15803d"/>
      <text x="${C.station}" y="${totalY+30}" font-family="${font}" font-size="15" font-weight="bold" fill="#ffffff">TOTAL</text>
      <text x="${C.orders}"  y="${totalY+30}" font-family="${mono}" font-size="15" font-weight="bold" fill="#ffffff" text-anchor="middle">${grandOrders}</text>
      <text x="${C.units}"   y="${totalY+30}" font-family="${mono}" font-size="15" font-weight="bold" fill="#ffffff" text-anchor="middle">${grandUnits}</text>
      <text x="${C.ppt}"     y="${totalY+30}" font-family="${mono}" font-size="16" font-weight="bold" fill="#bbf7d0" text-anchor="middle">${totalPptText}</text>
      <text x="${C.trend}"   y="${totalY+30}" font-family="${font}" font-size="12" fill="#bbf7d0" text-anchor="end">overall avg</text>`;

    // ── Footer
    const footerY = totalY + TOTAL_H;
    const footer = `
      <rect x="0" y="${footerY}" width="${W}" height="${FOOTER_H}" fill="#f0fdf4"/>
      <text x="${W/2}" y="${footerY+22}" font-family="${font}" font-size="12" fill="#6b7280" text-anchor="middle">+Ns = improved (lower PPT)   -Ns = declined   vs previous 2-hr window</text>`;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <rect width="${W}" height="${H}" fill="#ffffff"/>
      ${banner}${subHead}${colHeader}${rowsSvg}${totalRow}${footer}
    </svg>`;

    const buf = await sharp(Buffer.from(svg)).png().toBuffer();
    imageBase64 = buf.toString("base64");
  } catch { /* skip image if sharp unavailable */ }

  try {
    await workerRequest<{ id: string }>(settings, "/send", {
      method: "POST",
      body: imageBase64
        ? { to: TESTING_GROUP_ID, image_base64: imageBase64, mime: "image/png", caption: combinedText, client_ref: `ppi-all-${today}-${hour}` }
        : { to: TESTING_GROUP_ID, text: combinedText, client_ref: `ppi-all-${today}-${hour}` },
      timeoutMs: 30000,
    });
    results.push({ store: "all", group: "Dark Store Testing", status: "sent" });
  } catch (err) {
    const msg = err instanceof WorkerError ? err.message : String(err);
    results.push({ store: "all", group: "Dark Store Testing", status: `error: ${msg}` });
  }

  return NextResponse.json({ ok: true, hour, windowLabel, results });
}
