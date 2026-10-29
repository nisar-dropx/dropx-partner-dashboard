"use client";

import { useMemo, useState } from "react";
import { Download, ImageDown, ListOrdered, Loader2, RefreshCw, Share2, X } from "lucide-react";
import type { EddNetworkRunStatus, LoadFlashBoardNetwork } from "@/lib/ops-pulse/edd-worker";
import { formatOpsDate, formatOpsDateTime } from "@/lib/ops-pulse/date-format";
import {
  boardDayLabel,
  CRETURN_DISPLAY,
  CRETURN_SHORT,
  collectEddDates,
  dsrHeatColor,
  eddPivot,
  filterStationsByRegion,
  groupStationsByRegion,
  heatColor,
  pickupPctColor,
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

type TidRow = {
  trackingId: string;
  status: string;
  edd: string;
  driverId: string;
  driverName: string;
};

function asView(value: string | undefined): StationBoardView {
  const key = String(value || "edd").toLowerCase().replace(/[^a-z]/g, "");
  if (key === "creturn") return "creturn";
  if (key === "dsr" || key === "dadsr") return "dsr";
  if (key === "zero" || key === "zerodeliveries") return "zero";
  return "edd";
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
    return { title: `C-Return · ${regionLabel}`, subtitle, headers, rows, footerNote: "Ops Pulse Station board" };
  }

  const zeroOnly = view === "zero";
  const headers = ["Station", "DA", "Del", "Fail", "Rej", "OOR", "Total", "DSR%"];
  const rows: BoardShareCell[][] = [];
  for (const station of stations) {
    const das = zeroOnly ? station.board.daDsr.filter((da) => da.delivered === 0) : station.board.daDsr;
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
    rows.push([{ text: "Grand Total", bold: true, align: "left" }, { text: String(row?.total ?? 0), bold: true, align: "right" }]);
    return { title: `EDD · ${label}`, subtitle, headers: ["Promised date", "Packages"], rows, footerNote: "Ops Pulse Station board" };
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
  return {
    title: `${zeroOnly ? "Zero deliveries" : "DA DSR"} · ${label}`,
    subtitle,
    headers: ["DA", "Del", "Fail", "Rej", "OOR", "Total", "DSR%"],
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
  const [stationShareBusy, setStationShareBusy] = useState<BlockBusy>(null);

  const stations = useMemo(() => filterStationsByRegion(payload.stations, region), [payload.stations, region]);
  const groups = useMemo(() => groupStationsByRegion(stations), [stations]);
  const dates = useMemo(() => collectEddDates(stations, payload.businessDate), [stations, payload.businessDate]);
  const pivot = useMemo(() => eddPivot(stations, dates), [stations, dates]);
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

  function syncUrl(nextView: StationBoardView, nextRegion: StationBoardRegionId | "ALL") {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("view", nextView);
    url.searchParams.set("date", payload.businessDate);
    if (nextRegion === "ALL") url.searchParams.delete("region");
    else url.searchParams.set("region", nextRegion);
    window.history.replaceState(null, "", url.toString());
  }

  async function reloadBoard() {
    const response = await fetch(`/api/ops-pulse/edd/board?date=${encodeURIComponent(payload.businessDate)}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Unable to refresh the station board.");
    const next = (await response.json()) as LoadFlashBoardNetwork;
    setPayload(next);
    setRun(next.run);
  }

  async function runBackfillLoop() {
    let startIndex = 0;
    let guard = 0;
    while (guard < 120) {
      guard += 1;
      const params = new URLSearchParams({
        days: "7",
        startIndex: String(startIndex),
        date: payload.businessDate,
      });
      const response = await fetch(`/api/ops-pulse/edd/board/backfill?${params}`, { method: "POST", cache: "no-store" });
      const body = await response.json().catch(() => ({})) as { nextIndex?: number; total?: number; done?: boolean; advanced?: number; error?: string };
      if (!response.ok) throw new Error(String(body.error ?? "Board backfill failed."));
      startIndex = Number(body.nextIndex ?? startIndex) || startIndex;
      const total = Number(body.total ?? 0) || 0;
      setBackfillNote(total ? `Pulling C-Return / DSR for last 7 days · ${Math.min(startIndex, total)}/${total}` : "Pulling C-Return / DSR…");
      if (body.done || !body.advanced) break;
      await reloadBoard().catch(() => undefined);
    }
  }

  async function refresh() {
    setBusy("refresh");
    setError(null);
    setBackfillNote("Starting Ops Live refresh + last 7 days board pull…");
    try {
      await fetch("/api/ops-pulse/edd/flash/network/refresh-all", { method: "POST", cache: "no-store" });
      await runBackfillLoop();
      await reloadBoard();
      setBackfillNote("Last 7 days board data updated.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed.");
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
      const table = buildShareTable(view, opts.blockStations, payload.businessDate, opts.label);
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
      const table = buildStationShareTable(view, selected, payload.businessDate, stationNames[selected.stationCode] || "");
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
  }

  function closeStationPanel() {
    setOpenStation(null);
    setTids(null);
    setTidsError(null);
  }

  async function loadTids() {
    if (!selected) return;
    setTidsBusy(true);
    setTidsError(null);
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
    } catch (err) {
      setTidsError(err instanceof Error ? err.message : "Unable to load tracking IDs.");
      setTids(null);
    } finally {
      setTidsBusy(false);
    }
  }

  const viewTabs = [
    ["edd", "EDD"],
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
            {payload.asOf ? ` · updated ${formatOpsDateTime(payload.asOf, payload.asOf)}` : ""}
            {run?.status === "running" ? " · Ops Live refresh running" : ""}
          </p>
        </div>

        <div className={s.segment} aria-label="Business date">
          <span className={s.dateChip} aria-current="page">{boardDayLabel(payload.businessDate)}</span>
        </div>

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

      {view === "creturn" ? (
        <section className={s.panel}>
          <div className={s.panelHead}>
            <h3>C-Return · station status</h3>
            <span>Click a station for shareable card + TIDs</span>
          </div>
          {!stations.length ? <p className={s.empty}>No stations in this region.</p> : groups.map((group) => (
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
                </table>
              </div>
            </div>
          ))}
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
                      <th>DA</th>
                      <th>Del</th>
                      <th>Fail</th>
                      <th>Rej</th>
                      <th>OOR</th>
                      <th>Total</th>
                      <th>DSR%</th>
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
              <button type="button" disabled={tidsBusy} onClick={() => void loadTids()}>
                {tidsBusy ? <Loader2 size={14} className="spin" /> : <ListOrdered size={14} />} View TIDs
              </button>
            </div>

            {view === "creturn" ? (
              <table className={`${s.table} ${s.stationCard}`}>
                <tbody>
                  {CRETURN_DISPLAY.map((status) => (
                    <tr key={status}>
                      <td>{CRETURN_SHORT[status]}</td>
                      <td>{count(selected.board.cReturn[status] ?? 0)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>Grand Total</td>
                    <td>{count(selected.board.cReturnTotal)}</td>
                  </tr>
                  <tr>
                    <td>Pickup Done %</td>
                    <td className={s.heat} style={{ background: pickupPctColor(selected.board.pickupDonePct) }}>{selected.board.pickupDonePct}%</td>
                  </tr>
                </tbody>
              </table>
            ) : null}

            {view === "edd" ? (
              <table className={`${s.table} ${s.stationCard}`}>
                <thead>
                  <tr><th>Promised date</th><th>Packages</th></tr>
                </thead>
                <tbody>
                  {(dates.length ? dates : collectEddDates([selected], payload.businessDate)).map((d) => {
                    const value = selected.board.eddByDate[d] ?? 0;
                    const max = Math.max(...Object.values(selected.board.eddByDate), 1);
                    return (
                      <tr key={d}>
                        <td>{boardDayLabel(d)}</td>
                        <td className={value ? s.heat : undefined} style={value ? { background: heatColor(value, max) } : undefined}>
                          {count(value)}
                        </td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td>Grand Total</td>
                    <td>{count(Object.values(selected.board.eddByDate).reduce((a, b) => a + b, 0))}</td>
                  </tr>
                </tbody>
              </table>
            ) : null}

            {view === "dsr" || view === "zero" ? (
              <table className={`${s.table} ${s.zero} ${s.stationCard}`}>
                <thead>
                  <tr>
                    <th>DA</th><th>Del</th><th>Fail</th><th>Rej</th><th>OOR</th><th>Total</th><th>DSR%</th>
                  </tr>
                </thead>
                <tbody>
                  {(view === "zero" ? selected.board.daDsr.filter((da) => da.delivered === 0) : selected.board.daDsr).map((da) => (
                    <tr key={da.driverId}>
                      <td title={da.driverName || da.driverId}>{da.driverName || da.driverId}</td>
                      <td>{da.delivered}</td>
                      <td>{da.failed || 0}</td>
                      <td>{da.rejected || 0}</td>
                      <td>{da.oor || 0}</td>
                      <td>{da.total}</td>
                      <td className={s.heat} style={{ background: dsrHeatColor(da.dsrPct) }}>{da.dsrPct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}

            {tidsError ? <p className={s.error}>{tidsError}</p> : null}
            {tids ? (
              <div className={s.tidBlock}>
                <div className={s.panelHead}>
                  <h3>Tracking IDs · {tids.length.toLocaleString("en-IN")}</h3>
                  <span>{view === "creturn" ? "C-Return" : view === "edd" ? "EDD backlog" : view === "zero" ? "Zero-delivery DAs" : "DSR"}</span>
                </div>
                {!tids.length ? (
                  <p className={s.empty}>No tracking IDs for this station yet. Try Refresh 7d.</p>
                ) : (
                  <div className={s.scroll}>
                    <table className={`${s.table} ${s.tids}`}>
                      <thead>
                        <tr>
                          <th>TID</th>
                          <th>Status</th>
                          {view === "edd" ? <th>EDD</th> : null}
                          {view !== "edd" && view !== "creturn" ? <th>DA</th> : null}
                        </tr>
                      </thead>
                      <tbody>
                        {tids.map((row) => (
                          <tr key={row.trackingId}>
                            <td>{row.trackingId}</td>
                            <td>{row.status || "—"}</td>
                            {view === "edd" ? <td>{row.edd ? boardDayLabel(row.edd) : "—"}</td> : null}
                            {view !== "edd" && view !== "creturn" ? <td>{row.driverName || row.driverId || "—"}</td> : null}
                          </tr>
                        ))}
                      </tbody>
                    </table>
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
