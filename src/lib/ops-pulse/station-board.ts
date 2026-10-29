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

export type StationBoardPayload = {
  eddByDate: Record<string, number>;
  cReturn: Record<string, number>;
  cReturnTotal: number;
  pickupDone: number;
  pickupDonePct: number;
  daDsr: StationBoardDaDsr[];
  zeroDeliveries: number;
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

export type StationBoardView = "edd" | "creturn" | "dsr" | "zero";

/** Soft ink-friendly tint for Pickup % (avoid washed yellow). */
export function pickupPctColor(pct: number): string {
  if (pct >= 80) return "#d9f0e3";
  if (pct >= 50) return "#e7f3ec";
  if (pct > 0) return "#f3ece2";
  return "#f1e8e6";
}

export function emptyBoard(): StationBoardPayload {
  return { eddByDate: {}, cReturn: {}, cReturnTotal: 0, pickupDone: 0, pickupDonePct: 0, daDsr: [], zeroDeliveries: 0 };
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
  return {
    eddByDate,
    cReturn,
    cReturnTotal,
    pickupDone,
    pickupDonePct,
    daDsr,
    zeroDeliveries: Number(row.zeroDeliveries ?? daDsr.filter((d) => d.delivered === 0).length) || 0,
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
    sheets.push({
      name: "C-Return",
      rows: stations.flatMap((station) => {
        const statuses = cReturnStatuses(station.board);
        if (!station.board.cReturnTotal) {
          return [{ Station: station.stationCode, Region: regionLabel(regionForStation(station.stationCode)), Status: "", Count: 0, "Pickup Done %": "" }];
        }
        return [
          ...statuses.filter((row) => row.count > 0).map((row) => ({
            Station: station.stationCode,
            Region: regionLabel(regionForStation(station.stationCode)),
            Status: row.status,
            Count: row.count,
            "Pickup Done %": "",
          })),
          {
            Station: station.stationCode,
            Region: regionLabel(regionForStation(station.stationCode)),
            Status: "Grand Total",
            Count: station.board.cReturnTotal,
            "Pickup Done %": `${station.board.pickupDonePct}%`,
          },
        ];
      }),
    });
  }

  if (view === "dsr" || view === "full") {
    sheets.push({
      name: "DA DSR",
      rows: stations.flatMap((station) =>
        station.board.daDsr.map((da) => ({
          Station: station.stationCode,
          Region: regionLabel(regionForStation(station.stationCode)),
          "DA's Name": da.driverName || da.driverId,
          "DA ID": da.driverId,
          Delivered: da.delivered,
          "Delivery Failed": da.failed,
          "Delivery Rejected": da.rejected,
          OOR: da.oor,
          "Grand Total": da.total,
          "DSR%": da.dsrPct,
          "Zero delivery": da.delivered === 0 ? "Yes" : "No",
        })),
      ),
    });
  }

  if (view === "zero" || view === "full") {
    sheets.push({
      name: "Zero deliveries",
      rows: stations.flatMap((station) =>
        station.board.daDsr
          .filter((da) => da.delivered === 0)
          .map((da) => ({
            Station: station.stationCode,
            Region: regionLabel(regionForStation(station.stationCode)),
            "DA's Name": da.driverName || da.driverId,
            Delivered: da.delivered,
            "Delivery Failed": da.failed,
            "Delivery Rejected": da.rejected,
            OOR: da.oor,
            "Grand Total": da.total,
            "DSR%": da.dsrPct,
          })),
      ),
    });
  }

  return sheets.filter((sheet) => sheet.rows.length > 0);
}

export function stationBoardFilename(date: string, view: StationBoardView | "full", scope = "") {
  const slug =
    view === "full" ? "all"
      : view === "creturn" ? "c-return"
        : view === "dsr" ? "da-dsr"
          : view === "zero" ? "zero-deliveries"
            : "edd";
  const suffix = scope.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `station-board-${date}-${slug}${suffix ? `-${suffix}` : ""}.xlsx`;
}
