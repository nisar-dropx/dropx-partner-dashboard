"use client";
import { cReturnDetailTable, dsrStationTable, pendingCReturn, type CReturnAssociate, type BoardDetailLevel } from "@/lib/ops-pulse/board-detail-report";
import { ReportTable } from "@/components/report-table";


import { useEffect, useMemo, useRef, useState } from "react";
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
import { EddMultiSelect } from "../edd-multi-select";
import { boardDeliverySummary, filterBoardStations, prepareBoardReport, type BoardCluster, type BoardReportSort } from "@/lib/ops-pulse/compact-board-report";
import { downloadReportExcel, type ExcelReport } from "@/lib/download-report-excel";
import { TrackingDetailModal } from "@/components/tracking-detail-modal";
import { stationDsrMetricRows, stationDsrReportRows, summarizeStationDsrRows, STATION_DSR_INVENTORY_NOTE, STATION_DSR_PENDING_HEADER, STATION_DSR_PHYSICAL_HEADER, type StationDsrMetric, type StationDsrTidRow } from "@/lib/ops-pulse/station-dsr-summary";

type Props = {
  initial: LoadFlashBoardNetwork;
  stationNames?: Record<string, string>;
  clusters?: BoardCluster[];
  initialRegion?: string;
  initialView?: string;
  initialStations?: string;
  initialClusters?: string;
  initialDetail?: string;
  initialLayout?: string;
};

type BlockBusy = "image" | "share" | null;
type TidMode = "grouped" | "day";
type PanelMode = "card" | "tids";

