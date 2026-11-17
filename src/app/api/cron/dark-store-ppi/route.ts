import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";
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

  // Run cleanup at 3am IST (hour === 3) — deletes data older than yesterday
  if (hour === 3) {
    await db.rpc("ds_ppi_cleanup");
  }

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

  if (stationCodes.length === 0) return NextResponse.json({ ok: true, sent: 0, reason: "no stations" });

  // Load Inter font once — embedded in every SVG so Vercel's Linux runtime renders text correctly
  let fontB64 = "";
  try {
    const fontPath = join(process.cwd(), "src/app/api/cron/dark-store-ppi/inter.woff2");
    fontB64 = readFileSync(fontPath).toString("base64");
  } catch { /* font missing — SVG text will still render with system fallback */ }

  const fontFace = fontB64
    ? `<style>@font-face{font-family:'Inter';src:url('data:font/woff2;base64,${fontB64}') format('woff2');}</style>`
    : "";
  const F = fontB64 ? "Inter,Arial,sans-serif" : "Arial,Helvetica,sans-serif";

  /** Build a per-station PNG card and return base64, or null on error */
  async function buildStationImage(code: string): Promise<string | null> {
    try {
      const sharp = (await import("sharp")).default;
      const daily  = dailyByStore.get(code)  ?? [];
      const hourly = hourlyByStore.get(code) ?? [];

      // Per-picker rows sorted by PPT asc
      const pickerMap = new Map<string, { orders: number; units: number; pptS: number }>();
      for (const r of daily) {
        const ex = pickerMap.get(r.username) ?? { orders: 0, units: 0, pptS: 0 };
        ex.orders += r.order_count;
        ex.units  += r.unit_count;
        ex.pptS   += (r.avg_ppt_seconds ?? 0) * r.order_count;
        pickerMap.set(r.username, ex);
      }
      const pickers = [...pickerMap.entries()]
        .map(([name, v]) => ({ name, orders: v.orders, units: v.units, ppt: v.orders > 0 ? v.pptS / v.orders : null }))
        .sort((a, b) => (a.ppt ?? 9999) - (b.ppt ?? 9999));

      const totalOrders = pickers.reduce((s, r) => s + r.orders, 0);
      const totalUnits  = pickers.reduce((s, r) => s + r.units,  0);
      const totalPptS   = pickers.reduce((s, r) => s + (r.ppt ?? 0) * r.orders, 0);
      const avgPpt      = totalOrders > 0 ? totalPptS / totalOrders : null;
      const prevPpt     = prevPptByStore.get(code) ?? null;
      const diff        = avgPpt != null && prevPpt != null ? Math.round(prevPpt - avgPpt) : null;
      const trend       = diff == null ? "" : diff > 0 ? `+${diff}s` : diff < 0 ? `-${Math.abs(diff)}s` : "=";
      const trendColor  = diff == null ? "#9ca3af" : diff > 0 ? "#15803d" : "#dc2626";

      // Hourly summary (last 6 hours max)
      const recentHourly = [...hourly]
        .filter(h => h.hour <= hour)
        .sort((a, b) => a.hour - b.hour)
        .slice(-6);

      const W = 560;
      const BANNER_H = 68;
      const STAT_H   = 52;
      const SEC_H    = 36; // section title
      const COL_H    = 36;
      const ROW_H    = 44;
      const TOTAL_H  = 44;
      const HOURLY_SEC_H = recentHourly.length > 0 ? SEC_H + COL_H + recentHourly.length * ROW_H + TOTAL_H : 0;
      const H = BANNER_H + STAT_H + SEC_H + COL_H + (pickers.length || 1) * ROW_H + TOTAL_H + HOURLY_SEC_H + 28;

      // helpers
      const cx = (x: number, w: number) => x + w / 2;
      const C = { name: 20, orders: 230, units: 320, ppt: 440, rank: 540 };

      // ── Banner
      const trendBadge = trend
        ? `<rect x="${W-100}" y="14" width="84" height="32" rx="6" fill="${trendColor}20"/>
           <text x="${W-58}" y="35" font-family="${F}" font-size="15" font-weight="bold" fill="${trendColor}" text-anchor="middle">${trend}</text>`
        : "";
      const bannerSvg = `
        <rect x="0" y="0" width="${W}" height="${BANNER_H}" fill="#16a34a"/>
        <text x="20" y="28" font-family="${F}" font-size="13" fill="#bbf7d0">DROPX DARK STORE PPI</text>
        <text x="20" y="56" font-family="${F}" font-size="26" font-weight="bold" fill="#ffffff">${code}</text>
        ${trendBadge}`;

      // ── Stat bar
      const sY = BANNER_H;
      const pptText = avgPpt != null ? fmtSeconds(avgPpt) : "No data";
      const statSvg = `
        <rect x="0" y="${sY}" width="${W}" height="${STAT_H}" fill="#dcfce7"/>
        <text x="20"       y="${sY+32}" font-family="${F}" font-size="13" fill="#166534">As of ${windowLabel} | ${today}</text>
        <text x="${W-20}"  y="${sY+20}" font-family="${F}" font-size="12" fill="#166534" text-anchor="end">Avg PPT</text>
        <text x="${W-20}"  y="${sY+42}" font-family="${F}" font-size="20" font-weight="bold" fill="#15803d" text-anchor="end">${pptText}</text>`;

      // ── Picker section title
      const ptY = sY + STAT_H;
      const pickerTitleSvg = `
        <rect x="0" y="${ptY}" width="${W}" height="${SEC_H}" fill="#f0fdf4"/>
        <text x="20" y="${ptY+23}" font-family="${F}" font-size="13" font-weight="bold" fill="#166534">Picker Breakdown  (${totalOrders} orders)</text>`;

      // ── Picker col header
      const pcY = ptY + SEC_H;
      const pickerColSvg = `
        <rect x="0" y="${pcY}" width="${W}" height="${COL_H}" fill="#15803d"/>
        <text x="${C.name}"   y="${pcY+23}" font-family="${F}" font-size="12" font-weight="bold" fill="#ffffff">Username</text>
        <text x="${C.orders}" y="${pcY+23}" font-family="${F}" font-size="12" font-weight="bold" fill="#ffffff" text-anchor="middle">Orders</text>
        <text x="${C.units}"  y="${pcY+23}" font-family="${F}" font-size="12" font-weight="bold" fill="#ffffff" text-anchor="middle">Units</text>
        <text x="${C.ppt}"    y="${pcY+23}" font-family="${F}" font-size="12" font-weight="bold" fill="#ffffff" text-anchor="middle">PPT (avg)</text>
        <text x="${C.rank}"   y="${pcY+23}" font-family="${F}" font-size="12" font-weight="bold" fill="#ffffff" text-anchor="middle">Rank</text>`;

      // ── Picker rows
      const prY = pcY + COL_H;
      const pickerRowsSvg = pickers.length === 0
        ? `<rect x="0" y="${prY}" width="${W}" height="${ROW_H}" fill="#ffffff"/>
           <text x="${W/2}" y="${prY+28}" font-family="${F}" font-size="14" fill="#9ca3af" text-anchor="middle">No picker data</text>`
        : pickers.map((p, i) => {
            const y  = prY + i * ROW_H;
            const bg = i % 2 === 0 ? "#ffffff" : "#f3f4f6";
            const pt = p.ppt != null ? fmtSeconds(p.ppt) : "-";
            const pc = p.ppt != null ? "#15803d" : "#9ca3af";
            return `
              <rect x="0" y="${y}" width="${W}" height="${ROW_H}" fill="${bg}"/>
              <line x1="0" y1="${y+ROW_H-1}" x2="${W}" y2="${y+ROW_H-1}" stroke="#e5e7eb" stroke-width="1"/>
              <text x="${C.name}"   y="${y+28}" font-family="${F}" font-size="13" font-weight="bold" fill="#111827">${p.name}</text>
              <text x="${C.orders}" y="${y+28}" font-family="${F}" font-size="13" fill="#374151" text-anchor="middle">${p.orders}</text>
              <text x="${C.units}"  y="${y+28}" font-family="${F}" font-size="13" fill="#374151" text-anchor="middle">${p.units}</text>
              <text x="${C.ppt}"    y="${y+28}" font-family="${F}" font-size="14" font-weight="bold" fill="${pc}" text-anchor="middle">${pt}</text>
              <text x="${C.rank}"   y="${y+28}" font-family="${F}" font-size="13" fill="#6b7280" text-anchor="middle">#${i+1}</text>`;
          }).join("\n");

      // ── Picker total row
      const pTotalY = prY + (pickers.length || 1) * ROW_H;
      const pickerTotalSvg = `
        <rect x="0" y="${pTotalY}" width="${W}" height="${TOTAL_H}" fill="#15803d"/>
        <text x="${C.name}"   y="${pTotalY+28}" font-family="${F}" font-size="13" font-weight="bold" fill="#ffffff">TOTAL</text>
        <text x="${C.orders}" y="${pTotalY+28}" font-family="${F}" font-size="13" font-weight="bold" fill="#ffffff" text-anchor="middle">${totalOrders}</text>
        <text x="${C.units}"  y="${pTotalY+28}" font-family="${F}" font-size="13" font-weight="bold" fill="#ffffff" text-anchor="middle">${totalUnits}</text>
        <text x="${C.ppt}"    y="${pTotalY+28}" font-family="${F}" font-size="14" font-weight="bold" fill="#bbf7d0" text-anchor="middle">${pptText}</text>`;

      // ── Hourly section
      let hourlySvg = "";
      if (recentHourly.length > 0) {
        const htY = pTotalY + TOTAL_H;
        const HC = { hour: 20, orders: 180, units: 290, ppt: 430 };
        const hourlyTitle = `
          <rect x="0" y="${htY}" width="${W}" height="${SEC_H}" fill="#fffbeb"/>
          <text x="20" y="${htY+23}" font-family="${F}" font-size="13" font-weight="bold" fill="#92400e">Hourly Breakdown</text>`;
        const hourlyCol = `
          <rect x="0" y="${htY+SEC_H}" width="${W}" height="${COL_H}" fill="#d97706"/>
          <text x="${HC.hour}"   y="${htY+SEC_H+23}" font-family="${F}" font-size="12" font-weight="bold" fill="#ffffff">Hour</text>
          <text x="${HC.orders}" y="${htY+SEC_H+23}" font-family="${F}" font-size="12" font-weight="bold" fill="#ffffff" text-anchor="middle">Orders</text>
          <text x="${HC.units}"  y="${htY+SEC_H+23}" font-family="${F}" font-size="12" font-weight="bold" fill="#ffffff" text-anchor="middle">Units</text>
          <text x="${HC.ppt}"    y="${htY+SEC_H+23}" font-family="${F}" font-size="12" font-weight="bold" fill="#ffffff" text-anchor="middle">PPT (avg)</text>`;
        const hourlyRows = recentHourly.map((h, i) => {
          const y  = htY + SEC_H + COL_H + i * ROW_H;
          const bg = i % 2 === 0 ? "#ffffff" : "#fffbeb";
          const ht = h.avg_ppt_seconds != null ? fmtSeconds(h.avg_ppt_seconds) : "-";
          const hc = h.avg_ppt_seconds != null ? "#b45309" : "#9ca3af";
          const label = `${String(h.hour).padStart(2,"0")}:00`;
          return `
            <rect x="0" y="${y}" width="${W}" height="${ROW_H}" fill="${bg}"/>
            <line x1="0" y1="${y+ROW_H-1}" x2="${W}" y2="${y+ROW_H-1}" stroke="#fde68a" stroke-width="1"/>
            <text x="${HC.hour}"   y="${y+28}" font-family="${F}" font-size="13" fill="#374151">${label}</text>
            <text x="${HC.orders}" y="${y+28}" font-family="${F}" font-size="13" fill="#374151" text-anchor="middle">${h.order_count}</text>
            <text x="${HC.units}"  y="${y+28}" font-family="${F}" font-size="13" fill="#374151" text-anchor="middle">${h.unit_count}</text>
            <text x="${HC.ppt}"    y="${y+28}" font-family="${F}" font-size="14" font-weight="bold" fill="${hc}" text-anchor="middle">${ht}</text>`;
        }).join("\n");
        const hourlyTotalY = htY + SEC_H + COL_H + recentHourly.length * ROW_H;
        const hTotalOrders = recentHourly.reduce((s, h) => s + h.order_count, 0);
        const hTotalUnits  = recentHourly.reduce((s, h) => s + h.unit_count,  0);
        const hourlyTotal  = `
          <rect x="0" y="${hourlyTotalY}" width="${W}" height="${TOTAL_H}" fill="#b45309"/>
          <text x="${HC.hour}"   y="${hourlyTotalY+28}" font-family="${F}" font-size="13" font-weight="bold" fill="#ffffff">TOTAL</text>
          <text x="${HC.orders}" y="${hourlyTotalY+28}" font-family="${F}" font-size="13" font-weight="bold" fill="#ffffff" text-anchor="middle">${hTotalOrders}</text>
          <text x="${HC.units}"  y="${hourlyTotalY+28}" font-family="${F}" font-size="13" font-weight="bold" fill="#ffffff" text-anchor="middle">${hTotalUnits}</text>
          <text x="${HC.ppt}"    y="${hourlyTotalY+28}" font-family="${F}" font-size="14" font-weight="bold" fill="#fde68a" text-anchor="middle">${pptText}</text>`;
        hourlySvg = hourlyTitle + hourlyCol + hourlyRows + hourlyTotal;
      }

      // ── Footer note
      const fY = H - 28;
      const footerSvg = trend
        ? `<rect x="0" y="${fY}" width="${W}" height="28" fill="#f9fafb"/>
           <text x="${W/2}" y="${fY+18}" font-family="${F}" font-size="11" fill="#9ca3af" text-anchor="middle">+Ns = improved (lower PPT)   -Ns = declined   vs previous 2h window</text>`
        : "";

      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
        ${fontFace}
        <rect width="${W}" height="${H}" fill="#ffffff"/>
        ${bannerSvg}${statSvg}${pickerTitleSvg}${pickerColSvg}${pickerRowsSvg}${pickerTotalSvg}${hourlySvg}${footerSvg}
      </svg>`;

      const buf = await sharp(Buffer.from(svg)).png().toBuffer();
      return buf.toString("base64");
    } catch {
      return null;
    }
  }

  // Send one message per station to the testing group
  for (const stationCode of stationCodes.sort()) {
    const caption = buildCaption(
      stationCode,
      dailyByStore.get(stationCode)  ?? [],
      hourlyByStore.get(stationCode) ?? [],
      hour,
      prevPptByStore.get(stationCode) ?? null,
    );
    const imgB64 = await buildStationImage(stationCode);
    try {
      await workerRequest<{ id: string }>(settings, "/send", {
        method: "POST",
        body: imgB64
          ? { to: TESTING_GROUP_ID, image_base64: imgB64, mime: "image/png", caption, client_ref: `ppi-${stationCode}-${today}-${hour}` }
          : { to: TESTING_GROUP_ID, text: caption, client_ref: `ppi-${stationCode}-${today}-${hour}` },
        timeoutMs: 30000,
      });
      results.push({ store: stationCode, group: "Dark Store Testing", status: "sent" });
    } catch (err) {
      const msg = err instanceof WorkerError ? err.message : String(err);
      results.push({ store: stationCode, group: "Dark Store Testing", status: `error: ${msg}` });
    }
  }

  return NextResponse.json({ ok: true, hour, windowLabel, results });
}
