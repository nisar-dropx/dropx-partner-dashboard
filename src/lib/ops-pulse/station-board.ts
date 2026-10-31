import type { StationBoardRegionId } from "./station-board-regions.ts";
import { regionForStation, regionLabel, STATION_BOARD_REGIONS } from "./station-board-regions.ts";

export const CRETURN_DISPLAY = [
  "AT_STATION",
  "CANCELLED",
  "DELAYED",
  "ON_ROAD_WITH_DELIVERY_ASSOCIATE",
  "PICKUP_DONE",
  "UNPICKUPABLE",
] as const;

/** Excel rule: these Amazon states roll into PICKUP_DONE on the C-Return pivot. */
export const CRETURN_PICKED_UP_BUCKET = new Set([
  "PICKUP_DONE",
  "DELIVERED",
  "READY_FOR_FC_RETURN",
  "DEPARTED_FOR_FC",
]);

/** Short labels for compact C-Return tables / WhatsApp images. */
export const CRETURN_SHORT: Record<(typeof CRETURN_DISPLAY)[number], string> = {
  AT_STATION: "At station",
  CANCELLED: "Cancelled",
  DELAYED: "Delayed",
  ON_ROAD_WITH_DELIVERY_ASSOCIATE: "On road",
  PICKUP_DONE: "Pickup done",
  UNPICKUPABLE: "Unpickupable",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** `2026-10-29` → `Oct 29` */
export function boardDayLabel(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || "").trim());
  if (!m) return date;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${Number(m[3])}` : date;
}

export type StationBoardDaDsr = {
  driverId: string;
  driverName: string;
  delivered: number;
  failed: number;
  rejected: number;
  oor: number;
  total: number;
  dsrPct: number;
};

/** Condensed Ageing day buckets (Ops pivot image). */
export const AGEING_DAY_BUCKETS = ["1", "2-3", "4-7", "8-14", "14+"] as const;
export type AgeingDayBucket = (typeof AGEING_DAY_BUCKETS)[number];
export const AGEING_DAY_LABELS: Record<AgeingDayBucket, string> = {
  "1": "1 Day",
  "2-3": "2-3 Days",
  "4-7": "4-7 Days",
  "8-14": "8-14 Days",
  "14+": "14+ Days",
};

export type AgeingBucketCell = { count: number; amount: number };

export type StationBoardPayload = {
  eddByDate: Record<string, number>;
  cReturn: Record<string, number>;
  cReturnTotal: number;
  pickupDone: number;
  pickupDonePct: number;
  daDsr: StationBoardDaDsr[];
  zeroDeliveries: number;
  ageingByDay: Record<AgeingDayBucket, AgeingBucketCell>;
  ageingByWeek: Record<string, AgeingBucketCell>;
  /** Ageing let.xlsx: State → ISO week → Sum of Order Amount (INR). */
  ageingByStateWeek: Record<string, Record<string, number>>;
};

export type StationBoardStation = {
  stationCode: string;
  hasSnapshot: boolean;
  fetchedAt: string | null;
  businessDate: string;
  board: StationBoardPayload;
};

export type StationBoardNetwork = {
  asOf: string;
  businessDate: string;
  dates: string[];
  stations: StationBoardStation[];
  run: { id: string; status: string; stationsTotal: number; stationsDone: number; stationsOk: number; stationsFailed: number; startedAt: string; finishedAt: string | null } | null;
};

export type StationBoardView = "edd" | "creturn" | "dsr" | "zero" | "ageing";
export type AgeingBoardMode = "day" | "week";

/** Full DSR column labels (Excel / share image / board table — no abbreviations). */
export const DSR_HEADERS = {
  da: "DA's Name",
  delivered: "Delivered",
  failed: "Delivery Failed",
  rejected: "Delivery Rejected",
  oor: "Out on Road",
  total: "Total",
  dsrPct: "DSR%",
} as const;

/** Soft ink-friendly tint for Pickup % (avoid washed yellow). */
export function pickupPctColor(pct: number): string {
  if (pct >= 80) return "#d9f0e3";
  if (pct >= 50) return "#e7f3ec";
  if (pct > 0) return "#f3ece2";
  return "#f1e8e6";
}

/** Column sums + overall DSR% for DA DSR / Zero delivery tables. */
export function sumDaDsr(rows: StationBoardDaDsr[]): {
  delivered: number;
  failed: number;
  rejected: number;
  oor: number;
  total: number;
  dsrPct: number;
  daCount: number;
} {
  let delivered = 0;
  let failed = 0;
  let rejected = 0;
  let oor = 0;
  let total = 0;
  for (const da of rows) {
    delivered += Number(da.delivered) || 0;
    failed += Number(da.failed) || 0;
    rejected += Number(da.rejected) || 0;
    oor += Number(da.oor) || 0;
    total += Number(da.total) || 0;
  }
  return {
    delivered,
    failed,
    rejected,
    oor,
    total,
    dsrPct: total > 0 ? Math.round((delivered / total) * 100) : 0,
    daCount: rows.length,
  };
}

function emptyAgeingByDay(): Record<AgeingDayBucket, AgeingBucketCell> {
  return {
    "1": { count: 0, amount: 0 },
    "2-3": { count: 0, amount: 0 },
    "4-7": { count: 0, amount: 0 },
    "8-14": { count: 0, amount: 0 },
    "14+": { count: 0, amount: 0 },
  };
}

function parseAgeingCell(value: unknown): AgeingBucketCell {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { count: 0, amount: 0 };
  const row = value as Record<string, unknown>;
  return {
    count: Math.max(0, Number(row.count) || 0),
    amount: Math.round((Math.max(0, Number(row.amount) || 0) + Number.EPSILON) * 100) / 100,
  };
}

export function emptyBoard(): StationBoardPayload {
  return {
    eddByDate: {},
    cReturn: {},
    cReturnTotal: 0,
    pickupDone: 0,
    pickupDonePct: 0,
    daDsr: [],
    zeroDeliveries: 0,
    ageingByDay: emptyAgeingByDay(),
    ageingByWeek: {},
    ageingByStateWeek: {},
  };
}

export function normalizeBoard(raw: unknown): StationBoardPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyBoard();
  const row = raw as Record<string, unknown>;
  const eddByDate: Record<string, number> = {};
  if (row.eddByDate && typeof row.eddByDate === "object" && !Array.isArray(row.eddByDate)) {
    for (const [date, count] of Object.entries(row.eddByDate as Record<string, unknown>)) {
      const key = String(date).slice(0, 10);
      const n = Number(count) || 0;
      if (/^\d{4}-\d{2}-\d{2}$/.test(key) && n > 0) eddByDate[key] = n;
    }
  }
  const cReturn: Record<string, number> = {};
  if (row.cReturn && typeof row.cReturn === "object" && !Array.isArray(row.cReturn)) {
    for (const [state, count] of Object.entries(row.cReturn as Record<string, unknown>)) {
      const key = String(state || "").trim().toUpperCase();
      const n = Number(count) || 0;
      if (key && n > 0) cReturn[key] = n;
    }
  }
  const cReturnTotal = Number(row.cReturnTotal ?? Object.values(cReturn).reduce((a, b) => a + b, 0)) || 0;
  const pickupDone = Number(row.pickupDone ?? cReturn.PICKUP_DONE ?? 0) || 0;
  const pickupDonePct = Number(row.pickupDonePct ?? (cReturnTotal > 0 ? Math.round((pickupDone / cReturnTotal) * 100) : 0)) || 0;
  const daDsr: StationBoardDaDsr[] = [];
  if (Array.isArray(row.daDsr)) {
    for (const item of row.daDsr) {
      const da = (item ?? {}) as Record<string, unknown>;
      const total = Number(da.total) || 0;
      const delivered = Number(da.delivered) || 0;
      if (total <= 0) continue;
      daDsr.push({
        driverId: String(da.driverId ?? "").trim() || "(no DA)",
        driverName: String(da.driverName ?? "").trim(),
        delivered,
        failed: Number(da.failed) || 0,
        rejected: Number(da.rejected) || 0,
        oor: Number(da.oor) || 0,
        total,
        dsrPct: Number(da.dsrPct ?? (total > 0 ? Math.round((delivered / total) * 100) : 0)) || 0,
      });
    }
  }
  const ageingByDay = emptyAgeingByDay();
  if (row.ageingByDay && typeof row.ageingByDay === "object" && !Array.isArray(row.ageingByDay)) {
    for (const key of AGEING_DAY_BUCKETS) {
      const cell = (row.ageingByDay as Record<string, unknown>)[key];
      if (cell != null) ageingByDay[key] = parseAgeingCell(cell);
    }
  }
  const ageingByWeek: Record<string, AgeingBucketCell> = {};
  if (row.ageingByWeek && typeof row.ageingByWeek === "object" && !Array.isArray(row.ageingByWeek)) {
    for (const [week, cell] of Object.entries(row.ageingByWeek as Record<string, unknown>)) {
      const key = String(week || "").trim() || "(blank)";
      const parsed = parseAgeingCell(cell);
      if (parsed.count > 0 || parsed.amount > 0) ageingByWeek[key] = parsed;
    }
  }
  const ageingByStateWeek: Record<string, Record<string, number>> = {};
  if (row.ageingByStateWeek && typeof row.ageingByStateWeek === "object" && !Array.isArray(row.ageingByStateWeek)) {
    for (const [state, weeks] of Object.entries(row.ageingByStateWeek as Record<string, unknown>)) {
      if (!weeks || typeof weeks !== "object" || Array.isArray(weeks)) continue;
      const stateKey = String(state || "").trim() || "(blank)";
      const weekMap: Record<string, number> = {};
      for (const [week, amount] of Object.entries(weeks as Record<string, unknown>)) {
        const n = Math.round((Math.max(0, Number(amount) || 0) + Number.EPSILON) * 100) / 100;
        if (n > 0) weekMap[String(week || "").trim() || "(blank)"] = n;
      }
      if (Object.keys(weekMap).length) ageingByStateWeek[stateKey] = weekMap;
    }
  }
  return {
    eddByDate,
    cReturn,
    cReturnTotal,
    pickupDone,
    pickupDonePct,
    daDsr,
    zeroDeliveries: Number(row.zeroDeliveries ?? daDsr.filter((d) => d.delivered === 0).length) || 0,
    ageingByDay,
    ageingByWeek,
    ageingByStateWeek,
  };
}

/** Excel-style red→yellow→green heatmap (high = red). */
export function heatColor(value: number, max: number): string {
  if (!value || max <= 0) return "transparent";
  const t = Math.max(0, Math.min(1, value / max));
  // 0 green → 0.5 yellow → 1 red
  const r = Math.round(t < 0.5 ? 92 + t * 2 * (246 - 92) : 246);
  const g = Math.round(t < 0.5 ? 184 - t * 2 * (184 - 190) : 190 - (t - 0.5) * 2 * (190 - 78));
  const b = Math.round(t < 0.5 ? 92 - t * 2 * (92 - 72) : 72 - (t - 0.5) * 2 * (72 - 59));
  return `rgba(${r}, ${g}, ${b}, ${0.22 + t * 0.55})`;
}

/** DSR%: 100 green → mid yellow → 0 red. */
export function dsrHeatColor(pct: number): string {
  const t = Math.max(0, Math.min(1, 1 - pct / 100));
  return heatColor(t * 100, 100);
}

/** Shift a YYYY-MM-DD by N calendar days (UTC date math — safe for IST board dates). */
export function shiftBoardDate(date: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) + days * 86400000;
  const d = new Date(utc);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * EDD heatmap columns: last `pastDays` calendar days ending on the business
 * date (default 5 = today + 4 prior), plus every upcoming promised date that
 * still has packages. Older backlog dates are omitted from the grid.
 */
export function collectEddDates(stations: StationBoardStation[], businessDate: string, pastDays = 5): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) return [];
  const windowStart = shiftBoardDate(businessDate, -(Math.max(1, pastDays) - 1));
  const set = new Set<string>();
  for (let i = Math.max(1, pastDays) - 1; i >= 0; i--) set.add(shiftBoardDate(businessDate, -i));
  for (const station of stations) {
    for (const [date, count] of Object.entries(station.board.eddByDate)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(Number(count) > 0)) continue;
      if (date > businessDate) set.add(date);
      else if (date >= windowStart) set.add(date);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Grand total for EDD rows still uses the full promised-date map, not only the 4 visible days. */
export function eddStationTotal(station: StationBoardStation): number {
  return Object.values(station.board.eddByDate).reduce((a, b) => a + b, 0);
}

export function filterStationsByRegion(stations: StationBoardStation[], region: StationBoardRegionId | "ALL"): StationBoardStation[] {
  if (region === "ALL") return stations;
  return stations.filter((row) => regionForStation(row.stationCode) === region);
}

export function groupStationsByRegion(stations: StationBoardStation[]): Array<{ id: StationBoardRegionId; label: string; stations: StationBoardStation[] }> {
  const buckets = new Map<StationBoardRegionId, StationBoardStation[]>();
  for (const region of STATION_BOARD_REGIONS) buckets.set(region.id, []);
  buckets.set("OTHER", []);
  for (const station of stations) {
    const id = regionForStation(station.stationCode);
    const list = buckets.get(id) ?? [];
    list.push(station);
    buckets.set(id, list);
  }
  const out: Array<{ id: StationBoardRegionId; label: string; stations: StationBoardStation[] }> = [];
  for (const region of STATION_BOARD_REGIONS) {
    const rows = (buckets.get(region.id) ?? []).sort((a, b) => a.stationCode.localeCompare(b.stationCode));
    if (rows.length) out.push({ id: region.id, label: region.label, stations: rows });
  }
  const other = (buckets.get("OTHER") ?? []).sort((a, b) => a.stationCode.localeCompare(b.stationCode));
  if (other.length) out.push({ id: "OTHER", label: regionLabel("OTHER"), stations: other });
  return out;
}

export function eddPivot(stations: StationBoardStation[], dates: string[]) {
  const max = Math.max(0, ...stations.flatMap((s) => dates.map((d) => s.board.eddByDate[d] ?? 0)));
  const columnTotals = Object.fromEntries(dates.map((d) => [d, stations.reduce((sum, s) => sum + (s.board.eddByDate[d] ?? 0), 0)])) as Record<string, number>;
  const rows = stations.map((station) => {
    const cells = Object.fromEntries(dates.map((d) => [d, station.board.eddByDate[d] ?? 0])) as Record<string, number>;
    // Visible-window total for the heatmap row; full backlog remains on the station board payload.
    const total = Object.values(cells).reduce((a, b) => a + b, 0);
    return { stationCode: station.stationCode, cells, total, allTotal: eddStationTotal(station) };
  });
  const grandTotal = rows.reduce((sum, row) => sum + row.total, 0);
  return { max, columnTotals, rows, grandTotal };
}

/** Sort week39 < week40 < week9 numerically; (blank) last. */
export function sortAgeingWeekKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    if (a === "(blank)") return 1;
    if (b === "(blank)") return -1;
    const na = /^week(\d+)$/i.exec(a);
    const nb = /^week(\d+)$/i.exec(b);
    if (na && nb) return Number(na[1]) - Number(nb[1]);
    return a.localeCompare(b);
  });
}

export function collectAgeingWeeks(stations: StationBoardStation[]): string[] {
  const set = new Set<string>();
  for (const station of stations) {
    for (const [week, cell] of Object.entries(station.board.ageingByWeek ?? {})) {
      if ((cell?.count ?? 0) > 0 || (cell?.amount ?? 0) > 0) set.add(week);
    }
    for (const weeks of Object.values(station.board.ageingByStateWeek ?? {})) {
      for (const [week, amount] of Object.entries(weeks)) {
        if ((amount ?? 0) > 0) set.add(week);
      }
    }
  }
  return sortAgeingWeekKeys([...set]);
}

/** Ageing let.xlsx layout: State × ISO week Sum of Order Amount (region aggregate). */
export function ageingStateWeekPivot(stations: StationBoardStation[], weeks?: string[]) {
  const cols = weeks ?? collectAgeingWeeks(stations);
  const byState = new Map<string, Record<string, number>>();
  for (const station of stations) {
    for (const [state, weekMap] of Object.entries(station.board.ageingByStateWeek ?? {})) {
      if (!byState.has(state)) byState.set(state, Object.fromEntries(cols.map((w) => [w, 0])));
      const row = byState.get(state)!;
      for (const [week, amount] of Object.entries(weekMap)) {
        if (!(week in row)) continue;
        row[week] = Math.round((row[week] + (Number(amount) || 0) + Number.EPSILON) * 100) / 100;
      }
    }
  }
  const states = [...byState.keys()].sort((a, b) => a.localeCompare(b));
  const rows = states.map((state) => {
    const cells = byState.get(state) ?? Object.fromEntries(cols.map((w) => [w, 0]));
    const total = Math.round((cols.reduce((sum, w) => sum + (cells[w] ?? 0), 0) + Number.EPSILON) * 100) / 100;
    return { state, cells, total };
  });
  const columnTotals = Object.fromEntries(
    cols.map((w) => [w, Math.round((rows.reduce((sum, row) => sum + (row.cells[w] ?? 0), 0) + Number.EPSILON) * 100) / 100]),
  ) as Record<string, number>;
  const grandTotal = Math.round((rows.reduce((sum, row) => sum + row.total, 0) + Number.EPSILON) * 100) / 100;
  const maxAmount = Math.max(0, ...rows.map((row) => row.total), grandTotal);
  return { columns: cols, rows, columnTotals, grandTotal, maxAmount };
}

export function ageingStationTotals(board: StationBoardPayload): AgeingBucketCell {
  let count = 0;
  let amount = 0;
  for (const key of AGEING_DAY_BUCKETS) {
    const cell = board.ageingByDay?.[key] ?? { count: 0, amount: 0 };
    count += cell.count;
    amount += cell.amount;
  }
  return { count, amount: Math.round((amount + Number.EPSILON) * 100) / 100 };
}

export function ageingPivot(
  stations: StationBoardStation[],
  mode: AgeingBoardMode,
  weeks?: string[],
) {
  const columns = mode === "day" ? [...AGEING_DAY_BUCKETS] : (weeks ?? collectAgeingWeeks(stations));
  const rows = stations.map((station) => {
    const cells: Record<string, AgeingBucketCell> = {};
    let totalCount = 0;
    let totalAmount = 0;
    for (const col of columns) {
      const cell =
        mode === "day"
          ? (station.board.ageingByDay?.[col as AgeingDayBucket] ?? { count: 0, amount: 0 })
          : (station.board.ageingByWeek?.[col] ?? { count: 0, amount: 0 });
      cells[col] = cell;
      totalCount += cell.count;
      totalAmount += cell.amount;
    }
    return {
      stationCode: station.stationCode,
      cells,
      total: { count: totalCount, amount: Math.round((totalAmount + Number.EPSILON) * 100) / 100 },
    };
  });
  const columnTotals: Record<string, AgeingBucketCell> = {};
  for (const col of columns) {
    let count = 0;
    let amount = 0;
    for (const row of rows) {
      count += row.cells[col]?.count ?? 0;
      amount += row.cells[col]?.amount ?? 0;
    }
    columnTotals[col] = { count, amount: Math.round((amount + Number.EPSILON) * 100) / 100 };
  }
  const grandTotal = rows.reduce(
    (acc, row) => ({
      count: acc.count + row.total.count,
      amount: Math.round((acc.amount + row.total.amount + Number.EPSILON) * 100) / 100,
    }),
    { count: 0, amount: 0 },
  );
  const maxAmount = Math.max(0, ...rows.map((row) => row.total.amount), grandTotal.amount);
  return { columns, rows, columnTotals, grandTotal, maxAmount };
}

export function sumCReturn(stations: StationBoardStation[]) {
  const byStatus: Record<string, number> = {};
  for (const status of CRETURN_DISPLAY) byStatus[status] = 0;
  let total = 0;
  let pickupDone = 0;
  for (const station of stations) {
    for (const status of CRETURN_DISPLAY) {
      byStatus[status] = (byStatus[status] ?? 0) + (station.board.cReturn[status] ?? 0);
    }
    total += station.board.cReturnTotal || 0;
    pickupDone += station.board.pickupDone || 0;
  }
  return {
    byStatus,
    total,
    pickupDone,
    pickupDonePct: total > 0 ? Math.round((pickupDone / total) * 100) : 0,
  };
}

export function cReturnStatuses(board: StationBoardPayload): Array<{ status: string; count: number }> {
  const known = new Set<string>(CRETURN_DISPLAY);
  const rows: Array<{ status: string; count: number }> = CRETURN_DISPLAY.map((status) => ({ status, count: board.cReturn[status] ?? 0 }));
  for (const [status, count] of Object.entries(board.cReturn)) {
    if (!known.has(status) && count > 0) rows.push({ status, count });
  }
  return rows;
}

export function stationBoardSheets(
  network: StationBoardNetwork,
  view: StationBoardView | "full",
  stations: StationBoardStation[],
): Array<{ name: string; rows: Record<string, unknown>[] }> {
  const dates = collectEddDates(stations, network.businessDate);
  const sheets: Array<{ name: string; rows: Record<string, unknown>[] }> = [];

  if (view === "edd" || view === "full") {
    const pivot = eddPivot(stations, dates);
    sheets.push({
      name: "EDD by date",
      rows: [
        ...pivot.rows.map((row) => ({
          Station: row.stationCode,
          Region: regionLabel(regionForStation(row.stationCode)),
          ...Object.fromEntries(dates.map((d) => [d, row.cells[d] || ""])),
          "Grand Total": row.total,
        })),
        {
          Station: "Grand Total",
          Region: "",
          ...Object.fromEntries(dates.map((d) => [d, pivot.columnTotals[d] || ""])),
          "Grand Total": pivot.grandTotal,
        },
      ],
    });
  }

  if (view === "creturn" || view === "full") {
    const cReturnRows = stations.map((station) => ({
      Station: station.stationCode,
      Region: regionLabel(regionForStation(station.stationCode)),
      ...Object.fromEntries(CRETURN_DISPLAY.map((status) => [CRETURN_SHORT[status], station.board.cReturn[status] ?? 0])),
      Total: station.board.cReturnTotal || 0,
      "Pickup Done %": station.board.cReturnTotal ? `${station.board.pickupDonePct}%` : "",
    }));
    if (cReturnRows.length) {
      const tot = sumCReturn(stations);
      cReturnRows.push({
        Station: "Grand Total",
        Region: "",
        ...Object.fromEntries(CRETURN_DISPLAY.map((status) => [CRETURN_SHORT[status], tot.byStatus[status] ?? 0])),
        Total: tot.total,
        "Pickup Done %": tot.total ? `${tot.pickupDonePct}%` : "",
      });
    }
    sheets.push({ name: "C-Return", rows: cReturnRows });
  }

  if (view === "ageing" || view === "full") {
    const dayPivot = ageingPivot(stations, "day");
    sheets.push({
      name: "Ageing by day",
      rows: [
        ...dayPivot.rows.map((row) => ({
          Station: row.stationCode,
          Region: regionLabel(regionForStation(row.stationCode)),
          ...Object.fromEntries(
            AGEING_DAY_BUCKETS.flatMap((b) => [
              [`${AGEING_DAY_LABELS[b]} count`, row.cells[b]?.count || ""],
              [`${AGEING_DAY_LABELS[b]} amount`, row.cells[b]?.amount || ""],
            ]),
          ),
          "Total count": row.total.count,
          "Total amount": row.total.amount,
        })),
        {
          Station: "Grand Total",
          Region: "",
          ...Object.fromEntries(
            AGEING_DAY_BUCKETS.flatMap((b) => [
              [`${AGEING_DAY_LABELS[b]} count`, dayPivot.columnTotals[b]?.count || ""],
              [`${AGEING_DAY_LABELS[b]} amount`, dayPivot.columnTotals[b]?.amount || ""],
            ]),
          ),
          "Total count": dayPivot.grandTotal.count,
          "Total amount": dayPivot.grandTotal.amount,
        },
      ],
    });
    const weeks = collectAgeingWeeks(stations);
    if (weeks.length) {
      const weekPivot = ageingPivot(stations, "week", weeks);
      sheets.push({
        name: "Ageing by week",
        rows: [
          ...weekPivot.rows.map((row) => ({
            Station: row.stationCode,
            Region: regionLabel(regionForStation(row.stationCode)),
            ...Object.fromEntries(
              weeks.flatMap((w) => [
                [`${w} count`, row.cells[w]?.count || ""],
                [`${w} amount`, row.cells[w]?.amount || ""],
              ]),
            ),
            "Total count": row.total.count,
            "Total amount": row.total.amount,
          })),
          {
            Station: "Grand Total",
            Region: "",
            ...Object.fromEntries(
              weeks.flatMap((w) => [
                [`${w} count`, weekPivot.columnTotals[w]?.count || ""],
                [`${w} amount`, weekPivot.columnTotals[w]?.amount || ""],
              ]),
            ),
            "Total count": weekPivot.grandTotal.count,
            "Total amount": weekPivot.grandTotal.amount,
          },
        ],
      });
      const stateWeek = ageingStateWeekPivot(stations, weeks);
      if (stateWeek.rows.length) {
        sheets.push({
          name: "Ageing State x week",
          rows: [
            ...stateWeek.rows.map((row) => ({
              State: row.state,
              ...Object.fromEntries(weeks.map((w) => [w, row.cells[w] || ""])),
              "Grand Total": row.total,
            })),
            {
              State: "Grand Total",
              ...Object.fromEntries(weeks.map((w) => [w, stateWeek.columnTotals[w] || ""])),
              "Grand Total": stateWeek.grandTotal,
            },
          ],
        });
      }
    }
  }

  if (view === "dsr" || view === "full") {
    const dsrRows = stations.flatMap((station) =>
      station.board.daDsr.map((da) => ({
        Station: station.stationCode,
        Region: regionLabel(regionForStation(station.stationCode)),
        [DSR_HEADERS.da]: da.driverName || da.driverId,
        "DA ID": da.driverId,
        [DSR_HEADERS.delivered]: da.delivered,
        [DSR_HEADERS.failed]: da.failed,
        [DSR_HEADERS.rejected]: da.rejected,
        [DSR_HEADERS.oor]: da.oor,
        [DSR_HEADERS.total]: da.total,
        [DSR_HEADERS.dsrPct]: da.dsrPct,
        "Zero delivery": da.delivered === 0 ? "Yes" : "No",
      })),
    );
    if (dsrRows.length) {
      const tot = sumDaDsr(stations.flatMap((station) => station.board.daDsr));
      dsrRows.push({
        Station: "Grand Total",
        Region: "",
        [DSR_HEADERS.da]: `${tot.daCount} DAs`,
        "DA ID": "",
        [DSR_HEADERS.delivered]: tot.delivered,
        [DSR_HEADERS.failed]: tot.failed,
        [DSR_HEADERS.rejected]: tot.rejected,
        [DSR_HEADERS.oor]: tot.oor,
        [DSR_HEADERS.total]: tot.total,
        [DSR_HEADERS.dsrPct]: tot.dsrPct,
        "Zero delivery": "",
      });
    }
    sheets.push({ name: "DA DSR", rows: dsrRows });
  }

  if (view === "zero" || view === "full") {
    const zeroDas = stations.flatMap((station) =>
      station.board.daDsr.filter((da) => da.delivered === 0).map((da) => ({ station, da })),
    );
    const zeroRows = zeroDas.map(({ station, da }) => ({
      Station: station.stationCode,
      Region: regionLabel(regionForStation(station.stationCode)),
      [DSR_HEADERS.da]: da.driverName || da.driverId,
      [DSR_HEADERS.delivered]: da.delivered,
      [DSR_HEADERS.failed]: da.failed,
      [DSR_HEADERS.rejected]: da.rejected,
      [DSR_HEADERS.oor]: da.oor,
      [DSR_HEADERS.total]: da.total,
      [DSR_HEADERS.dsrPct]: da.dsrPct,
    }));
    if (zeroRows.length) {
      const tot = sumDaDsr(zeroDas.map(({ da }) => da));
      zeroRows.push({
        Station: "Grand Total",
        Region: "",
        [DSR_HEADERS.da]: `${tot.daCount} DAs`,
        [DSR_HEADERS.delivered]: tot.delivered,
        [DSR_HEADERS.failed]: tot.failed,
        [DSR_HEADERS.rejected]: tot.rejected,
        [DSR_HEADERS.oor]: tot.oor,
        [DSR_HEADERS.total]: tot.total,
        [DSR_HEADERS.dsrPct]: tot.dsrPct,
      });
    }
    sheets.push({ name: "Zero deliveries", rows: zeroRows });
  }

  return sheets.filter((sheet) => sheet.rows.length > 0);
}

export function stationBoardFilename(date: string, view: StationBoardView | "full", scope = "") {
  const slug =
    view === "full" ? "all"
      : view === "creturn" ? "c-return"
        : view === "dsr" ? "da-dsr"
          : view === "zero" ? "zero-deliveries"
            : view === "ageing" ? "ageing"
              : "edd";
  const suffix = scope.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `station-board-${date}-${slug}${suffix ? `-${suffix}` : ""}.xlsx`;
}
