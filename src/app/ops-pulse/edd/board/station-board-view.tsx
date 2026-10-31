"use client";

import { useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Copy, Download, ImageDown, LayoutList, ListOrdered, Loader2, RefreshCw, Share2, X } from "lucide-react";
import type { EddNetworkRunStatus, LoadFlashBoardNetwork } from "@/lib/ops-pulse/edd-worker";
import { formatOpsDate, formatOpsDateTime } from "@/lib/ops-pulse/date-format";
import {
  AGEING_DAY_BUCKETS,
  AGEING_DAY_LABELS,
  ageingPivot,
  ageingStateWeekPivot,
  boardDayLabel,
  collectAgeingWeeks,
  CRETURN_DISPLAY,
  CRETURN_SHORT,
  collectEddDates,
  DSR_HEADERS,
  dsrHeatColor,
  eddPivot,
  eddStationTotal,
  filterStationsByRegion,
  groupStationsByRegion,
  heatColor,
  pickupPctColor,
  sumCReturn,
  sumDaDsr,
  type AgeingBoardMode,
  type StationBoardDaDsr,
  type StationBoardStation,
  type StationBoardView,
} from "@/lib/ops-pulse/station-board";
import type { StationBoardRegionId } from "@/lib/ops-pulse/station-board-regions";
import { STATION_BOARD_REGIONS } from "@/lib/ops-pulse/station-board-regions";
import { downloadBoardShare, renderBoardShareImages, shareBoardImages, type BoardShareCell, type BoardShareTable } from "@/lib/ops-pulse/station-board-share";
import s from "./board.module.css";

type Props = {
  initial: LoadFlashBoardNetwork;
  stationNames?: Record<string, string>;
  initialRegion?: string;
  initialView?: string;
};

type BlockBusy = "image" | "share" | null;
type TidMode = "grouped" | "day";
type PanelMode = "card" | "tids";

type TidRow = {
  trackingId: string;
  status: string;
  edd: string;
  driverId: string;
  driverName: string;
};

function groupTidsByDate(rows: TidRow[]): Array<{ date: string; label: string; rows: TidRow[] }> {
  const map = new Map<string, TidRow[]>();
  for (const row of rows) {
    const key = /^\d{4}-\d{2}-\d{2}$/.test(row.edd) ? row.edd : "unknown";
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, items]) => ({
      date,
      label: date === "unknown" ? "No EDD" : boardDayLabel(date),
      rows: items,
    }));
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

function asView(value: string | undefined): StationBoardView {
  const key = String(value || "edd").toLowerCase().replace(/[^a-z]/g, "");
  if (key === "creturn") return "creturn";
  if (key === "dsr" || key === "dadsr") return "dsr";
  if (key === "zero" || key === "zerodeliveries") return "zero";
  if (key === "ageing" || key === "aging") return "ageing";
  return "edd";
}

