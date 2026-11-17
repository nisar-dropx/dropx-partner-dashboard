import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";
import { reportBotDb, loadReportBotSettings } from "@/lib/report-bot/settings";
import { workerRequest, WorkerError } from "@/lib/report-bot/worker-client";
import { isEddCronHost } from "@/lib/ops-pulse/edd-cron-scope";

// Loaded once — satori needs the font buffer at call time
let _fonts: { name: string; data: ArrayBuffer; weight: 400 | 700; style: "normal" }[] | null = null;
function getFonts() {
  if (_fonts) return _fonts;
  const dir = join(process.cwd(), "src/app/api/cron/dark-store-ppi");
  _fonts = [
    { name: "Inter", data: readFileSync(join(dir, "Inter-Regular.ttf")).buffer as ArrayBuffer, weight: 400 as const, style: "normal" as const },
    { name: "Inter", data: readFileSync(join(dir, "Inter-Bold.ttf")).buffer   as ArrayBuffer, weight: 700 as const, style: "normal" as const },
  ];
  return _fonts;
}

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

  const pptDisplay = avgPpt != null ? `${avgPpt.toFixed(2)}s` : "No data";

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

  // Map station_code → wa_group_id (for sending to the real War Room group)
  const groupByStation = new Map<string, { wa_group_id: string; group_name: string }>();
  for (const g of groups) {
    const st = (stations ?? []).find(s => s.id === g.location_id);
    if (st) groupByStation.set(st.station_code as string, { wa_group_id: g.wa_group_id, group_name: g.group_name });
  }

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

  // fonts loaded via getFonts() inside buildStationImage

  /** Build a per-station PNG using satori (bundled font renderer — no system fonts needed) */
  async function buildStationImage(code: string): Promise<string | { error: string } | null> {
    try {
      const satori = (await import("satori")).default;
      const { Resvg } = await import("@resvg/resvg-js");
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
      const pickers = [...pickerMap.entries()].map(([name, v]) => ({
        name,
        orders: v.orders,
        sumPpt: v.totalPptS,
        units:  v.units,
        ppt:    v.orders > 0 ? v.totalPptS / v.orders : null,
      }));

      const totalOrders = pickers.reduce((s, r) => s + r.orders, 0);
      const totalUnits  = pickers.reduce((s, r) => s + r.units,  0);
      const totalSumPpt = pickers.reduce((s, r) => s + r.sumPpt, 0);
      const avgPpt      = totalOrders > 0 ? totalSumPpt / totalOrders : null;
      const pptText     = avgPpt != null ? `${avgPpt.toFixed(2)}s` : "No data";
      const prevPpt     = prevPptByStore.get(code) ?? null;
      const diff        = avgPpt != null && prevPpt != null ? Math.round(prevPpt - avgPpt) : null;
      const trend       = diff == null ? "" : diff > 0 ? `+${diff}s` : diff < 0 ? `-${Math.abs(diff)}s` : "=";
      const trendColor  = diff == null ? "#9ca3af" : diff > 0 ? "#15803d" : "#dc2626";
      const recentHourly = [...hourly].filter(h => h.hour <= hour).sort((a, b) => a.hour - b.hour);

      // ── Satori layout helpers
      const W = 640;
      const col = (flex: number, children: unknown, style?: object) => ({
        type: "div", props: { style: { display: "flex", flex, alignItems: "center", padding: "0 8px", ...style }, children }
      });
      const txt = (s: string, style?: object) => ({ type: "span", props: { style: { fontFamily: "Inter", fontSize: 13, color: "#374151", ...style }, children: s } });

      // Table row
      function tRow(bg: string, cells: { v: string; flex: number; style?: object }[], bold = false) {
        return { type: "div", props: { style: { display: "flex", width: "100%", background: bg, borderBottom: "1px solid #e5e7eb", minHeight: 46 }, children:
          cells.map(c => col(c.flex, txt(c.v, { fontWeight: bold ? 700 : 400, ...c.style })))
        }};
      }

      // Stat card
      const statCard = (label: string, value: string) => ({ type: "div", props: { style: {
        display: "flex", flexDirection: "column", flex: 1, background: "#fff",
        border: "1.5px solid #e5e7eb", borderRadius: 8, padding: "10px 12px", margin: "0 4px"
      }, children: [
        { type: "span", props: { style: { fontSize: 11, color: "#6b7280", fontFamily: "Inter", marginBottom: 6 }, children: label } },
        { type: "span", props: { style: { fontSize: 22, fontWeight: 700, color: "#111827", fontFamily: "Inter" }, children: value } },
      ]}});

      // PPI table header row
      const ppiColBg = "#16a34a";
      const hcell = (v: string, flex: number) => col(flex, txt(v, { color: "#fff", fontWeight: 700, fontSize: 12 }), { background: ppiColBg, padding: "0 8px" });

      // Hourly table header
      const hhrColBg = "#d97706";
      const hhcell = (v: string, flex: number) => col(flex, txt(v, { color: "#fff", fontWeight: 700, fontSize: 12 }), { background: hhrColBg, padding: "0 8px" });

      const hTotalOrders = recentHourly.reduce((s, h) => s + h.order_count, 0);
      const hTotalUnits  = recentHourly.reduce((s, h) => s + h.unit_count,  0);
      const hTotalSumPpt = recentHourly.reduce((s, h) => s + Number(h.avg_ppt_seconds ?? 0) * h.order_count, 0);

      const layout = { type: "div", props: { style: { display: "flex", flexDirection: "column", width: W, background: "#f1f5f9", padding: 16, fontFamily: "Inter" }, children: [
        // ── Header banner
        { type: "div", props: { style: { display: "flex", flexDirection: "column", alignItems: "center", background: "#16a34a", borderRadius: 8, padding: "12px 20px", marginBottom: 12 }, children: [
          txt("DropX Dark Store  |  Total Performance", { color: "#bbf7d0", fontSize: 12, marginBottom: 4 }),
          { type: "div", props: { style: { display: "flex", alignItems: "center", gap: 16 }, children: [
            txt(code, { color: "#fff", fontWeight: 700, fontSize: 24 }),
            ...(trend ? [{ type: "div", props: { style: { display: "flex", background: `${trendColor}30`, borderRadius: 6, padding: "2px 10px" }, children: txt(trend, { color: trendColor, fontWeight: 700, fontSize: 15 }) }}] : []),
          ]}},
        ]}},
        // ── Summary line (always visible in image)
        { type: "div", props: { style: { display: "flex", justifyContent: "center", alignItems: "center", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 6, padding: "6px 16px", marginBottom: 10 }, children:
          txt(
            `PPI today as of ${windowLabel} hrs: ${pptText}` + (diff != null ? (diff > 0 ? `  ▲ Improved by ${Math.abs(diff)}s` : diff < 0 ? `  ▼ Declined by ${Math.abs(diff)}s` : "  = No change") : ""),
            { fontWeight: 700, fontSize: 14, color: "#15803d" }
          )
        }},
        // ── Stat cards row
        { type: "div", props: { style: { display: "flex", flexDirection: "row", marginBottom: 12, margin: "0 -4px 12px -4px" }, children: [
          statCard("Site Code",      code),
          statCard("Orders",         String(totalOrders)),
          statCard("Total Quantity", String(totalUnits)),
          statCard("PPT",            pptText),
          statCard("Unique Users",   String(pickers.length)),
        ]}},
        // ── PPI Output section
        { type: "div", props: { style: { display: "flex", flexDirection: "column", background: "#f0fdf4", border: "2px solid #86efac", borderRadius: 8, marginBottom: 12, overflow: "hidden" }, children: [
          { type: "div", props: { style: { display: "flex", padding: "10px 16px" }, children: txt("PPI Output", { fontWeight: 700, fontSize: 15, color: "#111827" }) }},
          // col header
          { type: "div", props: { style: { display: "flex", width: "100%", minHeight: 40, background: ppiColBg }, children: [
            hcell("Username",             3),
            hcell("COUNTA of order id",   2),
            hcell("SUM of PPT (seconds)", 3),
            hcell("Sum of Quantity",      2),
            hcell("PPT (seconds)",        2),
          ]}},
          // data rows
          ...(pickers.length === 0
            ? [{ type: "div", props: { style: { display: "flex", justifyContent: "center", padding: 16 }, children: txt("No picker data", { color: "#9ca3af" }) }}]
            : pickers.map((p, i) => tRow(i % 2 === 0 ? "#fff" : "#f9fafb", [
                { v: p.name,                 flex: 3 },
                { v: String(p.orders),       flex: 2, style: { color: "#374151" } },
                { v: p.sumPpt.toFixed(2),    flex: 3, style: { color: "#374151" } },
                { v: String(p.units),        flex: 2, style: { color: "#374151" } },
                { v: p.ppt != null ? `${p.ppt.toFixed(2)}s` : "-", flex: 2, style: { color: "#16a34a", fontWeight: 700 } },
              ]))
          ),
          // total row
          tRow("#15803d", [
            { v: "TOTAL",                  flex: 3, style: { color: "#fff", fontWeight: 700 } },
            { v: String(totalOrders),      flex: 2, style: { color: "#fff", fontWeight: 700 } },
            { v: totalSumPpt.toFixed(2),   flex: 3, style: { color: "#fff", fontWeight: 700 } },
            { v: String(totalUnits),       flex: 2, style: { color: "#fff", fontWeight: 700 } },
            { v: pptText,                  flex: 2, style: { color: "#bbf7d0", fontWeight: 700 } },
          ], true),
        ]}},
        // ── Hourly Breakdown (if data exists)
        ...(recentHourly.length === 0 ? [] : [{ type: "div", props: { style: { display: "flex", flexDirection: "column", background: "#fffbeb", border: "2px solid #fcd34d", borderRadius: 8, overflow: "hidden" }, children: [
          { type: "div", props: { style: { display: "flex", padding: "10px 16px" }, children: txt("Hourly Breakdown", { fontWeight: 700, fontSize: 15, color: "#111827" }) }},
          { type: "div", props: { style: { display: "flex", width: "100%", minHeight: 40, background: hhrColBg }, children: [
            hhcell("Hour",                 2),
            hhcell("Orders",               2),
            hhcell("SUM of PPT (seconds)", 3),
            hhcell("Sum of Quantity",      2),
            hhcell("PPT (seconds)",        2),
          ]}},
          ...recentHourly.map((h, i) => tRow(i % 2 === 0 ? "#fff" : "#fffbeb", [
            { v: `${String(h.hour).padStart(2,"0")}:00`, flex: 2 },
            { v: String(h.order_count), flex: 2 },
            { v: h.avg_ppt_seconds != null ? (Number(h.avg_ppt_seconds) * h.order_count).toFixed(2) : "-", flex: 3 },
            { v: String(h.unit_count), flex: 2 },
            { v: h.avg_ppt_seconds != null ? `${Number(h.avg_ppt_seconds).toFixed(2)}s` : "-", flex: 2, style: { color: "#b45309", fontWeight: 700 } },
          ] as { v: string; flex: number; style?: object }[])),
          tRow("#b45309", [
            { v: "TOTAL",                      flex: 2, style: { color: "#fff", fontWeight: 700 } },
            { v: String(hTotalOrders),          flex: 2, style: { color: "#fff", fontWeight: 700 } },
            { v: hTotalSumPpt.toFixed(2),       flex: 3, style: { color: "#fff", fontWeight: 700 } },
            { v: String(hTotalUnits),           flex: 2, style: { color: "#fff", fontWeight: 700 } },
            { v: pptText,                       flex: 2, style: { color: "#fde68a", fontWeight: 700 } },
          ], true),
        ]}}]),
        // footer
        { type: "div", props: { style: { display: "flex", justifyContent: "center", marginTop: 8 }, children:
          txt(trend ? `${trend} vs previous 2h window` : `As of ${windowLabel} hrs  |  ${today}`, { fontSize: 11, color: "#9ca3af" })
        }},
      ]}};

      // Estimate height: header(80) + summary(40) + cards(100) + ppi section(50 + 44 + pickers*46 + 46) + hourly(50 + 44 + hours*46 + 46) + footer(40) + padding(60)
      const ppiRows   = Math.max(pickers.length, 1);
      const hourRows  = recentHourly.length;
      const estH = 80 + 40 + 100 + 50 + 44 + ppiRows * 46 + 46 + (hourRows > 0 ? 50 + 44 + hourRows * 46 + 46 : 0) + 40 + 60;

      const svg = await satori(layout as Parameters<typeof satori>[0], {
        width: W,
        height: estH,
        fonts: getFonts(),
      });
      const resvg = new Resvg(svg, { fitTo: { mode: "width" as const, value: W } });
      const buf = resvg.render().asPng();
      return Buffer.from(buf).toString("base64");
    } catch (err) {
      // Surface the error so it shows in the cron response instead of silently falling back to text
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Send one message per station to its War Room group (falls back to testing group if not mapped)
  for (const stationCode of stationCodes.sort()) {
    const target = groupByStation.get(stationCode);
    const groupId   = target?.wa_group_id ?? TESTING_GROUP_ID;
    const groupName = target?.group_name  ?? "Dark Store Testing";
    const caption = buildCaption(
      stationCode,
      dailyByStore.get(stationCode)  ?? [],
      hourlyByStore.get(stationCode) ?? [],
      hour,
      prevPptByStore.get(stationCode) ?? null,
    );
    const imgResult = await buildStationImage(stationCode);
    const imgB64 = typeof imgResult === "string" ? imgResult : null;
    const imgError = imgResult && typeof imgResult === "object" ? (imgResult as { error: string }).error : null;
    try {
      await workerRequest<{ id: string }>(settings, "/send", {
        method: "POST",
        body: imgB64
          ? { to: groupId, image_base64: imgB64, mime: "image/png", caption, client_ref: `ppi-${stationCode}-${today}-${hour}-${Math.floor(Date.now()/60000)}` }
          : { to: groupId, text: caption, client_ref: `ppi-${stationCode}-${today}-${hour}-${Math.floor(Date.now()/60000)}` },
        timeoutMs: 30000,
      });
      results.push({ store: stationCode, group: groupName, status: imgB64 ? "sent" : `text_only: ${imgError ?? "image_failed"}` });
    } catch (err) {
      const msg = err instanceof WorkerError ? err.message : String(err);
      results.push({ store: stationCode, group: groupName, status: `error: ${msg}` });
    }
  }

  return NextResponse.json({ ok: true, hour, windowLabel, results });
}
