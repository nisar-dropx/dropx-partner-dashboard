"use client";
import { boardRefreshStatus } from "@/lib/ops-pulse/board-refresh-status";
import { boardSourceStatus, withBoardSourceStatus } from "@/lib/ops-pulse/board-source-status";
import { RtsReport } from "./rts-report";
import { formatAgeingPerformance, boardPerformanceTarget, performanceColour, formatBoardPerformance, type BoardTargets } from "@/lib/ops-pulse/board-report-format";
import { dotStationTable } from "@/lib/ops-pulse/dot-report";
import { isDotView, sumDot, stationDotTotals, matchesDotMetric, type DotTotals } from "@/lib/ops-pulse/dot-metrics";
import { cReturnDetailTable, dsrStationTable, pendingCReturn, type CReturnAssociate, type BoardDetailLevel } from "@/lib/ops-pulse/board-detail-report";
import { ReportTable } from "@/components/report-table";


import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Bot, Check, Copy, Download, ImageDown, LayoutList, ListOrdered, Loader2, RefreshCw, Share2, Smartphone, X } from "lucide-react";
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
  daDsrForView,
  DSR_HEADERS,
  dsrHeatColor,
  dsrPctTextColor,
  oorTextColor,
  eddPivot,
  eddStationTotal,
  heatColor,
  isDsrFamilyView,
  pickupPctColor,
  pickupPctTextColor,
  sumCReturn,
  sumDaDsr,
  type AgeingBoardMode,
  type StationBoardDaDsr,
  type StationBoardStation,
  type StationBoardView,
} from "@/lib/ops-pulse/station-board";
import type { StationBoardRegionId } from "@/lib/ops-pulse/station-board-regions";
import { STATION_BOARD_REGIONS } from "@/lib/ops-pulse/station-board-regions";
import { CopyReportImage } from "@/components/copy-report-image";
import { downloadBoardShare, renderBoardShareImages, shareBoardImages, type BoardShareCell, type BoardShareTable } from "@/lib/ops-pulse/station-board-share";
import s from "./board.module.css";
import { EddScopeFilters } from "../edd-scope-filters";
import { boardDeliverySummary, filterBoardStations, prepareBoardReport, type BoardCluster, type BoardReportSort } from "@/lib/ops-pulse/compact-board-report";
import { downloadReportExcel, type ExcelReport } from "@/lib/download-report-excel";
import { TrackingDetailModal } from "@/components/tracking-detail-modal";
import { stationDsrMetricRows, stationDsrReportRows, summarizeStationDsrRows, STATION_DSR_INVENTORY_NOTE, STATION_DSR_PENDING_HEADER, STATION_DSR_PHYSICAL_HEADER, type StationDsrMetric, type StationDsrTidRow } from "@/lib/ops-pulse/station-dsr-summary";

type Props = {
  initial: LoadFlashBoardNetwork;
  targets?: BoardTargets;
  stationNames?: Record<string, string>;
  clusters?: BoardCluster[];
  initialRegion?: string;
  initialView?: string;
  initialStations?: string;
  initialClusters?: string;
  initialDetail?: string;
  initialLayout?: string;
  /** Joseph-only: show Report Bot vs device-share chooser on WhatsApp. */
  canFlashReportBot?: boolean;
};

type BlockBusy = "image" | "share" | "bot" | null;
type WhatsAppTarget =
  | { scope: "all"; key: string; label: string; blockStations: StationBoardStation[] }
  | { scope: "station"; station: StationBoardStation };
type TidMode = "grouped" | "day";
type PanelMode = "card" | "tids";

type TidRow = {
  stationCode?: string;
  trackingId: string;
  status: string;
  currentState?: string;
  dotDispatched?: boolean;
  dotAtStation?: boolean;
  sourceBucket?: string;
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
  if (key === "dot" || key === "rts") return key;
  if (key === "swa") return "swa";
  if (key === "creturn") return "creturn";
  if (key === "dsr" || key === "dadsr") return "dsr";
  if (key === "zero" || key === "zerodeliveries") return "zero";
  if (key === "ageing" || key === "aging") return "ageing";
  if (key === "premium" || key === "premiumdot") return "premium";
  if (key === "standard" || key === "standarddot") return "standard";
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


function buildShareTable(
  view: StationBoardView,
  stations: StationBoardStation[],
  businessDate: string,
  regionLabel: string,
  stationNames: Record<string, string> = {},
  ageingMode: AgeingBoardMode = "week",
  dsrTarget = 94,
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

  if (view === "ageing") {
    if (ageingMode === "week") {
      const weeks = collectAgeingWeeks(stations);
      const pivot = ageingStateWeekPivot(stations, weeks);
      const headers = ["State", ...pivot.columns.flatMap((col) => [`${col} #`, `${col} ₹`]), "Total #", "Total ₹"];
      const rows: BoardShareCell[][] = pivot.rows.map((row) => [
        { text: row.state, bold: true, align: "left" },
        ...pivot.columns.flatMap((col) => [
          { text: row.cells[col]?.count ? String(row.cells[col].count) : "", align: "right" as const },
          { text: row.cells[col]?.amount ? inr(row.cells[col].amount) : "", align: "right" as const },
        ]),
        { text: String(row.total.count), bold: true, align: "right" },
        { text: inr(row.total.amount), bold: true, bg: heatColor(row.total.amount, pivot.maxAmount), align: "right" },
      ]);
      rows.push([
        { text: "Grand Total", bold: true, align: "left", bg: "#edf2f8" },
        ...pivot.columns.flatMap((col) => [
          { text: String(pivot.columnTotals[col]?.count || 0), bold: true, align: "right" as const, bg: "#edf2f8" },
          { text: inr(pivot.columnTotals[col]?.amount || 0), bold: true, align: "right" as const, bg: "#edf2f8" },
        ]),
        { text: String(pivot.grandTotal.count), bold: true, align: "right", bg: "#edf2f8" },
        { text: inr(pivot.grandTotal.amount), bold: true, align: "right", bg: "#edf2f8" },
      ]);
      return { title: `Ageing · ${regionLabel}`, subtitle, headers, rows, footerNote: "Ops Pulse Station board · State × ISO week" };
    }
    const pivot = ageingPivot(stations, "day");
    const headers = ["Station", "Location", ...AGEING_DAY_BUCKETS.flatMap((b) => [`${AGEING_DAY_LABELS[b]} #`, `${AGEING_DAY_LABELS[b]} ₹`]), "Total #", "Total ₹"];
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
      { text: "Grand Total", bold: true, align: "left", bg: "#edf2f8" },
      { text: "", bold: true, align: "left", bg: "#edf2f8" },
      ...AGEING_DAY_BUCKETS.flatMap((b) => [
        { text: String(pivot.columnTotals[b]?.count || 0), bold: true, align: "right" as const, bg: "#edf2f8" },
        { text: inr(pivot.columnTotals[b]?.amount || 0), bold: true, align: "right" as const, bg: "#edf2f8" },
      ]),
      { text: String(pivot.grandTotal.count), bold: true, align: "right", bg: "#edf2f8" },
      { text: inr(pivot.grandTotal.amount), bold: true, align: "right", bg: "#edf2f8" },
    ]);
    return { title: `Ageing · ${regionLabel}`, subtitle, headers, rows, footerNote: "Ops Pulse Station board · day buckets" };
  }

  const zeroOnly = view === "zero";
  const dsrTitle =
    view === "premium" ? "Premium DOT"
      : view === "standard" ? "Standard DOT"
        : view === "swa" ? "SWA DSR" : zeroOnly ? "Zero deliveries"
          : "DSR";
  const hasOther = stations.some((s) => daDsrForView(s.board, view).some((d) => (d.other || 0) > 0));
  const headers = [
    "Station",
    DSR_HEADERS.da,
    DSR_HEADERS.delivered,
    DSR_HEADERS.failed,
    DSR_HEADERS.rejected,
    DSR_HEADERS.oor,
    DSR_HEADERS.total,
    ...(hasOther ? ["Outcome missing"] : []),
    DSR_HEADERS.dsrPct,
  ];
  const rows: BoardShareCell[][] = [];
  const allDas: StationBoardDaDsr[] = [];
  for (const station of stations) {
    const das = daDsrForView(station.board, view);
    allDas.push(...das);
    for (const da of das) {
      rows.push([
        { text: station.stationCode, bold: true, align: "left" },
        { text: da.driverName || da.driverId, align: "left" },
        { text: String(da.delivered), align: "right" },
        { text: String(da.failed || 0), align: "right" },
        { text: String(da.rejected || 0), align: "right" },
        { text: String(da.oor || 0), color: oorTextColor(da.oor, da.total, station.fetchedAt), bold: !!oorTextColor(da.oor, da.total, station.fetchedAt), align: "right" },
        { text: String(da.total), align: "right" },
        ...(hasOther ? [{ text: String(da.other || 0), align: "right" as const }] : []),
        { text: da.total ? `${da.dsrPct.toFixed(2)}%` : "—", bold: true, bg: da.total ? dsrHeatColor(da.dsrPct) : undefined, color: da.total ? dsrPctTextColor(da.dsrPct) : undefined, align: "right" },
      ]);
    }
  }
  if (allDas.length) {
    const tot = sumDaDsr(allDas);
    rows.push([
      { text: "Grand Total", bold: true, align: "left", bg: "#edf2f8" },
      { text: `${tot.daCount} DA${tot.daCount === 1 ? "" : "s"}`, bold: true, align: "left", bg: "#edf2f8" },
      { text: String(tot.delivered), bold: true, align: "right", bg: "#edf2f8" },
      { text: String(tot.failed), bold: true, align: "right", bg: "#edf2f8" },
      { text: String(tot.rejected), bold: true, align: "right", bg: "#edf2f8" },
      { text: String(tot.oor), bold: true, align: "right", bg: "#edf2f8" },
      { text: String(tot.total), bold: true, align: "right", bg: "#edf2f8" },
      ...(hasOther ? [{ text: String(tot.other || 0), align: "right" as const, bold: true }] : []),
      { text: `${tot.dsrPct.toFixed(2)}%`, bold: true, bg: dsrHeatColor(tot.dsrPct), color: dsrPctTextColor(tot.dsrPct), align: "right" },
    ]);
  }
  return {
    title: `${dsrTitle} · ${regionLabel}`,
    subtitle,
    headers,
    rows,
    footerNote: "Ops Pulse Station board",
  };
}