function inr(n: number) {
  return (Number(n) || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function asRegion(value: string | undefined): StationBoardRegionId | "ALL" {
  const key = String(value || "ALL").toUpperCase();
  if (key === "KL" || key === "AP" || key === "ODCG" || key === "OTHER") return key;
  return "ALL";
}

function count(n: number, blankZero = false) {
  if (!n && blankZero) return "";
  return (Number(n) || 0).toLocaleString("en-IN");
}

async function downloadWorkbook(date: string, report: StationBoardView | "full", region: StationBoardRegionId | "ALL") {
  const params = new URLSearchParams({ date, report, region });
  const response = await fetch(`/api/ops-pulse/edd/board/report?${params}`, { cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(String((body as { error?: string }).error ?? "Unable to download the workbook."));
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const named = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1];
  a.href = url;
  a.download = named || `station-board-${date}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function buildShareTable(
  view: StationBoardView,
  stations: StationBoardStation[],
  businessDate: string,
  regionLabel: string,
  stationNames: Record<string, string> = {},
  ageingMode: AgeingBoardMode = "week",
): BoardShareTable {
  const subtitle = `${formatOpsDate(businessDate, businessDate)} · ${regionLabel} · DropX Logistics`;
  if (view === "edd") {
    const dates = collectEddDates(stations, businessDate);
    const pivot = eddPivot(stations, dates);
    const headers = ["Station", ...dates.map(boardDayLabel), "Total"];
    const rows: BoardShareCell[][] = pivot.rows.map((row) => [
      { text: row.stationCode, bold: true, align: "left" },
      ...dates.map((d) => {
        const value = row.cells[d] ?? 0;
        return { text: value ? String(value) : "", bg: heatColor(value, pivot.max), align: "right" as const };
      }),
      { text: String(row.total), bold: true, bg: heatColor(row.total, Math.max(...pivot.rows.map((r) => r.total), 1)), align: "right" },
    ]);
    rows.push([
      { text: "Grand Total", bold: true, align: "left" },
      ...dates.map((d) => ({ text: String(pivot.columnTotals[d] || 0), bold: true, align: "right" as const })),
      { text: String(pivot.grandTotal), bold: true, align: "right" },
    ]);
    return { title: `EDD · ${regionLabel}`, subtitle, headers, rows, footerNote: "Ops Pulse Station board" };
  }

  if (view === "creturn") {
    const headers = ["Station", ...CRETURN_DISPLAY.map((k) => CRETURN_SHORT[k]), "Total", "Pickup %"];
    const rows: BoardShareCell[][] = stations.map((station) => [
      { text: station.stationCode, bold: true, align: "left" },
      ...CRETURN_DISPLAY.map((status) => ({
        text: station.board.cReturn[status] ? String(station.board.cReturn[status]) : "0",
        align: "right" as const,
      })),
      { text: String(station.board.cReturnTotal || 0), bold: true, align: "right" },
      { text: `${station.board.pickupDonePct}%`, bold: true, bg: pickupPctColor(station.board.pickupDonePct), align: "right" },
    ]);
    const tot = sumCReturn(stations);
    rows.push([
      { text: "Grand Total", bold: true, align: "left", bg: "#fff4bf" },
      ...CRETURN_DISPLAY.map((status) => ({
        text: String(tot.byStatus[status] ?? 0),
        bold: true,
        align: "right" as const,
        bg: "#fff4bf",
      })),
      { text: String(tot.total), bold: true, align: "right", bg: "#fff4bf" },
      { text: `${tot.pickupDonePct}%`, bold: true, bg: pickupPctColor(tot.pickupDonePct), align: "right" },
    ]);
    return { title: `C-Return · ${regionLabel}`, subtitle, headers, rows, footerNote: "Ops Pulse Station board" };
  }

  if (view === "ageing") {
    if (ageingMode === "week") {
      const weeks = collectAgeingWeeks(stations);
      const pivot = ageingStateWeekPivot(stations, weeks);
      const headers = ["State", ...pivot.columns, "Grand Total"];
      const rows: BoardShareCell[][] = pivot.rows.map((row) => [
        { text: row.state, bold: true, align: "left" },
        ...pivot.columns.map((col) => ({
          text: row.cells[col] ? inr(row.cells[col]) : "",
          align: "right" as const,
        })),
        { text: inr(row.total), bold: true, bg: heatColor(row.total, pivot.maxAmount), align: "right" },
      ]);
      rows.push([
        { text: "Grand Total", bold: true, align: "left", bg: "#fff4bf" },
        ...pivot.columns.map((col) => ({
          text: inr(pivot.columnTotals[col] ?? 0),
          bold: true,
          align: "right" as const,
          bg: "#fff4bf",
        })),
        { text: inr(pivot.grandTotal), bold: true, align: "right", bg: "#fff4bf" },
      ]);
      return { title: `Ageing · ${regionLabel}`, subtitle, headers, rows, footerNote: "Ops Pulse Station board · State × ISO week" };
    }
    const pivot = ageingPivot(stations, "day");
    const headers = ["Station", "CLM", ...AGEING_DAY_BUCKETS.flatMap((b) => [`${AGEING_DAY_LABELS[b]} #`, `${AGEING_DAY_LABELS[b]} ₹`]), "Total #", "Total ₹"];
    const rows: BoardShareCell[][] = pivot.rows.map((row) => [
      { text: row.stationCode, bold: true, align: "left" },
      { text: stationNames[row.stationCode] || "", align: "left" },
      ...AGEING_DAY_BUCKETS.flatMap((b) => [
        { text: row.cells[b]?.count ? String(row.cells[b].count) : "", align: "right" as const },
        { text: row.cells[b]?.amount ? inr(row.cells[b].amount) : "", align: "right" as const },
      ]),
      { text: String(row.total.count), bold: true, align: "right" },
      { text: inr(row.total.amount), bold: true, bg: heatColor(row.total.amount, pivot.maxAmount), align: "right" },
    ]);
    rows.push([
      { text: "Grand Total", bold: true, align: "left", bg: "#fff4bf" },
      { text: "", bold: true, align: "left", bg: "#fff4bf" },
      ...AGEING_DAY_BUCKETS.flatMap((b) => [
        { text: String(pivot.columnTotals[b]?.count || 0), bold: true, align: "right" as const, bg: "#fff4bf" },
        { text: inr(pivot.columnTotals[b]?.amount || 0), bold: true, align: "right" as const, bg: "#fff4bf" },
      ]),
      { text: String(pivot.grandTotal.count), bold: true, align: "right", bg: "#fff4bf" },
      { text: inr(pivot.grandTotal.amount), bold: true, align: "right", bg: "#fff4bf" },
    ]);
    return { title: `Ageing · ${regionLabel}`, subtitle, headers, rows, footerNote: "Ops Pulse Station board · day buckets" };
  }

  const zeroOnly = view === "zero";
  const headers = [
    "Station",
    DSR_HEADERS.da,
    DSR_HEADERS.delivered,
    DSR_HEADERS.failed,
    DSR_HEADERS.rejected,
    DSR_HEADERS.oor,
    DSR_HEADERS.total,
    DSR_HEADERS.dsrPct,
  ];
  const rows: BoardShareCell[][] = [];
  const allDas: StationBoardDaDsr[] = [];
  for (const station of stations) {
    const das = zeroOnly ? station.board.daDsr.filter((da) => da.delivered === 0) : station.board.daDsr;
    allDas.push(...das);
    for (const da of das) {
      rows.push([
        { text: station.stationCode, bold: true, align: "left" },
        { text: da.driverName || da.driverId, align: "left" },
        { text: String(da.delivered), align: "right" },
        { text: String(da.failed || 0), align: "right" },
        { text: String(da.rejected || 0), align: "right" },
        { text: String(da.oor || 0), align: "right" },
        { text: String(da.total), align: "right" },
        { text: `${da.dsrPct}%`, bold: true, bg: dsrHeatColor(da.dsrPct), align: "right" },
      ]);
    }
  }
  if (allDas.length) {
    const tot = sumDaDsr(allDas);
    rows.push([
      { text: "Grand Total", bold: true, align: "left", bg: "#fff4bf" },
      { text: `${tot.daCount} DA${tot.daCount === 1 ? "" : "s"}`, bold: true, align: "left", bg: "#fff4bf" },
      { text: String(tot.delivered), bold: true, align: "right", bg: "#fff4bf" },
      { text: String(tot.failed), bold: true, align: "right", bg: "#fff4bf" },
      { text: String(tot.rejected), bold: true, align: "right", bg: "#fff4bf" },
      { text: String(tot.oor), bold: true, align: "right", bg: "#fff4bf" },
      { text: String(tot.total), bold: true, align: "right", bg: "#fff4bf" },
      { text: `${tot.dsrPct}%`, bold: true, bg: dsrHeatColor(tot.dsrPct), align: "right" },
    ]);
  }
  return {
    title: `${zeroOnly ? "Zero deliveries" : "DA DSR"} · ${regionLabel}`,
    subtitle,
    headers,
    rows,
    footerNote: "Ops Pulse Station board",
  };
}

function buildStationShareTable(
  view: StationBoardView,
  station: StationBoardStation,
  businessDate: string,
  stationName: string,
  ageingMode: AgeingBoardMode = "week",
): BoardShareTable {
  const label = stationName && stationName !== station.stationCode
    ? `${station.stationCode} · ${stationName}`
    : station.stationCode;
  const subtitle = `${formatOpsDate(businessDate, businessDate)} · DropX Logistics`;

  if (view === "creturn") {
    const rows: BoardShareCell[][] = CRETURN_DISPLAY.map((status) => [
      { text: CRETURN_SHORT[status], align: "left" },
      { text: String(station.board.cReturn[status] ?? 0), bold: true, align: "right" },
    ]);
    rows.push(
      [{ text: "Grand Total", bold: true, align: "left" }, { text: String(station.board.cReturnTotal || 0), bold: true, align: "right" }],
      [{ text: "Pickup Done %", bold: true, align: "left", bg: pickupPctColor(station.board.pickupDonePct) }, { text: `${station.board.pickupDonePct}%`, bold: true, align: "right", bg: pickupPctColor(station.board.pickupDonePct) }],
    );
    return { title: `C-Return · ${label}`, subtitle, headers: ["Status", "Count"], rows, footerNote: "Ops Pulse Station board" };
  }

  if (view === "edd") {
    const dates = collectEddDates([station], businessDate);
    const pivot = eddPivot([station], dates);
    const row = pivot.rows[0];
    const rows: BoardShareCell[][] = dates.map((d) => [
      { text: boardDayLabel(d), align: "left" },
      { text: String(row?.cells[d] ?? 0), bold: true, bg: heatColor(row?.cells[d] ?? 0, pivot.max), align: "right" },
    ]);
    rows.push(
      [{ text: "Window total", bold: true, align: "left", bg: "#fff4bf" }, { text: String(row?.total ?? 0), bold: true, align: "right", bg: "#fff4bf" }],
      [{ text: "Full backlog", bold: true, align: "left", bg: "#fff4bf" }, { text: String(eddStationTotal(station)), bold: true, align: "right", bg: "#fff4bf" }],
    );
    return { title: `EDD · ${label}`, subtitle, headers: ["Promised date", "Packages"], rows, footerNote: "Ops Pulse Station board" };
  }

  if (view === "ageing") {
    if (ageingMode === "week") {
      const weeks = collectAgeingWeeks([station]);
      const pivot = ageingStateWeekPivot([station], weeks);
      const rows: BoardShareCell[][] = pivot.rows.map((row) => [
        { text: row.state, align: "left" },
        ...pivot.columns.map((col) => ({ text: row.cells[col] ? inr(row.cells[col]) : "", align: "right" as const })),
        { text: inr(row.total), bold: true, align: "right", bg: heatColor(row.total, pivot.maxAmount) },
      ]);
      rows.push([
        { text: "Grand Total", bold: true, align: "left", bg: "#fff4bf" },
        ...pivot.columns.map((col) => ({ text: inr(pivot.columnTotals[col] ?? 0), bold: true, align: "right" as const, bg: "#fff4bf" })),
        { text: inr(pivot.grandTotal), bold: true, align: "right", bg: "#fff4bf" },
      ]);
      return {
        title: `Ageing · ${label}`,
        subtitle,
        headers: ["State", ...pivot.columns, "Grand Total"],
        rows,
        footerNote: "Ops Pulse Station board · State × ISO week",
      };
    }
    const pivot = ageingPivot([station], "day");
    const row = pivot.rows[0];
    const rows: BoardShareCell[][] = AGEING_DAY_BUCKETS.map((b) => [
      { text: AGEING_DAY_LABELS[b], align: "left" },
      { text: String(row?.cells[b]?.count ?? 0), align: "right" },
      { text: inr(row?.cells[b]?.amount ?? 0), align: "right" },
    ]);
    rows.push([
      { text: "Grand Total", bold: true, align: "left", bg: "#fff4bf" },
      { text: String(row?.total.count ?? 0), bold: true, align: "right", bg: "#fff4bf" },
      { text: inr(row?.total.amount ?? 0), bold: true, align: "right", bg: heatColor(row?.total.amount ?? 0, pivot.maxAmount) },
    ]);
    return { title: `Ageing · ${label}`, subtitle, headers: ["Bucket", "Count", "Order amount"], rows, footerNote: "Ops Pulse Station board" };
  }

  const zeroOnly = view === "zero";
  const das = zeroOnly ? station.board.daDsr.filter((da) => da.delivered === 0) : station.board.daDsr;
  const rows: BoardShareCell[][] = das.map((da) => [
    { text: da.driverName || da.driverId, align: "left" },
    { text: String(da.delivered), align: "right" },
    { text: String(da.failed || 0), align: "right" },
    { text: String(da.rejected || 0), align: "right" },
    { text: String(da.oor || 0), align: "right" },
    { text: String(da.total), align: "right" },
    { text: `${da.dsrPct}%`, bold: true, bg: dsrHeatColor(da.dsrPct), align: "right" },
  ]);
  if (das.length) {
    const tot = sumDaDsr(das);
    rows.push([
      { text: "Grand Total", bold: true, align: "left", bg: "#fff4bf" },
      { text: String(tot.delivered), bold: true, align: "right", bg: "#fff4bf" },
      { text: String(tot.failed), bold: true, align: "right", bg: "#fff4bf" },
      { text: String(tot.rejected), bold: true, align: "right", bg: "#fff4bf" },
      { text: String(tot.oor), bold: true, align: "right", bg: "#fff4bf" },
      { text: String(tot.total), bold: true, align: "right", bg: "#fff4bf" },
      { text: `${tot.dsrPct}%`, bold: true, bg: dsrHeatColor(tot.dsrPct), align: "right" },
    ]);
  }
  return {
    title: `${zeroOnly ? "Zero deliveries" : "DA DSR"} · ${label}`,
    subtitle,
    headers: [
      DSR_HEADERS.da,
      DSR_HEADERS.delivered,
      DSR_HEADERS.failed,
      DSR_HEADERS.rejected,
      DSR_HEADERS.oor,
      DSR_HEADERS.total,
      DSR_HEADERS.dsrPct,
    ],
    rows,
    footerNote: "Ops Pulse Station board",
  };
}

export function StationBoardView({ initial, stationNames = {}, initialRegion, initialView }: Props) {
  const [payload, setPayload] = useState(initial);
  const [run, setRun] = useState<EddNetworkRunStatus | null>(initial.run);
  const [view, setView] = useState<StationBoardView>(() => asView(initialView));
  const [region, setRegion] = useState<StationBoardRegionId | "ALL">(() => asRegion(initialRegion));
  const [busy, setBusy] = useState<"refresh" | "download" | "image" | "share" | null>(null);
  const [blockBusy, setBlockBusy] = useState<Record<string, BlockBusy>>({});
  const [error, setError] = useState<string | null>(null);
  const [backfillNote, setBackfillNote] = useState("");
  const [openStation, setOpenStation] = useState<string | null>(null);
  const [tids, setTids] = useState<TidRow[] | null>(null);
  const [tidsBusy, setTidsBusy] = useState(false);
  const [tidsError, setTidsError] = useState<string | null>(null);
  const [tidMode, setTidMode] = useState<TidMode>("grouped");
  const [tidDay, setTidDay] = useState<string | null>(null);
  const [panelMode, setPanelMode] = useState<PanelMode>("card");
  const [copied, setCopied] = useState(false);
  const [stationShareBusy, setStationShareBusy] = useState<BlockBusy>(null);
  const [otherDate, setOtherDate] = useState(initial.businessDate || "");
  const [ageingMode, setAgeingMode] = useState<AgeingBoardMode>("week");
  /** Resume Refresh 7d after a proxy timeout instead of restarting from station 0. */
  const backfillCursor = useRef(0);

  const stations = useMemo(() => filterStationsByRegion(payload.stations, region), [payload.stations, region]);
  const groups = useMemo(() => groupStationsByRegion(stations), [stations]);
  const dates = useMemo(() => collectEddDates(stations, payload.businessDate), [stations, payload.businessDate]);
  const pivot = useMemo(() => eddPivot(stations, dates), [stations, dates]);
  const ageingWeeks = useMemo(() => collectAgeingWeeks(stations), [stations]);
  const ageing = useMemo(() => ageingPivot(stations, ageingMode, ageingWeeks), [stations, ageingMode, ageingWeeks]);
  /** Latest Amazon fetch across stations — not the page/API response time. */
  const fetchedAt = useMemo(() => {
    let latest: string | null = null;
    for (const row of payload.stations) {
      const at = row.fetchedAt;
      if (!at || Number.isNaN(Date.parse(at))) continue;
      if (!latest || Date.parse(at) > Date.parse(latest)) latest = at;
    }
    return latest;
  }, [payload.stations]);
  const selected = useMemo(
    () => (openStation ? stations.find((row) => row.stationCode === openStation) ?? payload.stations.find((row) => row.stationCode === openStation) ?? null : null),
    [openStation, stations, payload.stations],
  );

  const totals = useMemo(() => {
    const edd = stations.reduce((sum, row) => sum + Object.values(row.board.eddByDate).reduce((a, b) => a + b, 0), 0);
    const cReturn = stations.reduce((sum, row) => sum + row.board.cReturnTotal, 0);
    const pickup = stations.reduce((sum, row) => sum + row.board.pickupDone, 0);
    const zero = stations.reduce((sum, row) => sum + row.board.zeroDeliveries, 0);
    const das = stations.reduce((sum, row) => sum + row.board.daDsr.length, 0);
    return {
      edd,
      cReturn,
      pickupPct: cReturn > 0 ? Math.round((pickup / cReturn) * 100) : 0,
      zero,
      das,
      ready: stations.filter((row) => row.hasSnapshot).length,
    };
  }, [stations]);

  const regionLabel = region === "ALL" ? "All regions" : STATION_BOARD_REGIONS.find((r) => r.id === region)?.label ?? region;

  function goToDate(date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    // Full navigation — App Router soft nav can keep the old server payload for ?date=.
    window.location.assign(boardHref(date));
  }
  const tidGroups = useMemo(() => {
    if (!tids) return [];
    const allowed = new Set(dates);
    return groupTidsByDate(tids).filter((group) => group.date === "unknown" || allowed.has(group.date));
  }, [tids, dates]);
  const dayTids = useMemo(() => {
    if (!tids || !tidDay) return [];
    if (tidDay === "unknown") return tids.filter((row) => !/^\d{4}-\d{2}-\d{2}$/.test(row.edd));
    return tids.filter((row) => row.edd === tidDay);
  }, [tids, tidDay]);

  function syncUrl(nextView: StationBoardView, nextRegion: StationBoardRegionId | "ALL") {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("view", nextView);
    url.searchParams.set("date", payload.businessDate);
    if (nextRegion === "ALL") url.searchParams.delete("region");
    else url.searchParams.set("region", nextRegion);
    window.history.replaceState(null, "", url.toString());
  }

  function boardHref(date: string) {
    const regionQs = region === "ALL" ? "" : `&region=${region}`;
    return `/edd/board?date=${encodeURIComponent(date)}&view=${view}${regionQs}`;
  }

  async function reloadBoard() {
    const response = await fetch(`/api/ops-pulse/edd/board?date=${encodeURIComponent(payload.businessDate)}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Unable to refresh the station board.");
    const next = (await response.json()) as LoadFlashBoardNetwork;
    setPayload(next);
    setRun(next.run);
  }

  function isTimeoutMessage(message: string) {
    return /aborted due to timeout|timeout|timed out|504|524/i.test(message);
  }

  async function runBackfillLoop() {
    let startIndex = Math.max(0, backfillCursor.current);
    let guard = 0;
    let streakTimeouts = 0;
    while (guard < 200) {
      guard += 1;
      const params = new URLSearchParams({
        days: "7",
        startIndex: String(startIndex),
        date: payload.businessDate,
      });
      let response: Response;
      try {
        response = await fetch(`/api/ops-pulse/edd/board/backfill?${params}`, { method: "POST", cache: "no-store" });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Board backfill failed.";
        if (isTimeoutMessage(message) && streakTimeouts < 4) {
          streakTimeouts += 1;
          setBackfillNote(`Worker busy — retrying tick ${startIndex}…`);
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        backfillCursor.current = startIndex;
        throw err instanceof Error ? err : new Error(message);
      }
      const body = await response.json().catch(() => ({})) as { nextIndex?: number; total?: number; done?: boolean; advanced?: number; error?: string };
      if (!response.ok) {
        const message = String(body.error ?? "Board backfill failed.");
        // One station can overrun the proxy budget; retry the same index a few times.
        if (isTimeoutMessage(message) && streakTimeouts < 4) {
          streakTimeouts += 1;
          setBackfillNote(`Tick timed out — retrying ${startIndex}…`);
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        backfillCursor.current = startIndex;
        throw new Error(isTimeoutMessage(message)
          ? "Board pull timed out. Click Refresh 7d again — it resumes where it left off."
          : message);
      }
      streakTimeouts = 0;
      startIndex = Number(body.nextIndex ?? startIndex) || startIndex;
      backfillCursor.current = startIndex;
      const total = Number(body.total ?? 0) || 0;
      setBackfillNote(total ? `Pulling board data (last 7 days) · ${Math.min(startIndex, total)}/${total}` : "Pulling board data…");
      if (body.done || !body.advanced) {
        backfillCursor.current = 0;
        break;
      }
      await reloadBoard().catch(() => undefined);
    }
  }

  async function refresh() {
    setBusy("refresh");
    setError(null);
    setBackfillNote("Starting last 7 days board pull…");
    try {
      // Kick Ops Live in the background — do not block/fail Refresh 7d on its timeout.
      void fetch("/api/ops-pulse/edd/flash/network/refresh-all", { method: "POST", cache: "no-store" }).catch(() => undefined);
      await runBackfillLoop();
      await reloadBoard();
      setBackfillNote("Last 7 days board data updated.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Refresh failed.";
      setError(isTimeoutMessage(message)
        ? "Board pull timed out. Click Refresh 7d again — it resumes where it left off."
        : message);
      setBackfillNote("");
    } finally {
      setBusy(null);
    }
  }

  async function onDownload() {
    setBusy("download");
    setError(null);
    try {
      await downloadWorkbook(payload.businessDate, view, region);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed.");
    } finally {
      setBusy(null);
    }
  }

  async function shareBlock(opts: {
    key: string;
    label: string;
    blockStations: StationBoardStation[];
    share: boolean;
    scope: "all" | "block";
  }) {
    const setBusyState = (value: BlockBusy | "image" | "share" | null) => {
      if (opts.scope === "all") setBusy(value === null ? null : value);
      else setBlockBusy((prev) => ({ ...prev, [opts.key]: value }));
    };
    setBusyState(opts.share ? "share" : "image");
    setError(null);
    try {
      const table = buildShareTable(view, opts.blockStations, payload.businessDate, opts.label, stationNames, ageingMode);
      if (!table.rows.length) throw new Error("Nothing to share for this block.");
      const fileName = `station-board-${payload.businessDate}-${view}-${opts.key.toLowerCase()}`;
      if (opts.share) {
        const files = await renderBoardShareImages(table);
        const result = await shareBoardImages(files, table.title, `${table.title} · ${table.subtitle}`);
        if (result === "downloaded") await downloadBoardShare(table, fileName);
      } else {
        await downloadBoardShare(table, fileName);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the image.");
    } finally {
      setBusyState(null);
    }
  }

  async function shareStation(share: boolean) {
    if (!selected) return;
    setStationShareBusy(share ? "share" : "image");
    setError(null);
    try {
      const table = buildStationShareTable(view, selected, payload.businessDate, stationNames[selected.stationCode] || "", ageingMode);
      if (!table.rows.length) throw new Error("Nothing to share for this station.");
      const fileName = `station-board-${payload.businessDate}-${view}-${selected.stationCode.toLowerCase()}`;
      if (share) {
        const files = await renderBoardShareImages(table);
        const result = await shareBoardImages(files, table.title, `${table.title} · ${table.subtitle}`);
        if (result === "downloaded") await downloadBoardShare(table, fileName);
      } else {
        await downloadBoardShare(table, fileName);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the station image.");
    } finally {
      setStationShareBusy(null);
    }
  }

  function openStationPanel(code: string) {
    setOpenStation(code);
    setTids(null);
    setTidsError(null);
    setTidMode("grouped");
    setTidDay(null);
    setPanelMode("card");
    setCopied(false);
  }

  function closeStationPanel() {
    setOpenStation(null);
    setTids(null);
    setTidsError(null);
    setTidMode("grouped");
    setTidDay(null);
    setPanelMode("card");
    setCopied(false);
  }

  async function loadTids() {
    if (!selected) return;
    setTidsBusy(true);
    setTidsError(null);
    setTidMode("grouped");
    setTidDay(null);
    setCopied(false);
    try {
      const params = new URLSearchParams({
        station: selected.stationCode,
        date: payload.businessDate,
        kind: view,
      });
      const response = await fetch(`/api/ops-pulse/edd/board/tids?${params}`, { cache: "no-store" });
      const body = await response.json().catch(() => ({})) as { rows?: TidRow[]; error?: string };
      if (!response.ok) throw new Error(String(body.error ?? "Unable to load tracking IDs."));
      setTids(Array.isArray(body.rows) ? body.rows : []);
      setPanelMode("tids");
    } catch (err) {
      setTidsError(err instanceof Error ? err.message : "Unable to load tracking IDs.");
      setTids(null);
      setPanelMode("card");
    } finally {
      setTidsBusy(false);
    }
  }

  async function copyTids(rows: TidRow[]) {
    const text = rows.map((row) => row.trackingId).filter(Boolean).join("\n");
    if (!text) return;
    try {
      await copyText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setTidsError("Could not copy tracking IDs.");
    }
  }

  const viewTabs = [
    ["edd", "EDD"],
    ["ageing", "Ageing"],
    ["creturn", "C-Return"],
    ["dsr", "DSR"],
    ["zero", "Zero deliveries"],
  ] as const;

  function regionShareActions(groupId: string, groupLabel: string, groupStations: StationBoardStation[]) {
    const busyKey = blockBusy[groupId];
    return (
      <div className={s.regionActions}>
        <button type="button" disabled={busy !== null || Boolean(busyKey)} onClick={() => void shareBlock({ key: groupId, label: groupLabel, blockStations: groupStations, share: false, scope: "block" })}>
          {busyKey === "image" ? <Loader2 size={12} className="spin" /> : <ImageDown size={12} />} Image
        </button>
        <button type="button" disabled={busy !== null || Boolean(busyKey)} onClick={() => void shareBlock({ key: groupId, label: groupLabel, blockStations: groupStations, share: true, scope: "block" })}>
          {busyKey === "share" ? <Loader2 size={12} className="spin" /> : <Share2 size={12} />} WhatsApp
        </button>
      </div>
    );
  }

  return (
    <div className={s.board}>
      <div className={s.toolbar}>
        <div className={s.title}>
          <h2>Station board</h2>
          <p>
            {formatOpsDate(payload.businessDate, payload.businessDate)}
            {fetchedAt ? ` · fetched ${formatOpsDateTime(fetchedAt, fetchedAt)}` : ""}
            {run?.status === "running" ? " · Ops Live refresh running" : ""}
          </p>
        </div>

        <form
          className={s.otherDate}
          onSubmit={(event) => {
            event.preventDefault();
            goToDate(otherDate || payload.businessDate);
          }}
        >
          <label>
            <span>Date</span>
            <input
              type="date"
              value={otherDate || payload.businessDate}
              onChange={(e) => setOtherDate(e.target.value)}
            />
          </label>
          <button type="submit">Go</button>
        </form>

        <div className={s.segment} role="tablist" aria-label="Report">
          {viewTabs.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-pressed={view === key}
              onClick={() => {
                setView(key);
                syncUrl(key, region);
                setTids(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div className={s.segment} role="tablist" aria-label="Region">
          <button type="button" aria-pressed={region === "ALL"} onClick={() => { setRegion("ALL"); syncUrl(view, "ALL"); }}>All</button>
          {STATION_BOARD_REGIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={region === item.id}
              onClick={() => { setRegion(item.id); syncUrl(view, item.id); }}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className={s.actions}>
          <button type="button" disabled={busy !== null} onClick={() => void refresh()}>
            {busy === "refresh" ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Refresh 7d
          </button>
          <button type="button" disabled={busy !== null} onClick={() => void onDownload()}>
            {busy === "download" ? <Loader2 size={14} className="spin" /> : <Download size={14} />} Excel
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void shareBlock({ key: region, label: regionLabel, blockStations: stations, share: false, scope: "all" })}
          >
            {busy === "image" ? <Loader2 size={14} className="spin" /> : <ImageDown size={14} />} Image
          </button>
          <button
            type="button"
            className={s.primary}
            disabled={busy !== null}
            onClick={() => void shareBlock({ key: region, label: regionLabel, blockStations: stations, share: true, scope: "all" })}
          >
            {busy === "share" ? <Loader2 size={14} className="spin" /> : <Share2 size={14} />} WhatsApp
          </button>
        </div>
      </div>

      {error ? <p className={s.error}>{error}</p> : null}
      {backfillNote ? <p className={s.note}>{backfillNote}</p> : null}

      <div className={s.kpis}>
        <article className={s.kpi}><span>Stations ready</span><strong>{totals.ready}/{stations.length}</strong><small>{regionLabel}</small></article>
        <article className={s.kpi}><span>EDD packages</span><strong>{totals.edd.toLocaleString("en-IN")}</strong><small>Promised-date backlog</small></article>
        <article className={s.kpi}><span>C-Return</span><strong>{totals.cReturn.toLocaleString("en-IN")}</strong><small>{totals.pickupPct}% pickup done</small></article>
        <article className={s.kpi}><span>Zero-delivery DAs</span><strong>{totals.zero.toLocaleString("en-IN")}</strong><small>of {totals.das.toLocaleString("en-IN")} DAs</small></article>
      </div>

      {view === "edd" ? (
        <section className={s.panel}>
          <div className={s.panelHead}>
            <h3>EDD · station × promised date</h3>
            <span>Click a station for shareable detail + TIDs</span>
          </div>
          {!stations.length ? <p className={s.empty}>No stations in this region.</p> : groups.map((group) => {
            const local = eddPivot(group.stations, dates);
            return (
              <div key={group.id}>
                <div className={s.region}>
                  <span>{group.label}</span>
                  {regionShareActions(group.id, group.label, group.stations)}
                </div>
                <div className={s.scroll}>
                  <table className={`${s.table} ${s.edd}`}>
                    <thead>
                      <tr>
                        <th>Station</th>
                        {dates.map((d) => <th key={d}>{boardDayLabel(d)}</th>)}
                        <th>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {local.rows.map((row) => (
                        <tr key={row.stationCode} className={s.clickRow} onClick={() => openStationPanel(row.stationCode)}>
                          <td title={stationNames[row.stationCode] || row.stationCode}>
                            <button type="button" className={s.stationBtn} onClick={(e) => { e.stopPropagation(); openStationPanel(row.stationCode); }}>
                              {row.stationCode}
                            </button>
                          </td>
                          {dates.map((d) => {
                            const value = row.cells[d] ?? 0;
                            return (
                              <td key={d} className={value ? s.heat : s.emptyCell} style={value ? { background: heatColor(value, local.max) } : undefined}>
                                {count(value, true)}
                              </td>
                            );
                          })}
                          <td className={s.heat} style={{ background: heatColor(row.total, Math.max(...local.rows.map((r) => r.total), 1)) }}>{count(row.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td>Grand Total</td>
                        {dates.map((d) => <td key={d}>{count(local.columnTotals[d] ?? 0)}</td>)}
                        <td>{count(local.grandTotal)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            );
          })}
        </section>
      ) : null}

      {view === "ageing" ? (
        <section className={s.panel}>
          <div className={s.panelHead}>
            <h3>
              {ageingMode === "day"
                ? "Ageing · station × day buckets"
                : "Ageing · State × ISO week (Sum of Order Amount)"}
            </h3>
            <div className={s.segment} role="tablist" aria-label="Ageing type">
              <button type="button" aria-pressed={ageingMode === "day"} onClick={() => setAgeingMode("day")}>Date type</button>
              <button type="button" aria-pressed={ageingMode === "week"} onClick={() => setAgeingMode("week")}>Week type</button>
            </div>
          </div>
          {!stations.length ? <p className={s.empty}>No stations in this region.</p> : ageingMode === "week" ? groups.map((group) => {
            const local = ageingStateWeekPivot(group.stations, ageingWeeks);
            return (
              <div key={group.id}>
                <div className={s.region}>
                  <span>{group.label}</span>
                  {regionShareActions(group.id, group.label, group.stations)}
                </div>
                <div className={s.scroll}>
                  <table className={`${s.table} ${s.ageing}`}>
                    <thead>
                      <tr>
                        <th>State</th>
                        {local.columns.map((col) => <th key={col}>{col}</th>)}
                        <th>Grand Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {local.rows.map((row) => (
                        <tr key={row.state}>
                          <td className={s.clm}>{row.state}</td>
                          {local.columns.map((col) => {
                            const value = row.cells[col] ?? 0;
                            return <td key={col}>{value ? inr(value) : ""}</td>;
                          })}
                          <td className={s.heat} style={{ background: heatColor(row.total, local.maxAmount) }}>{inr(row.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td>Grand Total</td>
                        {local.columns.map((col) => <td key={col}>{inr(local.columnTotals[col] ?? 0)}</td>)}
                        <td>{inr(local.grandTotal)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            );
          }) : groups.map((group) => {
            const local = ageingPivot(group.stations, "day");
            const cols = local.columns;
            return (
              <div key={group.id}>
                <div className={s.region}>
                  <span>{group.label}</span>
                  {regionShareActions(group.id, group.label, group.stations)}
                </div>
                <div className={s.scroll}>
                  <table className={`${s.table} ${s.ageing}`}>
                    <thead>
                      <tr>
                        <th rowSpan={2}>Station</th>
                        <th rowSpan={2}>CLM</th>
                        {cols.map((col) => (
                          <th key={col} colSpan={2}>
                            {AGEING_DAY_LABELS[col as keyof typeof AGEING_DAY_LABELS] || col}
                          </th>
                        ))}
                        <th rowSpan={2}>Total Count</th>
                        <th rowSpan={2}>Total Sum</th>
                      </tr>
                      <tr>
                        {cols.flatMap((col) => [
                          <th key={`${col}-c`}>Count of Tracking ID</th>,
                          <th key={`${col}-a`}>Sum of Order Amount</th>,
                        ])}
                      </tr>
                    </thead>
                    <tbody>
                      {local.rows.map((row) => (
                        <tr key={row.stationCode} className={s.clickRow} onClick={() => openStationPanel(row.stationCode)}>
                          <td>
                            <button type="button" className={s.stationBtn} onClick={(e) => { e.stopPropagation(); openStationPanel(row.stationCode); }}>
                              {row.stationCode}
                            </button>
                          </td>
                          <td className={s.clm}>{stationNames[row.stationCode] || ""}</td>
                          {cols.flatMap((col) => {
                            const cell = row.cells[col] ?? { count: 0, amount: 0 };
                            return [
                              <td key={`${col}-c`}>{count(cell.count, true)}</td>,
                              <td key={`${col}-a`}>{cell.amount ? inr(cell.amount) : ""}</td>,
                            ];
                          })}
                          <td>{count(row.total.count)}</td>
                          <td className={s.heat} style={{ background: heatColor(row.total.amount, local.maxAmount) }}>{inr(row.total.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td>Grand Total</td>
                        <td />
                        {cols.flatMap((col) => [
                          <td key={`${col}-c`}>{count(local.columnTotals[col]?.count ?? 0)}</td>,
                          <td key={`${col}-a`}>{inr(local.columnTotals[col]?.amount ?? 0)}</td>,
                        ])}
                        <td>{count(local.grandTotal.count)}</td>
                        <td>{inr(local.grandTotal.amount)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            );
          })}
          {!ageing.grandTotal.count && stations.some((row) => row.hasSnapshot) ? (
            <p className={s.note}>If Ageing is empty, click <strong>Refresh 7d</strong> to pull portal Ageing for the selected date.</p>
          ) : null}
        </section>
      ) : null}

      {view === "creturn" ? (
        <section className={s.panel}>
          <div className={s.panelHead}>
            <h3>C-Return · station status</h3>
            <span>Click a station for shareable card + TIDs</span>
          </div>
          {!stations.length ? <p className={s.empty}>No stations in this region.</p> : groups.map((group) => {
            const tot = sumCReturn(group.stations);
            return (
            <div key={group.id}>
              <div className={s.region}>
                <span>{group.label}</span>
                {regionShareActions(group.id, group.label, group.stations)}
              </div>
              <div className={s.scroll}>
                <table className={`${s.table} ${s.creturn}`}>
                  <thead>
                    <tr>
                      <th>Station</th>
                      {CRETURN_DISPLAY.map((status) => <th key={status}>{CRETURN_SHORT[status]}</th>)}
                      <th>Total</th>
                      <th>Pickup %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.stations.map((station) => (
                      <tr key={station.stationCode} className={s.clickRow} onClick={() => openStationPanel(station.stationCode)}>
                        <td title={stationNames[station.stationCode] || station.stationCode}>
                          <button type="button" className={s.stationBtn} onClick={(e) => { e.stopPropagation(); openStationPanel(station.stationCode); }}>
                            {station.stationCode}
                          </button>
                        </td>
                        {CRETURN_DISPLAY.map((status) => {
                          const value = station.board.cReturn[status] ?? 0;
                          return <td key={status}>{count(value)}</td>;
                        })}
                        <td>{count(station.board.cReturnTotal)}</td>
                        <td className={s.heat} style={{ background: pickupPctColor(station.board.pickupDonePct) }}>{station.board.pickupDonePct}%</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>Grand Total</td>
                      {CRETURN_DISPLAY.map((status) => <td key={status}>{count(tot.byStatus[status] ?? 0)}</td>)}
                      <td>{count(tot.total)}</td>
                      <td className={s.heat} style={{ background: pickupPctColor(tot.pickupDonePct) }}>{tot.pickupDonePct}%</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
            );
          })}
        </section>
      ) : null}

      {view === "dsr" || view === "zero" ? (
        <section className={s.panel}>
          <div className={s.panelHead}>
            <h3>{view === "zero" ? "Zero deliveries · DA DSR" : "DA DSR"}</h3>
            <span>Click a station for shareable detail + TIDs</span>
          </div>
          {!stations.length ? <p className={s.empty}>No stations in this region.</p> : groups.map((group) => (
            <div key={group.id}>
              <div className={s.region}>
                <span>{group.label}</span>
                {regionShareActions(group.id, group.label, group.stations)}
              </div>
              <div className={s.scroll}>
                <table className={`${s.table} ${s.zero}`}>
                  <thead>
                    <tr>
                      <th>Station</th>
                      <th>{DSR_HEADERS.da}</th>
                      <th>{DSR_HEADERS.delivered}</th>
                      <th>{DSR_HEADERS.failed}</th>
                      <th>{DSR_HEADERS.rejected}</th>
                      <th>{DSR_HEADERS.oor}</th>
                      <th>{DSR_HEADERS.total}</th>
                      <th>{DSR_HEADERS.dsrPct}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.stations.flatMap((station) => {
                      const rows = view === "zero"
                        ? station.board.daDsr.filter((da) => da.delivered === 0)
                        : station.board.daDsr;
                      if (!rows.length) {
                        return [
                          <tr key={`${station.stationCode}-empty`} className={s.clickRow} onClick={() => openStationPanel(station.stationCode)}>
                            <td>
                              <button type="button" className={s.stationBtn} onClick={(e) => { e.stopPropagation(); openStationPanel(station.stationCode); }}>
                                {station.stationCode}
                              </button>
                            </td>
                            <td colSpan={7} className={s.muted}>{view === "zero" ? "No zero-delivery DAs" : "No DA DSR yet — Refresh 7d"}</td>
                          </tr>,
                        ];
                      }
                      return rows.map((da, index) => (
                        <tr key={`${station.stationCode}-${da.driverId}`} className={s.clickRow} onClick={() => openStationPanel(station.stationCode)}>
                          <td>
                            {index === 0 ? (
                              <button type="button" className={s.stationBtn} onClick={(e) => { e.stopPropagation(); openStationPanel(station.stationCode); }}>
                                {station.stationCode}
                              </button>
                            ) : null}
                          </td>
                          <td title={da.driverName || da.driverId}>{da.driverName || da.driverId}</td>
                          <td>{da.delivered}</td>
                          <td>{da.failed || 0}</td>
                          <td>{da.rejected || 0}</td>
                          <td>{da.oor || 0}</td>
                          <td>{da.total}</td>
                          <td className={s.heat} style={{ background: dsrHeatColor(da.dsrPct) }}>{da.dsrPct}%</td>
                        </tr>
                      ));
                    })}
                  </tbody>
                  {(() => {
                    const das = group.stations.flatMap((station) =>
                      view === "zero"
                        ? station.board.daDsr.filter((da) => da.delivered === 0)
                        : station.board.daDsr,
                    );
                    if (!das.length) return null;
                    const tot = sumDaDsr(das);
                    return (
                      <tfoot>
                        <tr>
                          <td>Grand Total</td>
                          <td>{tot.daCount} DA{tot.daCount === 1 ? "" : "s"}</td>
                          <td>{tot.delivered}</td>
                          <td>{tot.failed}</td>
                          <td>{tot.rejected}</td>
                          <td>{tot.oor}</td>
                          <td>{tot.total}</td>
                          <td className={s.heat} style={{ background: dsrHeatColor(tot.dsrPct) }}>{tot.dsrPct}%</td>
                        </tr>
                      </tfoot>
                    );
                  })()}
                </table>
              </div>
            </div>
          ))}
        </section>
      ) : null}

      {!pivot.grandTotal && view === "edd" && stations.some((row) => row.hasSnapshot) ? (
        <p className={s.note}>If cells are empty, click <strong>Refresh 7d</strong> to pull board data for the last week.</p>
      ) : null}

      {selected ? (
        <div className={s.drawerScrim} role="presentation" onClick={closeStationPanel}>
          <aside className={s.drawer} role="dialog" aria-label={`${selected.stationCode} station detail`} onClick={(e) => e.stopPropagation()}>
            <div className={s.drawerHead}>
              <div>
                <h3>{selected.stationCode}</h3>
                <p>{stationNames[selected.stationCode] || "Station"} · {boardDayLabel(payload.businessDate)}</p>
              </div>
              <button type="button" className={s.iconBtn} onClick={closeStationPanel} aria-label="Close">
                <X size={16} />
              </button>
            </div>

            <div className={s.drawerActions}>
              <button type="button" disabled={stationShareBusy !== null} onClick={() => void shareStation(false)}>
                {stationShareBusy === "image" ? <Loader2 size={14} className="spin" /> : <ImageDown size={14} />} Image
              </button>
              <button type="button" className={s.primary} disabled={stationShareBusy !== null} onClick={() => void shareStation(true)}>
                {stationShareBusy === "share" ? <Loader2 size={14} className="spin" /> : <Share2 size={14} />} WhatsApp
              </button>
              {panelMode === "tids" ? (
                <button type="button" onClick={() => setPanelMode("card")}>
                  <LayoutList size={14} /> View station card
                </button>
              ) : view !== "ageing" ? (
                <button type="button" disabled={tidsBusy} onClick={() => void loadTids()}>
                  {tidsBusy ? <Loader2 size={14} className="spin" /> : <ListOrdered size={14} />} View TIDs
                </button>
              ) : null}
            </div>

            {tidsError ? <p className={s.error}>{tidsError}</p> : null}

            {panelMode === "card" ? (
              view === "creturn" ? (
                <div className={s.shareCard}>
                  <div className={s.shareCardHead}>
                    <span>Ops Pulse · Station board</span>
                    <strong>C-Return · {selected.stationCode}{stationNames[selected.stationCode] ? ` · ${stationNames[selected.stationCode]}` : ""}</strong>
                    <small>{formatOpsDate(payload.businessDate, payload.businessDate)} · DropX Logistics</small>
                  </div>
                  <div className={s.shareCols}><span>Status</span><span>Count</span></div>
                  <div className={s.shareRows}>
                    {CRETURN_DISPLAY.map((status) => (
                      <div key={status} className={s.shareRow}>
                        <span>{CRETURN_SHORT[status]}</span>
                        <strong>{count(selected.board.cReturn[status] ?? 0)}</strong>
                      </div>
                    ))}
                    <div className={`${s.shareRow} ${s.shareTotal}`}>
                      <span>Grand Total</span>
                      <strong>{count(selected.board.cReturnTotal)}</strong>
                    </div>
                    <div className={`${s.shareRow} ${s.shareTotal}`}>
                      <span>Pickup Done %</span>
                      <strong>{selected.board.pickupDonePct}%</strong>
                    </div>
                  </div>
                </div>
              ) : view === "edd" ? (
                <div className={s.shareCard}>
                  <div className={s.shareCardHead}>
                    <span>Ops Pulse · Station board</span>
                    <strong>EDD · {selected.stationCode}{stationNames[selected.stationCode] ? ` · ${stationNames[selected.stationCode]}` : ""}</strong>
                    <small>{formatOpsDate(payload.businessDate, payload.businessDate)} · last 5 days + upcoming</small>
                  </div>
                  <div className={s.shareCols}><span>Promised date</span><span>Packages</span></div>
                  <div className={s.shareRows}>
                    {(dates.length ? dates : collectEddDates([selected], payload.businessDate)).map((d) => {
                      const value = selected.board.eddByDate[d] ?? 0;
                      const max = Math.max(...dates.map((day) => selected.board.eddByDate[day] ?? 0), 1);
                      return (
                        <div key={d} className={s.shareRow} style={value ? { background: heatColor(value, max) } : undefined}>
                          <span>{boardDayLabel(d)}</span>
                          <strong>{count(value)}</strong>
                        </div>
                      );
                    })}
                    <div className={`${s.shareRow} ${s.shareTotal}`}>
                      <span>Window total</span>
                      <strong>{count(dates.reduce((sum, d) => sum + (selected.board.eddByDate[d] ?? 0), 0))}</strong>
                    </div>
                    <div className={`${s.shareRow} ${s.shareTotal}`}>
                      <span>Full backlog</span>
                      <strong>{count(eddStationTotal(selected))}</strong>
                    </div>
                  </div>
                </div>
              ) : view === "ageing" ? (
                <div className={s.shareCard}>
                  <div className={s.shareCardHead}>
                    <span>Ops Pulse · Station board</span>
                    <strong>Ageing · {selected.stationCode}{stationNames[selected.stationCode] ? ` · ${stationNames[selected.stationCode]}` : ""}</strong>
                    <small>
                      {formatOpsDate(payload.businessDate, payload.businessDate)}
                      {ageingMode === "week" ? " · State × ISO week" : " · promised-date age"}
                    </small>
                  </div>
                  {ageingMode === "week" ? (() => {
                    const local = ageingStateWeekPivot([selected], collectAgeingWeeks([selected]));
                    const grid = `minmax(88px, 1.4fr) ${local.columns.map(() => "minmax(64px, 1fr)").join(" ")} minmax(72px, 1fr)`;
                    return (
                      <>
                        <div className={s.shareColsWide} style={{ gridTemplateColumns: grid }}>
                          <span>State</span>
                          {local.columns.map((col) => <span key={col}>{col}</span>)}
                          <span>Total</span>
                        </div>
                        <div className={s.shareRows}>
                          {local.rows.map((row) => (
                            <div key={row.state} className={s.shareRowWide} style={{ gridTemplateColumns: grid }}>
                              <span>{row.state}</span>
                              {local.columns.map((col) => <strong key={col}>{row.cells[col] ? inr(row.cells[col]) : ""}</strong>)}
                              <strong>{inr(row.total)}</strong>
                            </div>
                          ))}
                          <div className={`${s.shareRowWide} ${s.shareTotal}`} style={{ gridTemplateColumns: grid }}>
                            <span>Grand Total</span>
                            {local.columns.map((col) => <strong key={col}>{inr(local.columnTotals[col] ?? 0)}</strong>)}
                            <strong>{inr(local.grandTotal)}</strong>
                          </div>
                        </div>
                      </>
                    );
                  })() : (
                    <>
                      <div className={s.shareColsWide} style={{ gridTemplateColumns: "minmax(88px, 1.4fr) minmax(52px, 0.7fr) minmax(88px, 1fr)" }}>
                        <span>Bucket</span><span>Count</span><span>Amount</span>
                      </div>
                      <div className={s.shareRows}>
                        {AGEING_DAY_BUCKETS.map((b) => {
                          const cell = selected.board.ageingByDay?.[b] ?? { count: 0, amount: 0 };
                          return (
                            <div key={b} className={s.shareRowWide} style={{ gridTemplateColumns: "minmax(88px, 1.4fr) minmax(52px, 0.7fr) minmax(88px, 1fr)" }}>
                              <span>{AGEING_DAY_LABELS[b]}</span>
                              <strong>{count(cell.count)}</strong>
                              <strong>{inr(cell.amount)}</strong>
                            </div>
                          );
                        })}
                        {(() => {
                          const tot = ageingPivot([selected], "day").grandTotal;
                          return (
                            <div className={`${s.shareRowWide} ${s.shareTotal}`} style={{ gridTemplateColumns: "minmax(88px, 1.4fr) minmax(52px, 0.7fr) minmax(88px, 1fr)" }}>
                              <span>Grand Total</span>
                              <strong>{count(tot.count)}</strong>
                              <strong>{inr(tot.amount)}</strong>
                            </div>
                          );
                        })()}
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className={s.shareCard}>
                  <div className={s.shareCardHead}>
                    <span>Ops Pulse · Station board</span>
                    <strong>{view === "zero" ? "Zero deliveries" : "DA DSR"} · {selected.stationCode}</strong>
                    <small>{formatOpsDate(payload.businessDate, payload.businessDate)} · DropX Logistics</small>
                  </div>
                  <div className={s.shareColsWide}>
                    <span>{DSR_HEADERS.da}</span>
                    <span>{DSR_HEADERS.delivered}</span>
                    <span>{DSR_HEADERS.failed}</span>
                    <span>{DSR_HEADERS.rejected}</span>
                    <span>{DSR_HEADERS.oor}</span>
                    <span>{DSR_HEADERS.total}</span>
                    <span>{DSR_HEADERS.dsrPct}</span>
                  </div>
                  <div className={`${s.shareRows} ${s.shareRowsScroll}`}>
                    {(view === "zero" ? selected.board.daDsr.filter((da) => da.delivered === 0) : selected.board.daDsr).map((da) => (
                      <div key={da.driverId} className={s.shareRowWide}>
                        <span title={da.driverName || da.driverId}>{da.driverName || da.driverId}</span>
                        <strong>{da.delivered}</strong>
                        <strong>{da.failed || 0}</strong>
                        <strong>{da.rejected || 0}</strong>
                        <strong>{da.oor || 0}</strong>
                        <strong>{da.total}</strong>
                        <strong style={{ background: dsrHeatColor(da.dsrPct) }}>{da.dsrPct}%</strong>
                      </div>
                    ))}
                    {(() => {
                      const das = view === "zero"
                        ? selected.board.daDsr.filter((da) => da.delivered === 0)
                        : selected.board.daDsr;
                      if (!das.length) {
                        return <p className={s.empty}>{view === "zero" ? "No zero-delivery DAs" : "No DA DSR yet — Refresh 7d"}</p>;
                      }
                      const tot = sumDaDsr(das);
                      return (
                        <div className={`${s.shareRowWide} ${s.shareTotal}`}>
                          <span>Grand Total · {tot.daCount} DA{tot.daCount === 1 ? "" : "s"}</span>
                          <strong>{tot.delivered}</strong>
                          <strong>{tot.failed}</strong>
                          <strong>{tot.rejected}</strong>
                          <strong>{tot.oor}</strong>
                          <strong>{tot.total}</strong>
                          <strong style={{ background: dsrHeatColor(tot.dsrPct) }}>{tot.dsrPct}%</strong>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              )
            ) : null}

            {panelMode === "tids" && tids ? (
              <div className={s.tidBlock}>
                <div className={s.panelHead}>
                  <h3>
                    {tidMode === "day" && tidDay
                      ? `TIDs · ${tidDay === "unknown" ? "No EDD" : boardDayLabel(tidDay)} · ${dayTids.length.toLocaleString("en-IN")}`
                      : `Tracking IDs · ${tids.length.toLocaleString("en-IN")}`}
                  </h3>
                  <div className={s.tidTools}>
                    {tidMode === "day" ? (
                      <button
                        type="button"
                        onClick={() => {
                          setTidMode("grouped");
                          setTidDay(null);
                          setCopied(false);
                        }}
                      >
                        <ArrowLeft size={12} /> All dates
                      </button>
                    ) : null}
                    <button type="button" onClick={() => void copyTids(tidMode === "day" ? dayTids : tids)}>
                      {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy TIDs"}
                    </button>
                  </div>
                </div>
                {!tids.length ? (
                  <p className={s.empty}>No tracking IDs for this station yet. Try Refresh 7d.</p>
                ) : tidMode === "day" ? (
                  <div className={s.tidPlain}>
                    {dayTids.map((row) => (
                      <code key={row.trackingId}>{row.trackingId}</code>
                    ))}
                  </div>
                ) : view === "edd" ? (
                  <div className={s.tidGroups}>
                    {tidGroups.map((group) => (
                      <button
                        key={group.date}
                        type="button"
                        className={s.tidGroup}
                        onClick={() => {
                          setTidMode("day");
                          setTidDay(group.date);
                          setCopied(false);
                        }}
                      >
                        <strong>{group.label}</strong>
                        <span>{group.rows.length.toLocaleString("en-IN")} TIDs</span>
                      </button>
                    ))}
                    {!tidGroups.length ? <p className={s.empty}>No TIDs in the visible EDD window.</p> : null}
                  </div>
                ) : (
                  <div className={s.tidPlain}>
                    {tids.map((row) => (
                      <code key={row.trackingId}>{row.trackingId}{row.status ? ` · ${row.status}` : ""}</code>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </aside>
        </div>
      ) : null}
    </div>
  );
}
