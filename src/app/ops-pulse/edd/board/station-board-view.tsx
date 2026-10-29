"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Download, ImageDown, Loader2, RefreshCw, Share2 } from "lucide-react";
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

function asView(value: string | undefined): StationBoardView {
  if (value === "creturn" || value === "zero" || value === "edd") return value;
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
  zeroOnly: boolean,
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
        text: station.board.cReturn[status] ? String(station.board.cReturn[status]) : "",
        align: "right" as const,
      })),
      { text: String(station.board.cReturnTotal || 0), bold: true, align: "right" },
      { text: `${station.board.pickupDonePct}%`, bold: true, bg: "#fff4bf", align: "right" },
    ]);
    return { title: `C-Return · ${regionLabel}`, subtitle, headers, rows, footerNote: "Ops Pulse Station board" };
  }

  const headers = ["Station", "DA", "Del", "Fail", "Rej", "OOR", "Total", "DSR%"];
  const rows: BoardShareCell[][] = [];
  for (const station of stations) {
    const das = zeroOnly ? station.board.daDsr.filter((da) => da.delivered === 0) : station.board.daDsr;
    for (const da of das) {
      rows.push([
        { text: station.stationCode, bold: true, align: "left" },
        { text: da.driverName || da.driverId, align: "left" },
        { text: String(da.delivered), align: "right" },
        { text: String(da.failed || ""), align: "right" },
        { text: String(da.rejected || ""), align: "right" },
        { text: String(da.oor || ""), align: "right" },
        { text: String(da.total), align: "right" },
        { text: `${da.dsrPct}%`, bold: true, bg: dsrHeatColor(da.dsrPct), align: "right" },
      ]);
    }
  }
  return { title: `Zero deliveries · ${regionLabel}`, subtitle, headers, rows, footerNote: "Ops Pulse Station board" };
}