type TidRow = {
  stationCode?: string;
  trackingId: string;
  status: string;
  currentState?: string;
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
        : zeroOnly ? "Zero deliveries"
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
    ...(hasOther ? ["Other / pending"] : []),
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
        { text: da.total ? `${da.dsrPct}%` : "—", bold: true, bg: da.total ? dsrHeatColor(da.dsrPct) : undefined, color: da.total ? dsrPctTextColor(da.dsrPct) : undefined, align: "right" },
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
      { text: `${tot.dsrPct}%`, bold: true, bg: dsrHeatColor(tot.dsrPct), color: dsrPctTextColor(tot.dsrPct), align: "right" },
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

export function StationBoardView({ initial, stationNames = {}, clusters = [], initialRegion, initialView, initialStations, initialClusters, initialDetail, initialLayout }: Props) {
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
  const level = levels[view] ?? (view === "creturn" || view === "dsr" ? "station" : "associate");
  const [groupByStation, setGroupByStation] = useState(initialLayout === "grouped");
  const hasDetailViews = view === "creturn" || isDsrFamilyView(view);
  const sortKey = `${view}-${level}-${groupByStation}`;
  const sort = sorts[sortKey] ?? {
    header: view === "creturn" ? "Pending pickup"
      : view === "zero" ? DSR_HEADERS.oor
        : isDsrFamilyView(view) ? DSR_HEADERS.dsrPct
          : "Station",
    direction: hasDetailViews ? "desc" : "asc",
  };
  const [cReturnData, setCReturnData] = useState<{ key: string; rows: CReturnAssociate[]; error?: string } | null>(null);
  const [detailRetry, setDetailRetry] = useState(0);
  const [dsrStationData, setDsrStationData] = useState<{ key: string; rows: StationDsrTidRow[]; error?: string } | null>(null);
  const [dsrStationRetry, setDsrStationRetry] = useState(0);
  const [busy, setBusy] = useState<"refresh" | "download" | "image" | "share" | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  /** Resume Refresh after a proxy timeout instead of restarting from station 0. */
  const backfillCursor = useRef(0);
  const backfillClearSeq = useRef(0);
  const busyRef = useRef(busy);
  busyRef.current = busy;

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
    const zero = stations.flatMap(row => row.board.daDsr).filter(da => da.total > 0 && da.delivered === 0).length;
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

  const regionLabel = regions.size ? STATION_BOARD_REGIONS.filter(r => regions.has(r.id)).map(r => r.label).join(" / ") : "All regions";
  const delivery = useMemo(() => boardDeliverySummary(stations, view === "zero"), [stations, view]);
  const pct = (value: number | null) => value == null ? "—" : `${value.toFixed(1)}%`;
  const reportTime = stations.map(row => row.fetchedAt).filter((at): at is string => !!at).sort().at(-1) || payload.asOf;
  const singleStation = stations.length === 1;
  const cReturnKey = JSON.stringify([payload.businessDate, stations.map(s => [s.stationCode, s.fetchedAt])]);
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
  const dsrStationKey = JSON.stringify([payload.businessDate, stations.map(s => [s.stationCode, s.fetchedAt])]);
  const dsrStationPending = needsDsrStation && dsrStationData?.key !== dsrStationKey;
  const dsrStationError = needsDsrStation && dsrStationData?.key === dsrStationKey ? dsrStationData.error : undefined;
  const dsrStationRows = dsrStationData?.key === dsrStationKey && !dsrStationData.error ? dsrStationData.rows : [];
  const dsrStationInventory = useMemo(
    () => dsrStationData?.key === dsrStationKey && !dsrStationData.error
      ? summarizeStationDsrRows(dsrStationData.rows, payload.businessDate, stations.filter(station => station.hasSnapshot && station.board.stationInventoryVersion === 1).map(station => station.stationCode))
      : undefined,
    [dsrStationData, dsrStationKey, payload.businessDate, stations],
  );
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
  function reportFor(blockStations: StationBoardStation[], label: string) {
    const dsrTitle =
      view === "premium" ? "Premium DOT"
        : view === "standard" ? "Standard DOT"
          : view === "zero" ? "Zero deliveries"
            : "DSR";
    const table = view === "creturn" ? cReturnDetailTable(blockStations, cReturnRows, level, stationNames)
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
    const d = boardDeliverySummary(
      blockStations.map((station) => ({
        ...station,
        board: { ...station.board, daDsr: daDsrForView(station.board, view === "zero" ? "dsr" : view) },
      })),
      view === "zero",
    );
    const stats = isDsrFamilyView(view)
      ? ` · DSR ${pct(d.dsrPct)} (${count(d.delivered)}) · Delivery failed ${count(d.failed)} · Rejected ${count(d.rejected)}`
      : "";
    const historyPending = isDsrFamilyView(view) ? blockStations.reduce((n, station) => n + (station.board.dsrHistoryPending || 0), 0) : 0;
    return prepareBoardReport({ ...table,
      compactNote: view === "dsr" && level === "station" ? `${formatOpsDate(payload.businessDate, payload.businessDate)} · Pending today is included in physical stock; do not add these columns.` : undefined,
      title: `${table.title}${blockStations.length === 1 ? ` · ${blockStations[0].stationCode}` : ""}${historyPending ? ` · Provisional (${count(historyPending)} history checks pending)` : ""}`,
      subtitle: `${table.subtitle || `${formatOpsDate(payload.businessDate, payload.businessDate)} · ${label}`} · Updated ${formatOpsDateTime(reportTime, reportTime)}${stats}${view === "dsr" && level === "station" ? ` · ${STATION_DSR_INVENTORY_NOTE}` : ""}`,
    }, sort, { dsr: level === "associate" && isDsrFamilyView(view), singleStation: level === "associate" && view !== "zero" && blockStations.length === 1, groupByStation: hasDetailViews && level === "associate" && groupByStation });
  }
  const report = reportFor(stations, regionLabel);
  const outputUnavailable = detailUnavailable || dsrStationPending || Boolean(dsrStationError);
  function excelReport(table = report, tidSheet?: ExcelReport["extraSheets"]): ExcelReport {
    if (detailUnavailable) throw new Error("Wait for associate details to load, then retry.");
    if (dsrStationPending) throw new Error("Wait for station EDD and physical inventory to load, then retry.");
    if (dsrStationError) throw new Error(dsrStationError);
    return {
      title: table.title,
      headers: table.headers,
      rows: table.rows.map((row) => row.map((cell) => cell.text)),
      scope: table.subtitle,
      extraSheets: tidSheet,
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
            : view === "zero" ? "Zero deliveries"
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
      headers: ["Station", "Report", "Tracking ID", "Status", "EDD", "Ship Option", "DA ID", "DA Name", ...(stationReport ? ["Current Amazon state", "EDD pending today", "Physical at station", "DSR outcome"] : [])],
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

  async function reloadBoard() {
    const response = await fetch(`/api/ops-pulse/edd/board?date=${encodeURIComponent(payload.businessDate)}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Unable to refresh the station board.");
    const next = (await response.json()) as LoadFlashBoardNetwork;
    setPayload(next);
    setRun(next.run);
  }

  function isTransientMessage(message: string) {
    return /aborted due to timeout|timeout|timed out|504|524|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|connection dropped|network|socket/i.test(message);
  }

  /** Stations per tick (last packet uses whatever remain if <4). */
  const BOARD_PULL_CONCURRENCY = "4";

  async function postBackfillTick(params: URLSearchParams) {
    const response = await fetch(`/api/ops-pulse/edd/board/backfill?${params}`, { method: "POST", cache: "no-store" });
    const body = await response.json().catch(() => ({})) as {
      nextIndex?: number;
      total?: number;
      done?: boolean;
      advanced?: number;
      failed?: string[];
      error?: string;
      alreadyRunning?: boolean;
      busy?: boolean;
      running?: boolean;
      startedAt?: string;
    };
    return { response, body };
  }

  function sharedRefreshNote(next: Pick<LoadFlashBoardNetwork, "refreshOwner" | "refreshDone" | "refreshTotal" | "refreshRunning">) {
    const total = Number(next.refreshTotal ?? 0) || 0;
    const done = Number(next.refreshDone ?? 0) || 0;
    const who =
      next.refreshOwner === "cron"
        ? "Hourly refresh working"
        : "Refresh working";
    if (!next.refreshRunning) return "Board data updated.";
    return total ? `${who} · ${done}/${total}` : `${who}…`;
  }

  /** Watch a Refresh someone else (or cron) already started — update board as stations finish. */
  async function watchSharedRefresh(clearSeq: number) {
    setBusy("refresh");
    setBackfillNote("Refresh working…");
    let guard = 0;
    while (guard < 120) {
      guard += 1;
      if (clearSeq !== backfillClearSeq.current) return;
      const response = await fetch(`/api/ops-pulse/edd/board?date=${encodeURIComponent(payload.businessDate)}`, { cache: "no-store" });
      if (!response.ok) {
        await new Promise((r) => setTimeout(r, 2500));
        continue;
      }
      const next = (await response.json()) as LoadFlashBoardNetwork;
      setPayload(next);
      setRun(next.run);
      const total = Number(next.refreshTotal ?? 0) || 0;
      const done = Number(next.refreshDone ?? 0) || 0;
      if (total > 0) setBackfillProgress({ done, total });
      setBackfillNote(sharedRefreshNote(next));
      if (!next.refreshRunning) break;
      await new Promise((r) => setTimeout(r, 2500));
    }
  }

  async function runRetryPass(
    keys: string[],
    passLabel: string,
    streakTimeoutsRef: { n: number },
    stationTotal: number,
  ) {
    const stillFailed: string[] = [];
    let deferredRetries = 0;
    for (let i = 0; i < keys.length; ) {
      const chunk = keys.slice(i, i + 4);
      const recovered = Math.min(i + chunk.length, keys.length);
      setBackfillNote(`${passLabel} · ${recovered}/${keys.length}`);
      if (stationTotal > 0) {
        setBackfillProgress({
          done: Math.max(0, stationTotal - keys.length + recovered),
          total: stationTotal,
        });
      }
      const params = new URLSearchParams({
        days: "1",
        date: payload.businessDate,
        concurrency: BOARD_PULL_CONCURRENCY,
        retryJobs: chunk.join(","),
      });
      let response: Response;
      let body: { failed?: string[]; error?: string; advanced?: number; done?: boolean };
      try {
        ({ response, body } = await postBackfillTick(params));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Board recovery failed.";
        if (isTransientMessage(message) && streakTimeoutsRef.n < 6) {
          streakTimeoutsRef.n += 1;
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        throw err instanceof Error ? err : new Error(message);
      }
      if (!response.ok) {
        const message = String(body.error ?? "Board recovery failed.");
        if (isTransientMessage(message) && streakTimeoutsRef.n < 6) {
          streakTimeoutsRef.n += 1;
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        throw new Error(message);
      }
      streakTimeoutsRef.n = 0;
      const advanced = Number(body.advanced ?? 0) || 0;
      if (!advanced) {
        deferredRetries += 1;
        if (deferredRetries > 8) {
          stillFailed.push(...chunk);
          i += chunk.length;
          deferredRetries = 0;
          continue;
        }
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      deferredRetries = 0;
      const failedAgain = new Set((body.failed ?? []).map(String).filter(Boolean));
      for (const key of chunk) {
        if (failedAgain.has(key)) stillFailed.push(key);
      }
      i += chunk.length;
      await reloadBoard().catch(() => undefined);
    }
    return stillFailed;
  }

  async function runBackfillLoop(clearSeq: number): Promise<"owner" | "watcher"> {
    // Keep prior board data visible — stations overwrite in place as each packet saves.
    backfillCursor.current = 0;
    setBackfillNote("Starting refresh…");
    setBackfillProgress({ done: 0, total: 0 });
    {
      const resetParams = new URLSearchParams({
        days: "1",
        date: payload.businessDate,
        concurrency: BOARD_PULL_CONCURRENCY,
        reset: "1",
      });
      const { response, body } = await postBackfillTick(resetParams);
      if (!response.ok) throw new Error(String(body.error ?? "Unable to start board refresh."));
      const total = Number(body.total ?? 0) || 0;
      const done = Number(body.nextIndex ?? 0) || 0;
      if (total > 0) setBackfillProgress({ done, total });
      // Someone else already owns this Refresh — watch shared progress only.
      if (body.alreadyRunning) {
        setBackfillNote(total ? `Refresh working · ${done}/${total}` : "Refresh working…");
        await watchSharedRefresh(clearSeq);
        return "watcher";
      }
      setBackfillNote(total ? `Pulling stations · ${done}/${total}` : "Pulling board data…");
      await reloadBoard().catch(() => undefined);
    }

    let guard = 0;
    const streakTimeoutsRef = { n: 0 };
    const failedAcc = new Set<string>();
    let stationTotal = 0;
    // Shared server cursor — do not send startIndex (prevents two browsers diverging).
    while (guard < 80) {
      guard += 1;
      if (clearSeq !== backfillClearSeq.current) return "owner";
      const params = new URLSearchParams({
        days: "1",
        date: payload.businessDate,
        concurrency: BOARD_PULL_CONCURRENCY,
      });
      let response: Response;
      let body: {
        nextIndex?: number;
        total?: number;
        done?: boolean;
        advanced?: number;
        failed?: string[];
        error?: string;
        busy?: boolean;
      };
      try {
        ({ response, body } = await postBackfillTick(params));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Board backfill failed.";
        if (isTransientMessage(message) && streakTimeoutsRef.n < 6) {
          streakTimeoutsRef.n += 1;
          setBackfillNote("Worker busy — retrying packet…");
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        throw err instanceof Error ? err : new Error(message);
      }
      if (!response.ok) {
        const message = String(body.error ?? "Board backfill failed.");
        if (isTransientMessage(message) && streakTimeoutsRef.n < 6) {
          streakTimeoutsRef.n += 1;
          setBackfillNote("Connection dropped — retrying…");
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        throw new Error(isTransientMessage(message)
          ? "Worker connection dropped. Click Refresh again — it will resume cleanly."
          : message);
      }
      streakTimeoutsRef.n = 0;
      for (const key of body.failed ?? []) {
        if (key) failedAcc.add(String(key));
      }
      const advanced = Number(body.advanced ?? 0) || 0;
      const total = Number(body.total ?? 0) || 0;
      const nextIndex = Number(body.nextIndex ?? 0) || 0;
      if (total > 0) stationTotal = total;
      if (body.busy && !advanced && !body.done) {
        setBackfillNote(total ? `Refresh working · ${nextIndex}/${total}` : "Refresh working…");
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      if (body.done) {
        if (total > 0) setBackfillProgress({ done: total, total });
        backfillCursor.current = 0;
        await reloadBoard().catch(() => undefined);
        break;
      }
      if (!advanced) {
        setBackfillNote(`Worker deferred packet — retrying…`);
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      backfillCursor.current = nextIndex;
      const done = total ? Math.min(nextIndex, total) : nextIndex;
      if (total > 0) setBackfillProgress({ done, total });
      setBackfillNote(total ? `Pulling stations · ${done}/${total}` : "Pulling board data…");
      await reloadBoard().catch(() => undefined);
    }

    let pending = [...failedAcc];
    if (pending.length) {
      setBackfillNote(`Main pull done · recovering ${pending.length} station${pending.length === 1 ? "" : "s"}…`);
      pending = await runRetryPass(pending, "Recovering failed stations", streakTimeoutsRef, stationTotal);
    }
    if (pending.length) {
      pending = await runRetryPass(pending, "Second recovery pass", streakTimeoutsRef, stationTotal);
    }
    if (pending.length) {
      setBackfillNote(
        `Board pull finished · ${pending.length} station${pending.length === 1 ? "" : "s"} still failed after recovery`,
      );
    } else if (failedAcc.size) {
      setBackfillNote("Board pull finished · recovered all failed stations");
    }
    return "owner";
  }

  async function refresh() {
    const clearSeq = ++backfillClearSeq.current;
    setBusy("refresh");
    setError(null);
    setBackfillNote("Starting refresh…");
    setBackfillProgress({ done: 0, total: 0 });
    try {
      void fetch("/api/ops-pulse/edd/flash/network/refresh-all", { method: "POST", cache: "no-store" }).catch(() => undefined);
      await runBackfillLoop(clearSeq);
      await reloadBoard();
      setBackfillNote("Board data updated.");
      window.setTimeout(() => {
        if (clearSeq !== backfillClearSeq.current) return;
        setBackfillProgress(null);
        setBackfillNote("");
      }, 2500);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Refresh failed.";
      setError(isTransientMessage(message)
        ? "Worker connection dropped. Click Refresh again — it will resume cleanly."
        : message);
    } finally {
      setBusy(null);
    }
  }

  // Join a Refresh already in progress (another user or hourly cron), including
  // when cron starts while this page is open — poll every ~8s while idle.
  useEffect(() => {
    let cancelled = false;
    async function joinIfRunning() {
      if (cancelled || busyRef.current !== null) return;
      try {
        const response = await fetch(`/api/ops-pulse/edd/board?date=${encodeURIComponent(payload.businessDate)}`, { cache: "no-store" });
        if (!response.ok || cancelled || busyRef.current !== null) return;
        const next = (await response.json()) as LoadFlashBoardNetwork;
        setPayload(next);
        setRun(next.run);
        if (!next.refreshRunning || cancelled || busyRef.current !== null) return;
        const clearSeq = ++backfillClearSeq.current;
        try {
          await watchSharedRefresh(clearSeq);
          if (cancelled || clearSeq !== backfillClearSeq.current) return;
          setBackfillNote("Board data updated.");
          window.setTimeout(() => {
            if (clearSeq !== backfillClearSeq.current) return;
            setBackfillProgress(null);
            setBackfillNote("");
          }, 2500);
        } finally {
          if (clearSeq === backfillClearSeq.current) setBusy(null);
        }
      } catch {
        // ignore poll errors — next interval retries
      }
    }
    void joinIfRunning();
    const id = window.setInterval(() => void joinIfRunning(), 8000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poll while board date stays put
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

  async function shareStation(share: boolean) {
    if (!selected) return;
    setStationShareBusy(share ? "share" : "image");
    setError(null);
    try {
      const table = reportFor([selected], stationNames[selected.stationCode] || selected.stationCode);
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
    ["premium", "Premium DOT"],
    ["standard", "Standard DOT"],
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
              aria-selected={view === key}
              onClick={() => {
                changeView(key);
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div className={s.filters}>
          <EddMultiSelect label="Stations" options={payload.stations.map(row => row.stationCode).sort()} selected={stationFilter} onChange={setStationFilter} renderOption={code => stationNames[code] ? `${code} · ${stationNames[code]}` : code} />
          <EddMultiSelect label="Cluster / AOM" options={clusters.map(c => c.value)} selected={clusterFilter} onChange={setClusterFilter} renderOption={id => clusters.find(c => c.value === id)?.label || id} />
          <EddMultiSelect label="Regions" options={STATION_BOARD_REGIONS.map(r => r.id)} selected={regions} onChange={setRegions} renderOption={id => STATION_BOARD_REGIONS.find(r => r.id === id)?.label || id} />
        </div>

        <div className={s.actions}>
          <button type="button" disabled={busy !== null} onClick={() => void refresh()}>
            {busy === "refresh" ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            {busy === "refresh" ? " Working…" : " Refresh"}
          </button>
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
            onClick={() => void shareBlock({ key: regions.size ? [...regions].join("-") : "all", label: regionLabel, blockStations: stations, share: true, scope: "all" })}
          >
            {busy === "share" ? <Loader2 size={14} className="spin" /> : <Share2 size={14} />} WhatsApp
          </button>
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
        <article className={s.kpi}><span>Stations ready</span><strong>{totals.ready}/{stations.length}</strong></article>
        {isDsrFamilyView(view) ? <>
          <article className={s.kpi}><span>Overall DSR</span><strong>{pct(delivery.dsrPct)} <small>({count(delivery.delivered)})</small></strong></article>
          <article className={s.kpi} title="Shipments with a delivery-failed outcome; rejected shipments are shown separately"><span>Delivery failed</span><strong>{count(delivery.failed)}</strong></article>
          <article className={s.kpi} title="Shipments with a delivery-rejected outcome"><span>Rejected</span><strong>{count(delivery.rejected)}</strong></article>
          <article className={s.kpi}><span>On road</span><strong>{pct(delivery.roadPct)} <small>({count(delivery.oor)})</small></strong></article>
        </> : view === "creturn" ? <>
          <article className={s.kpi}><span>Total C-Return</span><strong>{detailUnavailable ? "—" : count(cReturnShown.total)}</strong></article>
          <article className={s.kpi}><span>Pending pickup</span><strong>{detailUnavailable ? "—" : count(cReturnShown.pending)}</strong></article>
          <article className={s.kpi}><span>Pickup done</span><strong>{detailUnavailable ? "—" : count(cReturnShown.picked)} <small>{!detailUnavailable && cReturnShown.total ? `(${Math.round(cReturnShown.picked / cReturnShown.total * 100)}%)` : ""}</small></strong></article>
        </> : view === "ageing" ? <>
          <article className={s.kpi}><span>Ageing shipments</span><strong>{count(ageing.grandTotal.count)}</strong></article>
          <article className={s.kpi}><span>Ageing value</span><strong>₹{inr(ageing.grandTotal.amount)}</strong></article>
        </> : <>
          <article className={s.kpi}><span>EDD packages</span><strong>{count(totals.edd)}</strong></article>
          <article className={s.kpi}><span>C-Return</span><strong>{count(totals.cReturn)} <small>· {totals.cReturn ? `${totals.pickupPct}% pickup` : "—"}</small></strong></article>
        </>}
        <button type="button" className={s.kpi} aria-pressed={view === "zero"} onClick={() => changeView(view === "zero" ? "dsr" : "zero")}><span>Zero-delivery DAs ↗</span><strong>{count(totals.zero)} <small>of {totals.das} DAs</small></strong></button>
      </div>

      <section className={s.panel}>
        <div className={s.panelHead}>
          <h3>{report.title}</h3>
          <span>{formatOpsDate(payload.businessDate, payload.businessDate)} · Updated {formatOpsDateTime(reportTime, reportTime)}</span>
          {view === "ageing" ? <div className={s.segment} aria-label="Ageing type">
            <button type="button" aria-pressed={ageingMode === "day"} onClick={() => setAgeingMode("day")}>Day buckets</button>
            <button type="button" aria-pressed={ageingMode === "week"} onClick={() => setAgeingMode("week")}>Week buckets</button>
          </div> : null}
        </div>
        <div className={s.reportMeta}>
          <span>{stations.length} stations{isDsrFamilyView(view) ? ` · ${delivery.daCount} DAs · ${count(delivery.total)} shipments` : ""}</span>
          <span>{isDsrFamilyView(view) ? (level === "associate" && groupByStation ? "Sorted within station · percentages of total shipments" : "Sorted across stations · percentages of total shipments") : view === "creturn" ? "Pending pickup excludes picked up, cancelled and unpickupable" : "Select a station for details"}</span>
        </div>
        {isDsrFamilyView(view) && stations.some(s => (s.board.dsrHistoryPending || 0) > 0) ? <small role="status" className={s.reportMeta}>History reconciliation pending: {count(stations.reduce((n, s) => n + (s.board.dsrHistoryPending || 0), 0))} shipments. Totals update as Amazon history is checked.</small> : null}
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
              <button type="button" className={s.sortButton} title={header === STATION_DSR_PENDING_HEADER ? "Physically at station, due on the selected date, with no dispatch or attempt that day. Driver assignment alone does not exclude a shipment." : header === STATION_DSR_PHYSICAL_HEADER ? "All shipments physically at station across EDD dates, including held and returned stock. Includes EDD pending today; these columns are not additive." : header === "Other / pending" ? "Assigned shipments without a confirmed outcome. Included in Assigned, separate from delivered, failed, rejected and on-road." : header === DSR_HEADERS.failed ? "Amazon delivery-failed outcome: the operational attempted count. Rejections remain separate." : header === DSR_HEADERS.oor ? "Red: more than 50% still on road from 1 pm IST, based on the station snapshot time." : undefined} onClick={() => setSorts(previous => ({ ...previous, [sortKey]: { header, direction: sort.header === header && sort.direction === "desc" ? "asc" : "desc" } }))}>{header}<span aria-hidden="true">{sort.header === header ? sort.direction === "asc" ? "↑" : "↓" : "↕"}</span></button>
            </th>)}</tr></thead>
            <tbody>{report.rows.slice(0, report.rows.length - report.totalRows).map((row, i) => <tr key={`${report.rowStations[i]}-${i}`} className={report.groupStarts[i] ? s.groupStart : undefined}>
              {row.map((cell, column) => {
                const header = report.headers[column];
                const metric = ({ [STATION_DSR_PENDING_HEADER]: "eddPending", [STATION_DSR_PHYSICAL_HEADER]: "physicalAtStation", Assigned: "assigned", Delivered: "delivered", "Delivery Failed": "failed", "Delivery Rejected": "rejected", "Out on Road": "onRoad", "Other / pending": "other" } as Record<string, StationDsrMetric>)[header];
                const stationCode = report.rowStations[i];
                const stationMetric = view === "dsr" && level === "station" && metric && cell.text !== "—";
                return <td key={column} style={{ background: cell.bg, color: cell.color, textAlign: cell.align, fontWeight: cell.bold ? 650 : undefined }}>
                  {((header === "Station" && cell.text) || (singleStation && !report.headers.includes("Station") && column === 0 && stationCode)) ? <button type="button" className={s.stationBtn} onClick={() => openStationPanel(stationCode)}>{cell.text}</button>
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
              <button type="button" className={s.primary} disabled={stationShareBusy !== null} onClick={() => void shareStation(true)}>
                {stationShareBusy === "share" ? <Loader2 size={14} className="spin" /> : <Share2 size={14} />} WhatsApp
              </button>
              {panelMode === "tids" ? (
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
                      <strong>{selected.board.pickupDonePct}%</strong>
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
                  {ageingMode === "week" ? (() => {
                    const local = ageingStateWeekPivot([selected], collectAgeingWeeks([selected]));
                    const grid = `minmax(88px, 1.4fr) ${local.columns.flatMap(() => ["minmax(48px, 0.7fr)", "minmax(64px, 1fr)"]).join(" ")} minmax(48px, 0.7fr) minmax(72px, 1fr)`;
                    return (
                      <>
                        <div className={s.shareColsWide} style={{ gridTemplateColumns: grid }}>
                          <span>State</span>
                          {local.columns.flatMap((col) => [<span key={`${col}-c`}>{col} #</span>, <span key={`${col}-a`}>{col} ₹</span>])}
                          <span>Total #</span>
                          <span>Total ₹</span>
                        </div>
                        <div className={s.shareRows}>
                          {local.rows.map((row) => (
                            <div key={row.state} className={s.shareRowWide} style={{ gridTemplateColumns: grid }}>
                              <span>{row.state}</span>
                              {local.columns.flatMap((col) => [
                                <strong key={`${col}-c`}>{row.cells[col]?.count ? count(row.cells[col].count) : ""}</strong>,
                                <strong key={`${col}-a`}>{row.cells[col]?.amount ? inr(row.cells[col].amount) : ""}</strong>,
                              ])}
                              <strong>{count(row.total.count)}</strong>
                              <strong>{inr(row.total.amount)}</strong>
                            </div>
                          ))}
                          <div className={`${s.shareRowWide} ${s.shareTotal}`} style={{ gridTemplateColumns: grid }}>
                            <span>Grand Total</span>
                            {local.columns.flatMap((col) => [
                              <strong key={`${col}-c`}>{count(local.columnTotals[col]?.count ?? 0)}</strong>,
                              <strong key={`${col}-a`}>{inr(local.columnTotals[col]?.amount ?? 0)}</strong>,
                            ])}
                            <strong>{count(local.grandTotal.count)}</strong>
                            <strong>{inr(local.grandTotal.amount)}</strong>
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
                    <strong>{view === "premium" ? "Premium DOT" : view === "standard" ? "Standard DOT" : view === "zero" ? "Zero deliveries" : "DA DSR"} · {selected.stationCode}</strong>
                    <small>{formatOpsDate(payload.businessDate, payload.businessDate)} · DropX Logistics</small>
                  </div>
                  <div className={s.shareColsWide}>
                    <span>{DSR_HEADERS.da}</span>
                    <span>{DSR_HEADERS.total}</span>
                    <span>{DSR_HEADERS.delivered}</span>
                    <span>{DSR_HEADERS.oor}</span>
                    <span>{DSR_HEADERS.failed}</span>
                    <span>{DSR_HEADERS.rejected}</span>
                    <span>{DSR_HEADERS.dsrPct}</span>
                  </div>
                  <div className={`${s.shareRows} ${s.shareRowsScroll}`}>
                    {[...daDsrForView(selected.board, view)].sort((a, b) => view === "zero" ? b.oor - a.oor : b.dsrPct - a.dsrPct).map((da) => (
                      <div key={da.driverId} className={s.shareRowWide}>
                        <span title={da.driverName || da.driverId}>{da.driverName || da.driverId}</span>
                        <strong>{da.total}</strong>
                        <strong>{da.delivered}</strong>
                        <strong title="Red: more than 50% still on road in a snapshot taken from 1 pm IST onward." style={{ color: oorTextColor(da.oor, da.total, selected.fetchedAt) }}>{da.oor || 0}</strong>
                        <strong>{da.failed || 0}</strong>
                        <strong>{da.rejected || 0}</strong>
                        <strong style={{ background: dsrHeatColor(da.dsrPct), color: dsrPctTextColor(da.dsrPct) }}>{da.dsrPct}%</strong>
                      </div>
                    ))}
                    {(() => {
                      const das = daDsrForView(selected.board, view);
                      if (!das.length) {
                        return <p className={s.empty}>{view === "zero" ? "No zero-delivery DAs" : view === "premium" || view === "standard" ? `No ${view === "premium" ? "Premium" : "Standard"} DOT rows yet — Refresh` : "No DA DSR yet — Refresh"}</p>;
                      }
                      const tot = sumDaDsr(das);
                      return (
                        <div className={`${s.shareRowWide} ${s.shareTotal}`}>
                          <span>Grand Total · {tot.daCount} DA{tot.daCount === 1 ? "" : "s"}</span>
                          <strong>{tot.total}</strong>
                          <strong>{tot.delivered}</strong>
                          <strong>{tot.oor}</strong>
                          <strong>{tot.failed}</strong>
                          <strong>{tot.rejected}</strong>
                          <strong style={{ background: dsrHeatColor(tot.dsrPct), color: dsrPctTextColor(tot.dsrPct) }}>{tot.dsrPct}%</strong>
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
                    {tids.map((row) => <button type="button" className={s.tidTrack} key={row.trackingId} onClick={() => setOpenTrackingId(row.trackingId)}><code>{row.trackingId}{row.status ? ` · ${row.status}` : ""}</code><span>Track</span></button>)}
                  </div>
                )}
              </div>
            ) : null}
          </aside>
        </div>
      ) : null}
      <TrackingDetailModal trackingId={openTrackingId} stationHint={selected?.stationCode} onClose={() => setOpenTrackingId(null)} />
    </div>
  );
}
