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

  /** Build a per-station PNG matching the PPI Calculation Dashboard exactly */
  async function buildStationImage(code: string): Promise<string | null> {
    try {
      const sharp = (await import("sharp")).default;
      const daily  = dailyByStore.get(code)  ?? [];
      const hourly = hourlyByStore.get(code) ?? [];

      // Aggregate per-picker (username = row key in ds_ppi_daily)
      const pickerMap = new Map<string, { orders: number; units: number; totalPptS: number }>();
      for (const r of daily) {
        const ex = pickerMap.get(r.username) ?? { orders: 0, units: 0, totalPptS: 0 };
        ex.orders    += r.order_count;
        ex.units     += r.unit_count;
        ex.totalPptS += (r.avg_ppt_seconds ?? 0) * r.order_count;
        pickerMap.set(r.username, ex);
      }
      // Dashboard shows raw SUM of PPT seconds and COUNTA of orders — keep those
      const pickers = [...pickerMap.entries()].map(([name, v]) => ({
        name,
        orders:   v.orders,
        sumPpt:   v.totalPptS,                                           // SUM of PPT (seconds)
        units:    v.units,                                               // Sum of Quantity
        ppt:      v.orders > 0 ? v.totalPptS / v.orders : null,         // PPT (seconds) = avg
      }));
      // Not sorted by PPT — keep original insertion order (matches dashboard default)

      const totalOrders = pickers.reduce((s, r) => s + r.orders, 0);
      const totalUnits  = pickers.reduce((s, r) => s + r.units,  0);
      const totalSumPpt = pickers.reduce((s, r) => s + r.sumPpt, 0);
      const avgPpt      = totalOrders > 0 ? totalSumPpt / totalOrders : null;
      const pptText     = avgPpt != null ? `${(avgPpt).toFixed(2)}s` : "No data";

      const prevPpt    = prevPptByStore.get(code) ?? null;
      const diff       = avgPpt != null && prevPpt != null ? Math.round(prevPpt - avgPpt) : null;
      const trend      = diff == null ? "" : diff > 0 ? `+${diff}s` : diff < 0 ? `-${Math.abs(diff)}s` : "=";
      const trendColor = diff == null ? "#9ca3af" : diff > 0 ? "#15803d" : "#dc2626";

      const uniqueUsers = pickers.length;

      // Hourly rows sorted by hour
      const recentHourly = [...hourly].filter(h => h.hour <= hour).sort((a, b) => a.hour - b.hour);

      // ── Layout constants (matches dashboard proportions at 640px wide)
      const W        = 640;
      const PAD      = 16;   // outer padding
      const TITLE_H  = 48;   // "Total Performance" header bar
      const CARD_H   = 80;   // stat cards row
      const GAP      = 12;   // gap between sections
      const SEC_H    = 44;   // "PPI Output" section title bar
      const COL_H    = 40;   // table column header
      const ROW_H    = 46;   // table data row
      const TOTAL_H  = 46;   // TOTAL row
      const HSEC_H   = recentHourly.length > 0 ? GAP + SEC_H + COL_H + recentHourly.length * ROW_H + TOTAL_H : 0;
      const FOOT_H   = 30;
      const H = PAD + TITLE_H + GAP + CARD_H + GAP + SEC_H + COL_H +
                (pickers.length || 1) * ROW_H + TOTAL_H + HSEC_H + FOOT_H + PAD;

      // ── Stat card helper (x, label, value)
      function statCard(x: number, label: string, value: string) {
        const CW = 112;
        return `
          <rect x="${x}" y="${PAD + TITLE_H + GAP}" width="${CW}" height="${CARD_H}" rx="8" fill="#ffffff" stroke="#e5e7eb" stroke-width="1"/>
          <text x="${x+12}" y="${PAD + TITLE_H + GAP + 22}" font-family="${F}" font-size="10" fill="#6b7280">${label}</text>
          <text x="${x+12}" y="${PAD + TITLE_H + GAP + 58}" font-family="${F}" font-size="20" font-weight="bold" fill="#111827">${value}</text>`;
      }

      // 5 stat cards across full width with equal spacing
      const cardW   = Math.floor((W - PAD * 2 - 4 * 8) / 5); // 5 cards, 4 gaps of 8px
      function card5(i: number, label: string, value: string) {
        const x = PAD + i * (cardW + 8);
        return `
          <rect x="${x}" y="${PAD + TITLE_H + GAP}" width="${cardW}" height="${CARD_H}" rx="8" fill="#ffffff" stroke="#e5e7eb" stroke-width="1.5"/>
          <text x="${x+10}" y="${PAD + TITLE_H + GAP + 20}" font-family="${F}" font-size="10" fill="#6b7280">${label}</text>
          <text x="${x+10}" y="${PAD + TITLE_H + GAP + 62}" font-family="${F}" font-size="22" font-weight="bold" fill="#111827">${value}</text>`;
      }

      const cards = [
        card5(0, "Site Code",      code),
        card5(1, "Orders",         String(totalOrders)),
        card5(2, "Total Quantity", String(totalUnits)),
        card5(3, "PPT",            pptText),
        card5(4, "Unique Users",   String(uniqueUsers)),
      ].join("");

      // ── PPI Output section
      const ppiY = PAD + TITLE_H + GAP + CARD_H + GAP;

      // section wrapper border (green)
      const ppiWrapH = SEC_H + COL_H + (pickers.length || 1) * ROW_H + TOTAL_H;
      const ppiWrap  = `<rect x="${PAD}" y="${ppiY}" width="${W - PAD*2}" height="${ppiWrapH}" rx="8" fill="#f0fdf4" stroke="#86efac" stroke-width="2"/>`;

      // section title bar
      const ppiTitle = `
        <text x="${PAD + 16}" y="${ppiY + 28}" font-family="${F}" font-size="15" font-weight="bold" fill="#111827">PPI Output</text>`;

      // column header — exact names from dashboard
      const tblX  = PAD + 4;
      const tblW  = W - PAD * 2 - 8;
      const colY2 = ppiY + SEC_H;
      // Column x positions matching dashboard proportions
      const TC = {
        name:   tblX + 10,
        orders: tblX + Math.floor(tblW * 0.33),
        sumPpt: tblX + Math.floor(tblW * 0.52),
        units:  tblX + Math.floor(tblW * 0.72),
        ppt:    tblX + tblW - 10,
      };
      const colHeader2 = `
        <rect x="${tblX}" y="${colY2}" width="${tblW}" height="${COL_H}" rx="4" fill="#16a34a"/>
        <text x="${TC.name}"   y="${colY2+26}" font-family="${F}" font-size="12" font-weight="bold" fill="#ffffff">Username</text>
        <text x="${TC.orders}" y="${colY2+26}" font-family="${F}" font-size="12" font-weight="bold" fill="#ffffff" text-anchor="middle">COUNTA of order id</text>
        <text x="${TC.sumPpt}" y="${colY2+26}" font-family="${F}" font-size="12" font-weight="bold" fill="#ffffff" text-anchor="middle">SUM of PPT (seconds)</text>
        <text x="${TC.units}"  y="${colY2+26}" font-family="${F}" font-size="12" font-weight="bold" fill="#ffffff" text-anchor="middle">Sum of Quantity</text>
        <text x="${TC.ppt}"    y="${colY2+26}" font-family="${F}" font-size="12" font-weight="bold" fill="#ffffff" text-anchor="end">PPT (seconds)</text>`;

      const dataY2 = colY2 + COL_H;
      const dataRowsSvg = pickers.length === 0
        ? `<rect x="${tblX}" y="${dataY2}" width="${tblW}" height="${ROW_H}" fill="#ffffff"/>
           <text x="${W/2}" y="${dataY2+30}" font-family="${F}" font-size="13" fill="#9ca3af" text-anchor="middle">No picker data</text>`
        : pickers.map((p, i) => {
            const y  = dataY2 + i * ROW_H;
            const bg = i % 2 === 0 ? "#ffffff" : "#f9fafb";
            const pt = p.ppt != null ? `${p.ppt.toFixed(2)}s` : "-";
            return `
              <rect x="${tblX}" y="${y}" width="${tblW}" height="${ROW_H}" fill="${bg}"/>
              <line x1="${tblX}" y1="${y+ROW_H}" x2="${tblX+tblW}" y2="${y+ROW_H}" stroke="#e5e7eb" stroke-width="1"/>
              <text x="${TC.name}"   y="${y+30}" font-family="${F}" font-size="13" fill="#111827">${p.name}</text>
              <text x="${TC.orders}" y="${y+30}" font-family="${F}" font-size="13" fill="#374151" text-anchor="middle">${p.orders}</text>
              <text x="${TC.sumPpt}" y="${y+30}" font-family="${F}" font-size="13" fill="#374151" text-anchor="middle">${p.sumPpt.toFixed(2)}</text>
              <text x="${TC.units}"  y="${y+30}" font-family="${F}" font-size="13" fill="#374151" text-anchor="middle">${p.units}</text>
              <text x="${TC.ppt}"    y="${y+30}" font-family="${F}" font-size="14" font-weight="bold" fill="#16a34a" text-anchor="end">${pt}</text>`;
          }).join("\n");

      const totalRowY = dataY2 + (pickers.length || 1) * ROW_H;
      const totalRowSvg = `
        <rect x="${tblX}" y="${totalRowY}" width="${tblW}" height="${TOTAL_H}" rx="0" fill="#15803d"/>
        <text x="${TC.name}"   y="${totalRowY+30}" font-family="${F}" font-size="13" font-weight="bold" fill="#ffffff">TOTAL</text>
        <text x="${TC.orders}" y="${totalRowY+30}" font-family="${F}" font-size="13" font-weight="bold" fill="#ffffff" text-anchor="middle">${totalOrders}</text>
        <text x="${TC.sumPpt}" y="${totalRowY+30}" font-family="${F}" font-size="13" font-weight="bold" fill="#ffffff" text-anchor="middle">${totalSumPpt.toFixed(2)}</text>
        <text x="${TC.units}"  y="${totalRowY+30}" font-family="${F}" font-size="13" font-weight="bold" fill="#ffffff" text-anchor="middle">${totalUnits}</text>
        <text x="${TC.ppt}"    y="${totalRowY+30}" font-family="${F}" font-size="14" font-weight="bold" fill="#bbf7d0" text-anchor="end">${pptText}</text>`;

      // ── Hourly section (amber theme, matches dashboard)
      let hourlySvg = "";
      if (recentHourly.length > 0) {
        const htY    = totalRowY + TOTAL_H + GAP;
        const hwrapH = SEC_H + COL_H + recentHourly.length * ROW_H + TOTAL_H;
        const HC = {
          hour:   tblX + 10,
          orders: tblX + Math.floor(tblW * 0.33),
          sumPpt: tblX + Math.floor(tblW * 0.55),
          units:  tblX + Math.floor(tblW * 0.75),
          ppt:    tblX + tblW - 10,
        };
        hourlySvg = `
          <rect x="${PAD}" y="${htY}" width="${W-PAD*2}" height="${hwrapH}" rx="8" fill="#fffbeb" stroke="#fcd34d" stroke-width="2"/>
          <text x="${PAD+16}" y="${htY+28}" font-family="${F}" font-size="15" font-weight="bold" fill="#111827">Hourly Breakdown</text>
          <rect x="${tblX}" y="${htY+SEC_H}" width="${tblW}" height="${COL_H}" rx="4" fill="#d97706"/>
          <text x="${HC.hour}"   y="${htY+SEC_H+26}" font-family="${F}" font-size="12" font-weight="bold" fill="#ffffff">Hour</text>
          <text x="${HC.orders}" y="${htY+SEC_H+26}" font-family="${F}" font-size="12" font-weight="bold" fill="#ffffff" text-anchor="middle">Orders</text>
          <text x="${HC.sumPpt}" y="${htY+SEC_H+26}" font-family="${F}" font-size="12" font-weight="bold" fill="#ffffff" text-anchor="middle">SUM of PPT (seconds)</text>
          <text x="${HC.units}"  y="${htY+SEC_H+26}" font-family="${F}" font-size="12" font-weight="bold" fill="#ffffff" text-anchor="middle">Sum of Quantity</text>
          <text x="${HC.ppt}"    y="${htY+SEC_H+26}" font-family="${F}" font-size="12" font-weight="bold" fill="#ffffff" text-anchor="end">PPT (seconds)</text>
          ${recentHourly.map((h, i) => {
            const y   = htY + SEC_H + COL_H + i * ROW_H;
            const bg  = i % 2 === 0 ? "#ffffff" : "#fffbeb";
            const ht  = h.avg_ppt_seconds != null ? `${Number(h.avg_ppt_seconds).toFixed(2)}s` : "-";
            const hsp = h.avg_ppt_seconds != null ? (Number(h.avg_ppt_seconds) * h.order_count).toFixed(2) : "-";
            const lbl = `${String(h.hour).padStart(2,"0")}:00`;
            return `
              <rect x="${tblX}" y="${y}" width="${tblW}" height="${ROW_H}" fill="${bg}"/>
              <line x1="${tblX}" y1="${y+ROW_H}" x2="${tblX+tblW}" y2="${y+ROW_H}" stroke="#fde68a" stroke-width="1"/>
              <text x="${HC.hour}"   y="${y+30}" font-family="${F}" font-size="13" fill="#374151">${lbl}</text>
              <text x="${HC.orders}" y="${y+30}" font-family="${F}" font-size="13" fill="#374151" text-anchor="middle">${h.order_count}</text>
              <text x="${HC.sumPpt}" y="${y+30}" font-family="${F}" font-size="13" fill="#374151" text-anchor="middle">${hsp}</text>
              <text x="${HC.units}"  y="${y+30}" font-family="${F}" font-size="13" fill="#374151" text-anchor="middle">${h.unit_count}</text>
              <text x="${HC.ppt}"    y="${y+30}" font-family="${F}" font-size="14" font-weight="bold" fill="#b45309" text-anchor="end">${ht}</text>`;
          }).join("\n")}
          ${(() => {
            const hty2 = htY + SEC_H + COL_H + recentHourly.length * ROW_H;
            const hto  = recentHourly.reduce((s, h) => s + h.order_count, 0);
            const htu  = recentHourly.reduce((s, h) => s + h.unit_count,  0);
            const htsp = recentHourly.reduce((s, h) => s + Number(h.avg_ppt_seconds ?? 0) * h.order_count, 0);
            return `
              <rect x="${tblX}" y="${hty2}" width="${tblW}" height="${TOTAL_H}" fill="#b45309"/>
              <text x="${HC.hour}"   y="${hty2+30}" font-family="${F}" font-size="13" font-weight="bold" fill="#ffffff">TOTAL</text>
              <text x="${HC.orders}" y="${hty2+30}" font-family="${F}" font-size="13" font-weight="bold" fill="#ffffff" text-anchor="middle">${hto}</text>
              <text x="${HC.sumPpt}" y="${hty2+30}" font-family="${F}" font-size="13" font-weight="bold" fill="#ffffff" text-anchor="middle">${htsp.toFixed(2)}</text>
              <text x="${HC.units}"  y="${hty2+30}" font-family="${F}" font-size="13" font-weight="bold" fill="#ffffff" text-anchor="middle">${htu}</text>
              <text x="${HC.ppt}"    y="${hty2+30}" font-family="${F}" font-size="14" font-weight="bold" fill="#fde68a" text-anchor="end">${pptText}</text>`;
          })()}`;
      }

      // ── Footer
      const footY = H - FOOT_H;
      const trendNote = trend
        ? `${trend} vs prev 2h window`
        : `As of ${windowLabel} hrs  |  ${today}`;
      const footerSvg = `
        <rect x="0" y="${footY}" width="${W}" height="${FOOT_H}" fill="#f9fafb"/>
        <text x="${W/2}" y="${footY+20}" font-family="${F}" font-size="11" fill="#9ca3af" text-anchor="middle">${trendNote}</text>`;

      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
        ${fontFace}
        <rect width="${W}" height="${H}" fill="#f1f5f9"/>
        <rect x="${PAD}" y="${PAD}" width="${W-PAD*2}" height="${TITLE_H}" rx="8" fill="#16a34a"/>
        <text x="${W/2}" y="${PAD+18}" font-family="${F}" font-size="12" fill="#bbf7d0" text-anchor="middle">DropX Dark Store  |  Total Performance</text>
        <text x="${W/2}" y="${PAD+40}" font-family="${F}" font-size="20" font-weight="bold" fill="#ffffff" text-anchor="middle">${code}${trend ? "   " + trend : ""}</text>
        ${cards}
        ${ppiWrap}${ppiTitle}${colHeader2}${dataRowsSvg}${totalRowSvg}
        ${hourlySvg}
        ${footerSvg}
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