export function StationBoardView({ initial, stationNames = {}, initialRegion, initialView }: Props) {
  const [payload, setPayload] = useState(initial);
  const [run, setRun] = useState<EddNetworkRunStatus | null>(initial.run);
  const [view, setView] = useState<StationBoardView>(() => asView(initialView));
  const [region, setRegion] = useState<StationBoardRegionId | "ALL">(() => asRegion(initialRegion));
  const [busy, setBusy] = useState<"refresh" | "download" | "image" | "share" | null>(null);
  const [blockBusy, setBlockBusy] = useState<Record<string, BlockBusy>>({});
  const [error, setError] = useState<string | null>(null);
  const [zeroOnly, setZeroOnly] = useState(true);
  const [backfillNote, setBackfillNote] = useState("");

  const stations = useMemo(() => filterStationsByRegion(payload.stations, region), [payload.stations, region]);
  const groups = useMemo(() => groupStationsByRegion(stations), [stations]);
  const dates = useMemo(() => collectEddDates(stations, payload.businessDate), [stations, payload.businessDate]);
  const pivot = useMemo(() => eddPivot(stations, dates), [stations, dates]);

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
      const table = buildShareTable(view, opts.blockStations, payload.businessDate, opts.label, zeroOnly);
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
          {(payload.dates.length ? payload.dates : [payload.businessDate]).slice(0, 7).map((date) => (
            <Link
              key={date}
              href={`/edd/board?date=${encodeURIComponent(date)}&view=${view}${region === "ALL" ? "" : `&region=${region}`}`}
              aria-current={date === payload.businessDate ? "page" : undefined}
            >
              {boardDayLabel(date)}
            </Link>
          ))}
        </div>

        <div className={s.segment} role="tablist" aria-label="Report">
          {([
            ["edd", "EDD"],
            ["creturn", "C-Return"],
            ["zero", "Zero deliveries"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-pressed={view === key}
              onClick={() => {
                setView(key);
                syncUrl(key, region);
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
            <span>Share each region block separately</span>
          </div>
          {!stations.length ? <p className={s.empty}>No stations in this region.</p> : groups.map((group) => {
            const local = eddPivot(group.stations, dates);
            const busyKey = blockBusy[group.id];
            return (
              <div key={group.id}>
                <div className={s.region}>
                  <span>{group.label}</span>
                  <div className={s.regionActions}>
                    <button type="button" disabled={busy !== null || Boolean(busyKey)} onClick={() => void shareBlock({ key: group.id, label: group.label, blockStations: group.stations, share: false, scope: "block" })}>
                      {busyKey === "image" ? <Loader2 size={12} className="spin" /> : <ImageDown size={12} />} Image
                    </button>
                    <button type="button" disabled={busy !== null || Boolean(busyKey)} onClick={() => void shareBlock({ key: group.id, label: group.label, blockStations: group.stations, share: true, scope: "block" })}>
                      {busyKey === "share" ? <Loader2 size={12} className="spin" /> : <Share2 size={12} />} WhatsApp
                    </button>
                  </div>
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
                        <tr key={row.stationCode}>
                          <td title={stationNames[row.stationCode] || row.stationCode}>{row.stationCode}</td>
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
            <span>Compact matrix · yellow = pickup %</span>
          </div>
          {!stations.length ? <p className={s.empty}>No stations in this region.</p> : groups.map((group) => {
            const busyKey = blockBusy[group.id];
            return (
              <div key={group.id}>
                <div className={s.region}>
                  <span>{group.label}</span>
                  <div className={s.regionActions}>
                    <button type="button" disabled={busy !== null || Boolean(busyKey)} onClick={() => void shareBlock({ key: group.id, label: group.label, blockStations: group.stations, share: false, scope: "block" })}>
                      {busyKey === "image" ? <Loader2 size={12} className="spin" /> : <ImageDown size={12} />} Image
                    </button>
                    <button type="button" disabled={busy !== null || Boolean(busyKey)} onClick={() => void shareBlock({ key: group.id, label: group.label, blockStations: group.stations, share: true, scope: "block" })}>
                      {busyKey === "share" ? <Loader2 size={12} className="spin" /> : <Share2 size={12} />} WhatsApp
                    </button>
                  </div>
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
                        <tr key={station.stationCode}>
                          <td title={stationNames[station.stationCode] || station.stationCode}>{station.stationCode}</td>
                          {CRETURN_DISPLAY.map((status) => {
                            const value = station.board.cReturn[status] ?? 0;
                            return <td key={status}>{count(value)}</td>;
                          })}
                          <td>{count(station.board.cReturnTotal)}</td>
                          <td className={s.heat} style={{ background: "#fff4bf" }}>{station.board.pickupDonePct}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </section>
      ) : null}

      {view === "zero" ? (
        <section className={s.panel}>
          <div className={s.panelHead}>
            <h3>Zero deliveries · DA DSR</h3>
            <span>
              <label className={s.muted}>
                <input type="checkbox" checked={zeroOnly} onChange={(e) => setZeroOnly(e.target.checked)} /> Only 0 delivered
              </label>
            </span>
          </div>
          {!stations.length ? <p className={s.empty}>No stations in this region.</p> : groups.map((group) => {
            const busyKey = blockBusy[group.id];
            return (
              <div key={group.id}>
                <div className={s.region}>
                  <span>{group.label}</span>
                  <div className={s.regionActions}>
                    <button type="button" disabled={busy !== null || Boolean(busyKey)} onClick={() => void shareBlock({ key: group.id, label: group.label, blockStations: group.stations, share: false, scope: "block" })}>
                      {busyKey === "image" ? <Loader2 size={12} className="spin" /> : <ImageDown size={12} />} Image
                    </button>
                    <button type="button" disabled={busy !== null || Boolean(busyKey)} onClick={() => void shareBlock({ key: group.id, label: group.label, blockStations: group.stations, share: true, scope: "block" })}>
                      {busyKey === "share" ? <Loader2 size={12} className="spin" /> : <Share2 size={12} />} WhatsApp
                    </button>
                  </div>
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
                        const rows = zeroOnly ? station.board.daDsr.filter((da) => da.delivered === 0) : station.board.daDsr;
                        if (!rows.length) {
                          return [
                            <tr key={`${station.stationCode}-empty`}>
                              <td>{station.stationCode}</td>
                              <td colSpan={7} className={s.muted}>{zeroOnly ? "No zero-delivery DAs" : "No DA DSR yet — Refresh 7d"}</td>
                            </tr>,
                          ];
                        }
                        return rows.map((da) => (
                          <tr key={`${station.stationCode}-${da.driverId}`}>
                            <td>{station.stationCode}</td>
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
            );
          })}
        </section>
      ) : null}

      {!pivot.grandTotal && view === "edd" && stations.some((row) => row.hasSnapshot) ? (
        <p className={s.note}>If cells are empty, click <strong>Refresh 7d</strong> to pull board data for the last week.</p>
      ) : null}
    </div>
  );
}