export function StationBoardView({ initial, stationNames = {}, clusters = [], initialRegion, initialView, initialStations, initialClusters, initialDetail, initialLayout, targets = {}, canFlashReportBot = false }: Props) {
  const [payload, setPayload] = useState(initial);
  const [run, setRun] = useState<EddNetworkRunStatus | null>(initial.run);
  const [view, setView] = useState<StationBoardView>(() => asView(initialView));
  const [regions, setRegions] = useState<Set<string>>(() => new Set((initialRegion || "").split(",").map(asRegion).filter(region => region !== "ALL")));
  const [stationFilter, setStationFilter] = useState<Set<string>>(() => new Set((initialStations || "").split(",").filter(Boolean)));
  const [clusterFilter, setClusterFilter] = useState<Set<string>>(() => new Set((initialClusters || "").split(",").filter(Boolean)));
  const [sorts, setSorts] = useState<Record<string, BoardReportSort>>({});
  const [levels, setLevels] = useState<Record<string, BoardDetailLevel>>(() => initialDetail === "station" || initialDetail === "associate" ? { [asView(initialView)]: initialDetail } : {});
  // DSR is primarily a station operating report. Open the auditable station
  // inventory view first; associate detail remains one click away.
  const level = levels[view] ?? (view === "creturn" || view === "dsr" || view === "swa" || isDotView(view) ? "station" : "associate");
  const [groupByStation, setGroupByStation] = useState(initialLayout === "grouped");
  const hasDetailViews = view === "creturn" || isDsrFamilyView(view);
  const sortKey = `${view}-${level}-${groupByStation}`;
  const sort = sorts[sortKey] ?? {
    header: isDotView(view) ? "DOT%" : view === "creturn" ? "Pending pickup"
      : view === "zero" ? DSR_HEADERS.oor
        : isDsrFamilyView(view) ? DSR_HEADERS.dsrPct
          : view === "ageing" ? "Total ₹" : "Station",
    direction: hasDetailViews || isDotView(view) || view === "ageing" ? "desc" : "asc",
  };
  const [cReturnData, setCReturnData] = useState<{ key: string; rows: CReturnAssociate[]; error?: string } | null>(null);
  const [detailRetry, setDetailRetry] = useState(0);
  const [dsrStationData, setDsrStationData] = useState<{ key: string; rows: StationDsrTidRow[]; error?: string } | null>(null);
  const [dsrStationRetry, setDsrStationRetry] = useState(0);
  const [busy, setBusy] = useState<"refresh" | "download" | "image" | "share" | "bot" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [whatsAppTarget, setWhatsAppTarget] = useState<WhatsAppTarget | null>(null);
  const [backfillNote, setBackfillNote] = useState("");
  const [backfillProgress, setBackfillProgress] = useState<{ done: number; total: number } | null>(null);
  const [openStation, setOpenStation] = useState<string | null>(null);
  const [tids, setTids] = useState<TidRow[] | null>(null);
  const [tidsBusy, setTidsBusy] = useState(false);
  const [tidsError, setTidsError] = useState<string | null>(null);
  const [tidMode, setTidMode] = useState<TidMode>("grouped");
  const [tidDay, setTidDay] = useState<string | null>(null);
  const [panelMode, setPanelMode] = useState<PanelMode>("card");
  const [copied, setCopied] = useState(false);
  const [tidLabel, setTidLabel] = useState("Tracking IDs");
  const [openTrackingId, setOpenTrackingId] = useState<string | null>(null);
  const [stationShareBusy, setStationShareBusy] = useState<BlockBusy>(null);
  const [otherDate, setOtherDate] = useState(initial.businessDate || "");
  const [ageingMode, setAgeingMode] = useState<AgeingBoardMode>("day");

  const stations = useMemo(() => filterBoardStations(payload.stations, {
    stations: [...stationFilter], clusters: [...clusterFilter], regions: [...regions],
  }, clusters), [payload.stations, stationFilter, clusterFilter, regions, clusters]);
  const dates = useMemo(() => collectEddDates(stations, payload.businessDate), [stations, payload.businessDate]);
  const pivot = useMemo(() => eddPivot(stations, dates), [stations, dates]);
  const ageingWeeks = useMemo(() => collectAgeingWeeks(stations), [stations]);
  const ageing = useMemo(() => ageingPivot(stations, ageingMode, ageingWeeks), [stations, ageingMode, ageingWeeks]);
  /** When Refresh began — falls back to earliest station save if meta missing. */
  const refreshStartedAt = useMemo(() => {
    const fromMeta = payload.refreshStartedAt;
    if (fromMeta && !Number.isNaN(Date.parse(fromMeta))) return fromMeta;
    let earliest: string | null = null;
    for (const row of payload.stations) {
      const at = row.fetchedAt;
      if (!at || Number.isNaN(Date.parse(at))) continue;
      if (!earliest || Date.parse(at) < Date.parse(earliest)) earliest = at;
    }
    return earliest;
  }, [payload.refreshStartedAt, payload.stations]);
  const selected = useMemo(
    () => (openStation ? stations.find((row) => row.stationCode === openStation) ?? payload.stations.find((row) => row.stationCode === openStation) ?? null : null),
    [openStation, stations, payload.stations],
  );

  const totals = useMemo(() => {
    const edd = stations.reduce((sum, row) => sum + Object.values(row.board.eddByDate).reduce((a, b) => a + b, 0), 0);
    const cReturn = stations.reduce((sum, row) => sum + row.board.cReturnTotal, 0);
    const pickup = stations.reduce((sum, row) => sum + row.board.pickupDone, 0);
    const zero = stations.flatMap(row => daDsrForView(row.board, view)).filter(da => da.total > 0 && da.delivered === 0).length;
    const das = stations.reduce((sum, row) => sum + daDsrForView(row.board, view).length, 0);
    return {
      edd,
      cReturn,
      pickupPct: cReturn > 0 ? (pickup / cReturn) * 100 : 0,
      zero,
      das,
      ready: stations.filter((row) => row.hasSnapshot).length,
    };
  }, [stations, view]);

  const regionLabel = regions.size ? STATION_BOARD_REGIONS.filter(r => regions.has(r.id)).map(r => r.label).join(" / ") : "All regions";
  const delivery = useMemo(() => boardDeliverySummary(stations, view === "zero", board => daDsrForView(board, view)), [stations, view]);
  const pct = (value: number | null) => value == null ? "—" : `${value.toFixed(2)}%`;
  const reportTime = stations.map(row => row.fetchedAt).filter((at): at is string => !!at).sort().at(-1) || payload.asOf;
  const singleStation = stations.length === 1;
  const cReturnKey = JSON.stringify([payload.businessDate, stations.map(s => [s.stationCode, s.fetchedAt, s.board.historyUpdatedAt, s.board.stationInventoryVersion])]);
  const needsCReturn = view === "creturn" && level === "associate";
  const detailPending = needsCReturn && cReturnData?.key !== cReturnKey;
  const detailError = needsCReturn && cReturnData?.key === cReturnKey ? cReturnData.error : undefined;
  const detailUnavailable = detailPending || !!detailError;
  const cReturnRows = cReturnData?.key === cReturnKey && !cReturnData.error ? cReturnData.rows : [];
  useEffect(() => {
    if (!needsCReturn) return;
    const controller = new AbortController();
    const [date, stationSnapshots] = JSON.parse(cReturnKey) as [string, [string, string | null][]];
    const codes = stationSnapshots.map(([code]) => code);
    if (!codes.length) { setCReturnData({ key: cReturnKey, rows: [] }); return; }
    const params = new URLSearchParams({ date, kind: "creturn", stations: codes.join(","), detail: "associate" });
    void (async () => {
      try {
        const response = await fetch(`/api/ops-pulse/edd/board/tids?${params}`, { cache: "no-store", signal: controller.signal });
        const body = await response.json();
        if (!response.ok || !Array.isArray(body.associates)) throw new Error(body.error || "Unable to load C-Return associates.");
        if (!controller.signal.aborted) setCReturnData({ key: cReturnKey, rows: body.associates });
      } catch (error) {
        if (!controller.signal.aborted) setCReturnData({ key: cReturnKey, rows: [], error: error instanceof Error ? error.message : "Unable to load C-Return associates." });
      }
    })();
    return () => controller.abort();
  }, [needsCReturn, cReturnKey, detailRetry]);
  const needsDsrStation = view === "dsr" && level === "station";
  const dsrStationKey = JSON.stringify([payload.businessDate, stations.map(s => [s.stationCode, s.fetchedAt, s.board.historyUpdatedAt, s.board.stationInventoryVersion])]);
  const dsrStationPending = needsDsrStation && dsrStationData?.key !== dsrStationKey;
  const dsrStationError = needsDsrStation && dsrStationData?.key === dsrStationKey ? dsrStationData.error : undefined;
  const dsrStationRows = dsrStationData?.key === dsrStationKey && !dsrStationData.error ? dsrStationData.rows : [];
  const dsrStationInventory = useMemo(() => {
    if (dsrStationData?.key !== dsrStationKey || dsrStationData.error) return {};
    const verified = new Set(stations.filter(station => station.hasSnapshot && station.board.stationInventoryVersion === 2).map(station => station.stationCode));
    return summarizeStationDsrRows(dsrStationData.rows.filter(row => verified.has(row.stationCode)), payload.businessDate, [...verified]);
  }, [dsrStationData, dsrStationKey, payload.businessDate, stations]);
  useEffect(() => {
    if (!needsDsrStation) return;
    const controller = new AbortController();
    const [date, stationSnapshots] = JSON.parse(dsrStationKey) as [string, [string, string | null][]];
    const codes = stationSnapshots.map(([code]) => code);
    if (!codes.length) { setDsrStationData({ key: dsrStationKey, rows: [] }); return; }
    const params = new URLSearchParams({ date, kind: "dsr-station", stations: codes.join(",") });
    void (async () => {
      try {
        const response = await fetch(`/api/ops-pulse/edd/board/tids?${params}`, { cache: "no-store", signal: controller.signal });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !Array.isArray(body.rows)) throw new Error(body.error || "Unable to load station EDD and physical inventory.");
        if (!controller.signal.aborted) setDsrStationData({ key: dsrStationKey, rows: body.rows });
      } catch (error) {
        if (!controller.signal.aborted) setDsrStationData({ key: dsrStationKey, rows: [], error: error instanceof Error ? error.message : "Unable to load station EDD and physical inventory." });
      }
    })();
    return () => controller.abort();
  }, [needsDsrStation, dsrStationKey, dsrStationRetry]);
  const cReturnShown = needsCReturn
    ? cReturnRows.reduce((a, r) => ({ total: a.total + r.total, picked: a.picked + (r.statuses.PICKUP_DONE || 0), pending: a.pending + pendingCReturn(r.statuses, r.total) }), { total: 0, picked: 0, pending: 0 })
    : stations.reduce((a, r) => ({ total: a.total + r.board.cReturnTotal, picked: a.picked + r.board.pickupDone, pending: a.pending + pendingCReturn(r.board.cReturn, r.board.cReturnTotal) }), { total: 0, picked: 0, pending: 0 });
  const dotValues = stations.map(station => stationDotTotals(station.board,view));
  const dotUnavailable = isDotView(view) && dotValues.some(value => !value);
  const dotMetadataPending = stations.reduce((n, station) => n + (station.board.dotMetadataPending || 0), 0);
  const dotSummary = sumDot(dotValues.filter((value): value is DotTotals => Boolean(value)));
  const performanceTarget = boardPerformanceTarget(view, targets, {
    premium: stations.reduce((n,s)=>n+(s.board.dotPremium?.total||0),0),
    standard: stations.reduce((n,s)=>n+(s.board.dotStandard?.total||0),0),
  });
  const metricStyle = (value: number | null) => value == null ? undefined : (() => {
    const colour = performanceColour(value, performanceTarget);
    return { backgroundColor: colour.bg, color: colour.color, borderRadius: 3, padding: '0 4px' };
  })();
  function targetForRow(row: {text:string}[]) {
    if(view !== 'dot') return performanceTarget;
    if(targets.premium == null || targets.standard == null) return undefined;
    const selected=row[0]?.text === 'Grand Total' ? stations : stations.filter(s=>s.stationCode === row[0]?.text);
    const premium=selected.reduce((n,s)=>n+(s.board.dotPremium?.total||0),0);
    const standard=selected.reduce((n,s)=>n+(s.board.dotStandard?.total||0),0);
    return premium+standard ? (premium*targets.premium+standard*targets.standard)/(premium+standard) : undefined;
  }
  function reportFor(blockStations: StationBoardStation[], label: string) {
    const dsrTitle =
      view === "premium" ? "Premium DOT"
        : view === "standard" ? "Standard DOT"
          : view === "swa" ? "SWA DSR" : view === "zero" ? "Zero deliveries"
            : "DSR";
    const sourceTable = isDotView(view) ? dotStationTable(blockStations, view as "dot" | "premium" | "standard") : view === "creturn" ? cReturnDetailTable(blockStations, cReturnRows, level, stationNames)
      : isDsrFamilyView(view) && level === "station"
        ? dsrStationTable(
          blockStations,
          stationNames,
          view === "zero",
          view === "dsr" ? dsrStationInventory : undefined,
          (board) => daDsrForView(board, view),
          dsrTitle,
        )
      : buildShareTable(view, blockStations, payload.businessDate, label, stationNames, ageingMode);
    const table = withBoardSourceStatus(sourceTable, blockStations);
    const d = boardDeliverySummary(blockStations, view === "zero", board => daDsrForView(board, view));
    const stats = isDsrFamilyView(view)
      ? ` · DSR ${pct(d.dsrPct)} (${count(d.delivered)}) · Delivery failed ${count(d.failed)} · Rejected ${count(d.rejected)}`
      : "";
    const historyPending = (isDsrFamilyView(view) || isDotView(view)) ? blockStations.reduce((n, station) => n + (station.board.dsrHistoryPending || 0), 0) : 0;
    const metadataPending = isDotView(view) ? blockStations.reduce((n, station) => n + (station.board.dotMetadataPending || 0), 0) : 0;
    return prepareBoardReport({ ...(view === "ageing" ? formatAgeingPerformance(table) : formatBoardPerformance(table, performanceTarget, targetForRow)),
      compactNote: isDotView(view) ? "DOT = delivered / eligible. EDD equals selected date; at-station stock includes returned parcels." : view === "dsr" && level === "station" ? `${formatOpsDate(payload.businessDate, payload.businessDate)} · Pending = never dispatched/attempted; included in physical stock.` : undefined,
      title: `${table.title}${blockStations.length === 1 ? ` · ${blockStations[0].stationCode}` : ""}${historyPending || metadataPending ? ` · Provisional (${[historyPending ? `${count(historyPending)} history checks pending` : "", metadataPending ? `${count(metadataPending)} data pending` : ""].filter(Boolean).join(" · ")})` : ""}`,
      subtitle: `${table.subtitle || `${formatOpsDate(payload.businessDate, payload.businessDate)} · ${label}`} · Updated ${formatOpsDateTime(reportTime, reportTime)}${stats}${view === "dsr" && level === "station" ? ` · ${STATION_DSR_INVENTORY_NOTE}` : ""}`,
    }, sort, { dsr: level === "associate" && isDsrFamilyView(view), singleStation: level === "associate" && view !== "zero" && blockStations.length === 1, groupByStation: hasDetailViews && level === "associate" && groupByStation });
  }
  const report = reportFor(stations, regionLabel);
  const outputUnavailable = dotUnavailable || detailUnavailable || dsrStationPending || Boolean(dsrStationError);
  function excelReport(table = report, tidSheet?: ExcelReport["extraSheets"]): ExcelReport {
    if (dotUnavailable) throw new Error("DOT eligible inventory was not captured for every selected station. Refresh today or select a captured date.");
    if (detailUnavailable) throw new Error("Wait for associate details to load, then retry.");
    if (dsrStationPending) throw new Error("Wait for station EDD and physical inventory to load, then retry.");
    if (dsrStationError) throw new Error(dsrStationError);
    return {
      title: table.title,
      headers: table.headers,
      rows: table.rows.map((row) => row.map((cell) => cell.text)),
      scope: table.subtitle,
      extraSheets: tidSheet,
      cellStyles: table.rows,
      colourRules: table.headers.flatMap((h,column)=>/^(DSR\s*%|DOT\s*%|Pickup\s*%)$/i.test(h) ? table.rows.flatMap((cells,row)=>{const target=targetForRow(cells);return target == null || !cells[column].text.includes('%') ? [] : [{column,row,target}];}) : []),
    };
  }

  async function fetchTidExcelSheet(stationCodes: string[]): Promise<NonNullable<ExcelReport["extraSheets"]>> {
    const codes = [...new Set(stationCodes.map((code) => code.trim().toUpperCase()).filter(Boolean))];
    if (!codes.length) {
      return [{ name: "All TIDs", headers: ["Station", "Report", "Tracking ID", "Status", "EDD", "DA ID", "DA Name"], rows: [] }];
    }
    const params = new URLSearchParams({
      date: payload.businessDate,
      kind: view === "dsr" && level === "station" ? "dsr-station" : view,
      stations: codes.join(","),
    });
    const response = await fetch(`/api/ops-pulse/edd/board/tids?${params}`, { cache: "no-store" });
    const body = (await response.json().catch(() => ({}))) as {
      rows?: Array<{
        stationCode?: string;
        trackingId?: string;
        status?: string;
        currentState?: string;
        dotDispatched?: boolean;
        dotAtStation?: boolean;
        sourceBucket?: string;
        edd?: string;
        driverId?: string;
        driverName?: string;
      }>;
      error?: string;
    };
    if (!response.ok) throw new Error(String(body.error ?? "Unable to load tracking IDs for Excel."));
    const reportLabel =
      view === "creturn" ? "C-Return"
        : view === "ageing" ? "Ageing"
          : view === "dsr" ? "DA DSR"
            : view === "swa" ? "SWA DSR" : view === "zero" ? "Zero deliveries"
              : view === "premium" ? "Premium DOT"
                : view === "standard" ? "Standard DOT"
                  : "EDD";
    const stationReport = view === "dsr" && level === "station";
    const rawRows = (Array.isArray(body.rows) ? body.rows : []);
    const exportRows = stationReport ? stationDsrReportRows(rawRows.map(row => ({
      ...row, stationCode: String(row.stationCode || "").toUpperCase(), trackingId: String(row.trackingId || "").trim(),
      sourceBucket: String(row.sourceBucket || ""), status: String(row.status || ""), edd: String(row.edd || ""),
      driverId: String(row.driverId || ""), driverName: String(row.driverName || ""),
    })), payload.businessDate) : rawRows;
    const rows = exportRows
      .map((row) => [
        String(row.stationCode ?? "").toUpperCase(),
        stationReport ? "DSR station" : reportLabel,
        String(row.trackingId ?? "").trim(),
        String(row.status ?? ""),
        String(row.edd ?? ""),
        String((row as { shipOption?: string }).shipOption ?? ""),
        String(row.driverId ?? ""),
        String(row.driverName ?? ""),
        ...(isDotView(view) ? [String(row.currentState || ""), Boolean((row as TidRow).dotDispatched), Boolean((row as TidRow).dotAtStation)] : []),
        ...(stationReport ? [String(row.currentState || ""), Boolean((row as { eddPending?: boolean }).eddPending), Boolean((row as { physicalAtStation?: boolean }).physicalAtStation), String((row as { dsrOutcome?: string }).dsrOutcome || "")] : []),
      ] as (string | number | boolean | null)[])
      .filter((row) => String(row[2] ?? "").trim());
    rows.sort((a, b) =>
      String(a[0]).localeCompare(String(b[0]))
      || String(a[4]).localeCompare(String(b[4]))
      || String(a[2]).localeCompare(String(b[2])),
    );
    return [{
      name: "All TIDs",
      headers: ["Station", "Report", "Tracking ID", "Status", "EDD", "Ship Option", "DA ID", "DA Name", ...(isDotView(view) ? ["Current Amazon state", "Dispatched today", "Currently at station"] : []), ...(stationReport ? ["Current Amazon state", "EDD pending today", "Physical at station", "DSR outcome"] : [])],
      rows,
    }];
  }

  function changeView(next: StationBoardView) { setView(next); setTids(null); }
  useEffect(() => { syncUrl(view); }, [view, level, groupByStation, stationFilter, clusterFilter, regions, payload.businessDate]);


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

  function syncUrl(nextView: StationBoardView) {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("view", nextView);
    url.searchParams.set("date", payload.businessDate);
    url.searchParams.set("detail", level);
    url.searchParams.set("layout", groupByStation ? "grouped" : "combined");
    for (const [key, values] of [["region", regions], ["stations", stationFilter], ["clusters", clusterFilter]] as const) {
      if (values.size) url.searchParams.set(key, [...values].join(","));
      else url.searchParams.delete(key);
    }
    window.history.replaceState(null, "", url.toString());
  }

  function boardHref(date: string) {
    const params = new URLSearchParams({ date, view, detail: level, layout: groupByStation ? "grouped" : "combined" });
    for (const [key, values] of [["region", regions], ["stations", stationFilter], ["clusters", clusterFilter]] as const) {
      if (values.size) params.set(key, [...values].join(","));
    }
    return `/edd/board?${params}`;
  }

  async function refresh() {
    const selectedCodes = stations.map(row => row.stationCode);
    if (!selectedCodes.length) return;
    setBusy("refresh");
    setError(null);
    try {
      const response = await fetch('/api/ops-pulse/edd/board/refresh', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stations: selectedCodes }), signal: AbortSignal.timeout(25_000),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to queue refresh.');
      setRun(body.run);
      setBackfillNote('Refresh queued · continuing in background');
      setBackfillProgress(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to queue refresh.');
    } finally { setBusy(null); }
  }

  // Passive polling never locks the report, downloads, or sharing controls.
  useEffect(() => {
    let cancelled = false;
    let polling = false;
    let failures = 0;
    const controller = new AbortController();
    async function poll() {
      if (cancelled || polling) return;
      polling = true;
      try {
        const response = await fetch('/api/ops-pulse/edd/board?date=' + encodeURIComponent(payload.businessDate), {
          cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]),
        });
        if (!response.ok) throw new Error('Refresh status unavailable');
        const next = await response.json() as LoadFlashBoardNetwork;
        if (cancelled) return;
        failures = 0;
        setPayload(next);
        setRun(next.run);
        setBackfillNote(boardRefreshStatus(next));
        setBackfillProgress(next.refreshRunning && next.refreshTotal
          ? { done: next.refreshDone || 0, total: next.refreshTotal } : null);
      } catch {
        if (!cancelled && ++failures >= 3) setBackfillNote('Refresh status unavailable · showing the last saved data. Reconnecting…');
      } finally { polling = false; }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 15_000);
    return () => { cancelled = true; controller.abort(); window.clearInterval(timer); };
  }, [payload.businessDate]);

  async function onDownload() {
    setBusy("download");
    setError(null);
    try {
      const tidSheet = await fetchTidExcelSheet(stations.map((row) => row.stationCode));
      await downloadReportExcel(excelReport(report, tidSheet));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed.");
    } finally {
      setBusy(null);
    }
  }

  async function downloadStationExcel() {
    if (!selected) return;
    setError(null);
    try {
      const tidSheet = await fetchTidExcelSheet([selected.stationCode]);
      await downloadReportExcel(excelReport(reportFor([selected], selected.stationCode), tidSheet));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Excel download failed. Retry.");
    }
  }

  function requestWhatsAppShare(target: WhatsAppTarget) {
    if (canFlashReportBot) {
      setWhatsAppTarget(target);
      return;
    }
    if (target.scope === "station") void shareStation(true, target.station);
    else void shareBlock({ key: target.key, label: target.label, blockStations: target.blockStations, share: true, scope: "all" });
  }

  /** JPEG keeps multi-page board flashes under the portal upload limit. */
  async function compressBoardFilesForBot(files: File[]): Promise<File[]> {
    const out: File[] = [];
    for (const [index, file] of files.entries()) {
      if (file.type === "image/jpeg" && file.size <= 2.8 * 1024 * 1024) {
        out.push(file);
        continue;
      }
      try {
        const bitmap = await createImageBitmap(file);
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          bitmap.close();
          out.push(file);
          continue;
        }
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
        if (!blob) {
          out.push(file);
          continue;
        }
        out.push(new File([blob], `station-board-${index + 1}.jpg`, { type: "image/jpeg" }));
      } catch {
        out.push(file);
      }
    }
    return out;
  }

  async function flashReportBot(target: WhatsAppTarget) {
    const setBusyState = (value: BlockBusy) => {
      if (target.scope === "all") setBusy(value === null ? null : value);
      else setStationShareBusy(value);
    };
    setBusyState("bot");
    setError(null);
    setWhatsAppTarget(null);
    try {
      const blockStations = target.scope === "station" ? [target.station] : target.blockStations;
      const label = target.scope === "station"
        ? (stationNames[target.station.stationCode] || target.station.stationCode)
        : target.label;
      const table = reportFor(blockStations, label);
      if (!table.rows.length) throw new Error("Nothing to flash for this selection.");
      const rendered = await renderBoardShareImages(table);
      if (!rendered.length) throw new Error("Could not render board images.");
      const files = await compressBoardFilesForBot(rendered);
      // One page per request keeps each upload under Vercel's body limit.
      let sent = 0;
      let groupName = "Testing";
      for (let index = 0; index < files.length; index += 1) {
        const form = new FormData();
        form.set("title", table.title);
        form.set("subtitle", table.subtitle);
        form.set("view", view);
        form.set("businessDate", payload.businessDate);
        form.set("stationCount", String(blockStations.length));
        form.set("page", String(index + 1));
        form.set("pages", String(files.length));
        form.set("skipCaption", index === 0 ? "0" : "1");
        form.append("images", files[index], files[index].name || `board-${index + 1}.jpg`);
        const response = await fetch("/api/ops-pulse/edd/board/flash-report-bot", { method: "POST", body: form });
        const payloadJson = await response.json().catch(() => ({})) as { error?: string; sent?: number; group?: string };
        if (!response.ok) {
          const failed = payloadJson.error || "Report Bot flash failed.";
          throw new Error(sent > 0 ? `Sent ${sent} of ${files.length} images, then failed: ${failed}` : failed);
        }
        sent += payloadJson.sent ?? 1;
        if (payloadJson.group) groupName = payloadJson.group;
      }
      setError(null);
      setBackfillNote(`Flashed ${sent} image${sent === 1 ? "" : "s"} to ${groupName} via Report Bot.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not flash via Report Bot.");
    } finally {
      setBusyState(null);
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

    };
    setBusyState(opts.share ? "share" : "image");
    setError(null);
    try {
      const table = reportFor(opts.blockStations, opts.label);
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

  async function shareStation(share: boolean, station = selected) {
    if (!station) return;
    setStationShareBusy(share ? "share" : "image");
    setError(null);
    try {
      const table = reportFor([station], stationNames[station.stationCode] || station.stationCode);
      if (!table.rows.length) throw new Error("Nothing to share for this station.");
      const fileName = `station-board-${payload.businessDate}-${view}-${station.stationCode.toLowerCase()}`;
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
    if (isDotView(view)) { void openDotMetricPanel(code, "Eligible"); return; }
    setOpenStation(code);
    setTids(null);
    setTidsError(null);
    setTidMode("grouped");
    setTidDay(null);
    setPanelMode("card");
    setTidLabel("Tracking IDs");
    setCopied(false);
  }

  function closeStationPanel() {
    setOpenStation(null);
    setTids(null);
    setTidsError(null);
    setTidMode("grouped");
    setTidDay(null);
    setPanelMode("card");
    setTidLabel("Tracking IDs");
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
      setTidLabel("Tracking IDs");
      setPanelMode("tids");
    } catch (err) {
      setTidsError(err instanceof Error ? err.message : "Unable to load tracking IDs.");
      setTids(null);
      setPanelMode("card");
    } finally {
      setTidsBusy(false);
    }
  }

  async function openDotMetricPanel(code: string, header: string) {
    setOpenStation(code); setPanelMode("tids"); setTids(null); setTidsBusy(true); setTidsError(null);
    setTidLabel(`${header} · ${code}`); setTidMode("grouped"); setTidDay(null);
    try {
      const params = new URLSearchParams({station: code, date: payload.businessDate, kind: view});
      const response = await fetch(`/api/ops-pulse/edd/board/tids?${params}`, {cache: "no-store"});
      const body = await response.json();
      if (!response.ok || !Array.isArray(body.rows)) throw new Error(body.error || "Unable to load DOT shipments.");
      setTids((body.rows as TidRow[]).filter(row => matchesDotMetric(row, header)));
    } catch (err) { setTidsError(err instanceof Error ? err.message : "Unable to load DOT shipments."); }
    finally { setTidsBusy(false); }
  }

  function openStationMetricPanel(code: string, metric: StationDsrMetric, label: string) {
    const rows = stationDsrMetricRows(dsrStationRows, code, payload.businessDate, metric);
    setOpenStation(code);
    setTids(rows);
    setTidsError(null);
    setTidMode("grouped");
    setTidDay(null);
    setPanelMode("tids");
    setTidLabel(label);
    setCopied(false);
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
    ["dot", "DOT"],
    ["rts", "RTS pendency"],
    ["swa", "SWA DSR"],
    ["zero", "Zero deliveries"],
  ] as const;

  return (
    <div className={s.board}>
      <div className={s.toolbar}>
        <div className={s.title}>
          <h2>Station board</h2>
          <p>
            {formatOpsDate(payload.businessDate, payload.businessDate)}
            {refreshStartedAt ? ` · started ${formatOpsDateTime(refreshStartedAt, refreshStartedAt)}` : ""}
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
              aria-selected={view === key || (key === "dot" && isDotView(view))}
              onClick={() => {
                changeView(key);
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div className={s.filters}>
          <EddScopeFilters codes={payload.stations.map(row => row.stationCode)} clusters={clusters} stationNames={stationNames}
            value={{ stations: [...stationFilter], clusters: [...clusterFilter], regions: [...regions] }}
            onChange={next => { setStationFilter(new Set(next.stations)); setClusterFilter(new Set(next.clusters)); setRegions(new Set(next.regions.map(asRegion).filter(region => region !== 'ALL'))); }} />
        </div>

        <div className={s.actions}>
          <button type="button" disabled={busy !== null || !stations.length || payload.businessDate !== new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())} title="Queue a background refresh for the selected stations. Available for today." onClick={() => void refresh()}>
            {busy === "refresh" ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            {busy === "refresh" ? " Refreshing…" : ` Refresh ${stations.length} station${stations.length === 1 ? "" : "s"}`}
          </button>
          {view !== "rts" && <>
          <button type="button" disabled={busy !== null || outputUnavailable} onClick={() => void onDownload()}>
            {busy === "download" ? <Loader2 size={14} className="spin" /> : <Download size={14} />} Excel
          </button>
          <button
            type="button"
            disabled={busy !== null || outputUnavailable}
            onClick={() => void shareBlock({ key: regions.size ? [...regions].join("-") : "all", label: regionLabel, blockStations: stations, share: false, scope: "all" })}
          >
            {busy === "image" ? <Loader2 size={14} className="spin" /> : <ImageDown size={14} />} Image
          </button>
          <CopyReportImage resetKey={`${view}-${level}-${groupByStation}-${ageingMode}-${reportTime}-${[...stationFilter]}-${[...clusterFilter]}-${[...regions]}-${JSON.stringify(sort)}`} disabled={busy !== null || outputUnavailable || !report.rows.length} getImages={() => renderBoardShareImages(report, true)} />
          <button
            type="button"
            className={s.primary}
            disabled={busy !== null || outputUnavailable}
            onClick={() => requestWhatsAppShare({
              scope: "all",
              key: regions.size ? [...regions].join("-") : "all",
              label: regionLabel,
              blockStations: stations
            })}
          >
            {busy === "share" || busy === "bot" ? <Loader2 size={14} className="spin" /> : <Share2 size={14} />} WhatsApp
          </button></>}
        </div>

        {backfillProgress || backfillNote ? (
          <div className={s.sweep} role="status" aria-live="polite">
            <div className={s.track}>
              <span
                style={{
                  width: `${
                    backfillProgress && backfillProgress.total > 0
                      ? Math.min(100, Math.round((backfillProgress.done / backfillProgress.total) * 100))
                      : busy === "refresh"
                        ? 8
                        : 100
                  }%`,
                }}
              />
            </div>
            <span>
              {backfillNote
                || (backfillProgress && backfillProgress.total > 0
                  ? `Pulling stations · ${backfillProgress.done}/${backfillProgress.total}`
                  : "Pulling board data…")}
            </span>
          </div>
        ) : null}
        {error ? <p className={s.error} role="alert">{error}</p> : null}
      </div>

      {view === "rts" ? <RtsReport stations={stations} date={payload.businessDate} /> : <>
      {isDotView(view) && <div className={s.segment} aria-label="DOT category">{([['dot','Overall'],['premium','Premium'],['standard','Standard']] as const).map(([key,label])=><button key={key} type="button" aria-pressed={view===key} onClick={()=>changeView(key)}>{label}</button>)}</div>}
      {hasDetailViews ? <div className={s.viewControls}>
      {hasDetailViews ? <div className={s.segment} aria-label="Report detail">
          <button type="button" aria-pressed={level === "station"} onClick={() => setLevels(p => ({ ...p, [view]: "station" }))}>Station view</button>
          <button type="button" aria-pressed={level === "associate"} onClick={() => setLevels(p => ({ ...p, [view]: "associate" }))}>Associate detail</button>
        </div> : null}
        {hasDetailViews && level === "associate" ? <div className={s.segment} aria-label="Associate layout">
          <button type="button" aria-pressed={!groupByStation} onClick={() => setGroupByStation(false)}>Combined</button>
          <button type="button" aria-pressed={groupByStation} onClick={() => setGroupByStation(true)}>Group by station</button>
        </div> : null}
      </div> : null}

      <div className={s.kpis} aria-live="polite">
        <article className={s.kpi}><span>Stations with data</span><strong>{isDotView(view) ? dotValues.filter(Boolean).length : totals.ready}/{stations.length}</strong></article>
        {isDotView(view) ? <>
          {([['Eligible', dotSummary.total], ['Dispatched', dotSummary.dispatched], ['At station', dotSummary.atStation], ['Delivered', dotSummary.delivered]] as const).map(([label,value]) => <article key={label} className={s.kpi}><span>{label}</span><strong>{dotUnavailable ? "—" : count(value)}</strong></article>)}
          <article className={s.kpi}><span>DOT</span><strong style={metricStyle(dotUnavailable || !dotSummary.total ? null : dotSummary.dotPct)}>{dotUnavailable || !dotSummary.total ? "—" : pct(dotSummary.dotPct)}</strong></article>
        </> : isDsrFamilyView(view) ? <>
          <article className={s.kpi}><span>{view === "swa" ? "SWA DSR" : "Overall DSR"}</span><strong style={metricStyle(delivery.dsrPct)}>{pct(delivery.dsrPct)} <small>({count(delivery.delivered)})</small></strong></article>
          <article className={s.kpi} title="Shipments with a delivery-failed outcome; rejected shipments are shown separately"><span>Delivery failed</span><strong>{count(delivery.failed)}</strong></article>
          <article className={s.kpi} title="Shipments with a delivery-rejected outcome"><span>Rejected</span><strong>{count(delivery.rejected)}</strong></article>
          <article className={s.kpi}><span>On road</span><strong>{pct(delivery.roadPct)} <small>({count(delivery.oor)})</small></strong></article>
        </> : view === "creturn" ? <>
          <article className={s.kpi}><span>Total C-Return</span><strong>{detailUnavailable ? "—" : count(cReturnShown.total)}</strong></article>
          <article className={s.kpi}><span>Pending pickup</span><strong>{detailUnavailable ? "—" : count(cReturnShown.pending)}</strong></article>
          <article className={s.kpi}><span>Pickup done</span><strong style={metricStyle(detailUnavailable || !cReturnShown.total ? null : cReturnShown.picked / cReturnShown.total * 100)}>{detailUnavailable ? "—" : count(cReturnShown.picked)} <small>{!detailUnavailable && cReturnShown.total ? `(${(cReturnShown.picked / cReturnShown.total * 100).toFixed(2)}%)` : ""}</small></strong></article>
        </> : view === "ageing" ? <>
          <article className={s.kpi}><span>Ageing shipments</span><strong>{count(ageing.grandTotal.count)}</strong></article>
          <article className={s.kpi}><span>Ageing value</span><strong>₹{inr(ageing.grandTotal.amount)}</strong></article>
        </> : <>
          <article className={s.kpi}><span>EDD packages</span><strong>{count(totals.edd)}</strong></article>
          <article className={s.kpi}><span>C-Return</span><strong>{count(totals.cReturn)} <small>· {totals.cReturn ? `${totals.pickupPct.toFixed(2)}% pickup` : "—"}</small></strong></article>
        </>}
        {!isDotView(view) && <button type="button" className={s.kpi} aria-pressed={view === "zero"} onClick={() => changeView(view === "zero" ? "dsr" : "zero")}><span>Zero-delivery DAs ↗</span><strong>{count(totals.zero)} <small>of {totals.das} DAs</small></strong></button>}
      </div>

      <section className={s.panel}>
        <div className={s.panelHead}>
          <h3>{report.title}</h3>
          <span>{formatOpsDate(payload.businessDate, payload.businessDate)} · Latest station update {formatOpsDateTime(reportTime, reportTime)}</span>
          {view === "ageing" ? <div className={s.segment} aria-label="Ageing type">
            <button type="button" aria-pressed={ageingMode === "day"} onClick={() => setAgeingMode("day")}>Day buckets</button>
            <button type="button" aria-pressed={ageingMode === "week"} onClick={() => setAgeingMode("week")}>Week buckets</button>
          </div> : null}
        </div>
        <div className={s.reportMeta}>
          <span>{stations.length} stations{isDsrFamilyView(view) ? ` · ${delivery.daCount} DAs · ${count(delivery.total)} shipments` : ""}</span>
          <span>{isDsrFamilyView(view) ? (level === "associate" && groupByStation ? "Sorted within station · percentages of total shipments" : "Sorted across stations · percentages of total shipments") : view === "creturn" ? "Pending pickup excludes picked up, cancelled and unpickupable" : "Select a station for details"}</span>
        </div>
        {stations.some(station => boardSourceStatus(station) !== 'current') ? <small role="status" className={s.reportMeta}>
          {stations.filter(station => boardSourceStatus(station) === 'older').length} stations have older data · {stations.filter(station => boardSourceStatus(station) === 'missing').length} not fetched. Totals cover available data.
        </small> : null}
        {(isDsrFamilyView(view) || isDotView(view)) && stations.some(s => (s.board.dsrHistoryPending || 0) > 0) ? <small role="status" className={s.reportMeta}>History reconciliation pending: {count(stations.reduce((n, s) => n + (s.board.dsrHistoryPending || 0), 0))} shipments. Totals update as Amazon history is checked.</small> : null}
        {(isDsrFamilyView(view) || isDotView(view) || view === 'creturn') && <small className={s.reportMeta}>{performanceTarget == null ? 'Target not configured for this metric · neutral colours' : `Dark green ≥${performanceTarget.toFixed(2)}% · light green ≥${Math.max(0,performanceTarget-4).toFixed(2)}% · amber ≥${Math.max(0,performanceTarget-14).toFixed(2)}% · red below`}</small>}
        {isDotView(view) ? <small className={s.reportMeta}>EDD equals selected date · DOT = delivered ÷ eligible. At station includes returned parcels; dispatched and at-station counts can overlap.</small> : null}
        {isDotView(view) && dotMetadataPending > 0 ? <small className={s.reportMeta} role="status">{count(dotMetadataPending)} shipments have missing or unrecognised ship option / EDD. DOT includes confirmed eligible classes only.</small> : null}
        {dotUnavailable ? <small className={s.reportMeta} role="status">Eligible DOT inventory was not captured for this date. Refresh today to start tracking; historical gaps are shown as —.</small> : null}
        {view === "ageing" ? <small className={s.reportMeta}>Higher pending value / count = red · lower = green · compared within selected filters.</small> : null}
        {needsDsrStation ? <small className={s.reportMeta}>{STATION_DSR_INVENTORY_NOTE}</small> : null}
        {needsDsrStation && (dsrStationPending || dsrStationError) ? <small role={dsrStationError ? "alert" : "status"} className={s.reportMeta}>
          {dsrStationError || "Loading pending-today and physical inventory…"}
          {dsrStationError ? <button type="button" onClick={() => { setDsrStationData(null); setDsrStationRetry(value => value + 1); }}>Retry</button> : null}
        </small> : null}
        {detailUnavailable ? <div className={s.empty} role={detailError ? "alert" : "status"}>
          {detailError || "Loading C-Return associates…"}
          {detailError ? <button type="button" onClick={() => { setCReturnData(null); setDetailRetry(n => n + 1); }}>Retry</button> : null}
        </div> : <div className={s.scroll}>
          <ReportTable className={`${s.table} ${s.compactTable}`} reportTitle={report.title} reportExport={() => excelReport()}>
            <thead><tr>{report.headers.map(header => <th key={header} aria-sort={sort.header === header ? sort.direction === "asc" ? "ascending" : "descending" : "none"}>
              <button type="button" className={s.sortButton} title={header === STATION_DSR_PENDING_HEADER ? "Physically at station, due on the selected date, with no dispatch or attempt on or before that date. Driver assignment alone does not exclude a shipment." : header === STATION_DSR_PHYSICAL_HEADER ? "All shipments physically at station across EDD dates, including held and returned stock. Includes EDD pending today; these columns are not additive." : header === "Outcome missing" ? "Click to inspect shipments awaiting history verification or returned without a recorded delivery outcome. A return alone does not prove failure or rejection. Included in Assigned." : header === DSR_HEADERS.failed ? "Amazon delivery-failed outcome: the operational attempted count. Rejections remain separate." : header === DSR_HEADERS.oor ? "Red: more than 50% still on road from 1 pm IST, based on the station snapshot time." : undefined} onClick={() => setSorts(previous => ({ ...previous, [sortKey]: { header, direction: sort.header === header && sort.direction === "desc" ? "asc" : "desc" } }))}>{header}<span aria-hidden="true">{sort.header === header ? sort.direction === "asc" ? "↑" : "↓" : "↕"}</span></button>
            </th>)}</tr></thead>
            <tbody>{report.rows.slice(0, report.rows.length - report.totalRows).map((row, i) => <tr key={`${report.rowStations[i]}-${i}`} className={report.groupStarts[i] ? s.groupStart : undefined}>
              {row.map((cell, column) => {
                const header = report.headers[column];
                const metric = ({ [STATION_DSR_PENDING_HEADER]: "eddPending", [STATION_DSR_PHYSICAL_HEADER]: "physicalAtStation", Assigned: "assigned", Total: "assigned", Delivered: "delivered", "Delivery Failed": "failed", "Delivery Rejected": "rejected", "Out on Road": "onRoad", "Outcome missing": "other" } as Record<string, StationDsrMetric>)[header];
                const stationCode = report.rowStations[i];
                const stationMetric = view === "dsr" && level === "station" && metric && cell.text !== "—";
                return <td key={column} style={{ background: cell.bg, color: cell.color, textAlign: cell.align, fontWeight: cell.bold ? 650 : undefined }}>
                  {((header === "Station" && cell.text) || (singleStation && !report.headers.includes("Station") && column === 0 && stationCode)) ? <button type="button" className={s.stationBtn} onClick={() => openStationPanel(stationCode)}>{cell.text}</button>
                    : isDotView(view) && column > 0 && cell.text !== "—" && header !== "DOT%" && header !== "Source updated (IST)" ? <button type="button" className={s.metricBtn} onClick={() => void openDotMetricPanel(stationCode, header)}>{cell.text}</button>
                    : stationMetric ? <button type="button" className={s.metricBtn} title={`View ${header} TIDs`} onClick={() => openStationMetricPanel(stationCode, metric, `${header} · ${stationCode}`)}>{cell.text}</button>
                      : cell.text}
                </td>;
              })}
            </tr>)}</tbody>
            {report.totalRows ? <tfoot>{report.rows.slice(-report.totalRows).map((row, i) => <tr key={i}>{row.map((cell, column) => <td key={column} style={{ background: cell.bg, color: cell.color, textAlign: cell.align }}>{cell.text}</td>)}</tr>)}</tfoot> : null}
          </ReportTable>
          {!stations.length || !report.rows.length ? <p className={s.empty}>No matching records for these filters.</p> : null}
        </div>}
      </section>

      </>}
      {!pivot.grandTotal && view === "edd" && stations.some((row) => row.hasSnapshot) ? (
        <p className={s.note}>If cells are empty, click <strong>Refresh</strong> to pull board data for the selected date.</p>
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
              <button type="button" onClick={() => void downloadStationExcel()}><Download size={14} /> Excel</button>
              <button type="button" disabled={stationShareBusy !== null} onClick={() => void shareStation(false)}>
                {stationShareBusy === "image" ? <Loader2 size={14} className="spin" /> : <ImageDown size={14} />} Image
              </button>
              <CopyReportImage resetKey={`${selected.stationCode}-${view}-${reportTime}-${JSON.stringify(sort)}`} disabled={stationShareBusy !== null} getImages={() => { const table = reportFor([selected], selected.stationCode); return renderBoardShareImages(table, true); }} />
              <button
                type="button"
                className={s.primary}
                disabled={stationShareBusy !== null}
                onClick={() => selected && requestWhatsAppShare({ scope: "station", station: selected })}
              >
                {stationShareBusy === "share" || stationShareBusy === "bot" ? <Loader2 size={14} className="spin" /> : <Share2 size={14} />} WhatsApp
              </button>
              {panelMode === "tids" && !isDotView(view) ? (
                <button type="button" onClick={() => setPanelMode("card")}>
                  <LayoutList size={14} /> View station card
                </button>
              ) : (
                <button type="button" disabled={tidsBusy} onClick={() => void loadTids()}>
                  {tidsBusy ? <Loader2 size={14} className="spin" /> : <ListOrdered size={14} />} View TIDs
                </button>
              )}
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
                      <strong style={metricStyle(selected.board.cReturnTotal ? selected.board.pickupDonePct : null)}>{selected.board.cReturnTotal ? `${selected.board.pickupDonePct.toFixed(2)}%` : "—"}</strong>
                    </div>
                  </div>
                </div>
              ) : view === "edd" ? (
                <div className={s.shareCard}>
                  <div className={s.shareCardHead}>
                    <span>Ops Pulse · Station board</span>
                    <strong>EDD · {selected.stationCode}{stationNames[selected.stationCode] ? ` · ${stationNames[selected.stationCode]}` : ""}</strong>
                    <small>{formatOpsDate(payload.businessDate, payload.businessDate)} · Inducted × promised delivery date</small>
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
                  {(() => {
                    const local = reportFor([selected], selected.stationCode);
                    return <div className={s.scroll}><ReportTable className={`${s.table} ${s.compactTable}`} reportTitle={local.title} reportExport={() => excelReport(local)}>
                      <thead><tr>{local.headers.map(header=><th key={header}>{header}</th>)}</tr></thead>
                      <tbody>{local.rows.map((row,i)=><tr key={i}>{row.map((cell,j)=><td key={j} style={{background:cell.bg,color:cell.color,textAlign:cell.align,fontWeight:cell.bold?650:undefined}}>{cell.text}</td>)}</tr>)}</tbody>
                    </ReportTable></div>;
                  })()}
                </div>
              ) : (
                <div className={s.shareCard}>
                  <div className={s.shareCardHead}>
                    <span>Ops Pulse · Station board</span>
                    <strong>{view === "premium" ? "Premium DOT" : view === "standard" ? "Standard DOT" : view === "swa" ? "SWA DSR" : view === "zero" ? "Zero deliveries" : "DA DSR"} · {selected.stationCode}</strong>
                    <small>{formatOpsDate(payload.businessDate, payload.businessDate)} · DropX Logistics</small>
                  </div>
                  <div className={s.shareColsWide} style={{ gridTemplateColumns: "minmax(88px, 1.5fr) repeat(7, minmax(46px, .85fr))" }}>
                    <span>{DSR_HEADERS.da}</span>
                    <span>{DSR_HEADERS.total}</span>
                    <span>{DSR_HEADERS.delivered}</span>
                    <span>{DSR_HEADERS.oor}</span>
                    <span>{DSR_HEADERS.failed}</span>
                    <span>{DSR_HEADERS.rejected}</span>
                    <span>Outcome missing</span>
                    <span>{DSR_HEADERS.dsrPct}</span>
                  </div>
                  <div className={`${s.shareRows} ${s.shareRowsScroll}`}>
                    {[...daDsrForView(selected.board, view)].sort((a, b) => view === "zero" ? b.oor - a.oor : b.dsrPct - a.dsrPct).map((da) => (
                      <div key={da.driverId} className={s.shareRowWide} style={{ gridTemplateColumns: "minmax(88px, 1.5fr) repeat(7, minmax(46px, .85fr))" }}>
                        <span title={da.driverName || da.driverId}>{da.driverName || da.driverId}</span>
                        <strong>{da.total}</strong>
                        <strong>{da.delivered}</strong>
                        <strong title="Red: more than 50% still on road in a snapshot taken from 1 pm IST onward." style={{ color: oorTextColor(da.oor, da.total, selected.fetchedAt) }}>{da.oor || 0}</strong>
                        <strong>{da.failed || 0}</strong>
                        <strong>{da.rejected || 0}</strong>
                        <strong>{da.other || 0}</strong>
                        <strong style={{ background: performanceColour(da.dsrPct, performanceTarget).bg, color: performanceColour(da.dsrPct, performanceTarget).color }}>{da.dsrPct.toFixed(2)}%</strong>
                      </div>
                    ))}
                    {(() => {
                      const das = daDsrForView(selected.board, view);
                      if (!das.length) {
                        return <p className={s.empty}>{view === "zero" ? "No zero-delivery DAs" : view === "premium" || view === "standard" ? `No ${view === "premium" ? "Premium" : "Standard"} DOT rows yet — Refresh` : "No DA DSR yet — Refresh"}</p>;
                      }
                      const tot = sumDaDsr(das);
                      return (
                        <div className={`${s.shareRowWide} ${s.shareTotal}`} style={{ gridTemplateColumns: "minmax(88px, 1.5fr) repeat(7, minmax(46px, .85fr))" }}>
                          <span>Grand Total · {tot.daCount} DA{tot.daCount === 1 ? "" : "s"}</span>
                          <strong>{tot.total}</strong>
                          <strong>{tot.delivered}</strong>
                          <strong>{tot.oor}</strong>
                          <strong>{tot.failed}</strong>
                          <strong>{tot.rejected}</strong>
                          <strong>{tot.other || 0}</strong>
                          <strong style={{ background: performanceColour(tot.dsrPct, performanceTarget).bg, color: performanceColour(tot.dsrPct, performanceTarget).color }}>{tot.dsrPct.toFixed(2)}%</strong>
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
                      : `${tidLabel} · ${tids.length.toLocaleString("en-IN")}`}
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
                  <p className={s.empty}>No tracking IDs for this station yet. Try Refresh.</p>
                ) : tidMode === "day" ? (
                  <div className={s.tidPlain}>
                    {dayTids.map((row) => <button type="button" className={s.tidTrack} key={row.trackingId} onClick={() => setOpenTrackingId(row.trackingId)}><code>{row.trackingId}</code><span>Track</span></button>)}
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
                    {tids.map((row) => <button type="button" className={s.tidTrack} key={row.trackingId} onClick={() => setOpenTrackingId(row.trackingId)}><code>{row.trackingId}{row.status ? ` · ${row.status}` : ""}{isDotView(view) ? ` · ${row.currentState || "—"} · EDD ${row.edd || "—"}` : ""}</code><span>Track</span></button>)}
                  </div>
                )}
              </div>
            ) : null}
          </aside>
        </div>
      ) : null}
      {canFlashReportBot && whatsAppTarget ? (
        <div className={s.waChooserScrim} role="presentation" onClick={() => setWhatsAppTarget(null)}>
          <div
            className={s.waChooser}
            role="dialog"
            aria-modal="true"
            aria-labelledby="wa-chooser-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <h3 id="wa-chooser-title">Send on WhatsApp</h3>
                <p>Choose device share (current) or flash via Report Bot to the Testing group.</p>
              </div>
              <button type="button" className={s.iconBtn} onClick={() => setWhatsAppTarget(null)} aria-label="Close">
                <X size={16} />
              </button>
            </header>
            <div className={s.waChooserOptions}>
              <button
                type="button"
                disabled={busy !== null || stationShareBusy !== null}
                onClick={() => {
                  const target = whatsAppTarget;
                  setWhatsAppTarget(null);
                  if (target.scope === "station") void shareStation(true, target.station);
                  else void shareBlock({ key: target.key, label: target.label, blockStations: target.blockStations, share: true, scope: "all" });
                }}
              >
                <strong><Smartphone size={14} aria-hidden /> Share from this device</strong>
                <span>Opens the phone/desktop WhatsApp share sheet — same as today.</span>
              </button>
              <button
                type="button"
                disabled={busy !== null || stationShareBusy !== null}
                onClick={() => void flashReportBot(whatsAppTarget)}
              >
                <strong><Bot size={14} aria-hidden /> Send via Report Bot</strong>
                <span>Posts the board image(s) to the Testing group with a Gemini caption.</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <TrackingDetailModal trackingId={openTrackingId} stationHint={selected?.stationCode} onClose={() => setOpenTrackingId(null)} />
    </div>
  );
}
