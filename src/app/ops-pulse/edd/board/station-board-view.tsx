"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Download, ImageDown, Loader2, RefreshCw, Share2 } from "lucide-react";
import type { EddNetworkRunStatus, LoadFlashBoardNetwork } from "@/lib/ops-pulse/edd-worker";
import { formatOpsDate, formatOpsDateTime } from "@/lib/ops-pulse/date-format";
import {
  cReturnStatuses,
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

function asView(value: string | undefined): StationBoardView {
  if (value === "creturn" || value === "zero" || value === "edd") return value;
  return "edd";
}

function asRegion(value: string | undefined): StationBoardRegionId | "ALL" {
  const key = String(value || "ALL").toUpperCase();
  if (key === "KL" || key === "AP" || key === "ODCG" || key === "OTHER") return key;
  return "ALL";
}

function count(n: number) {
  return n ? n.toLocaleString("en-IN") : "";
}

function shortDate(date: string) {
  return date.slice(5);
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
    const headers = ["Station", ...dates.map(shortDate), "Total"];
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
    return { title: "EDD by promised date", subtitle, headers, rows, footerNote: "Ops Pulse Station board · share to WhatsApp" };
  }

  if (view === "creturn") {
    const headers = ["Station", "Status", "Count", "Pickup %"];
    const rows: BoardShareCell[][] = [];
    for (const station of stations) {
      const statuses = cReturnStatuses(station.board).filter((row) => row.count > 0);
      if (!statuses.length) {
        rows.push([
          { text: station.stationCode, bold: true, align: "left" },
          { text: "—", align: "left" },
          { text: "0", align: "right" },
          { text: "", align: "right" },
        ]);
        continue;
      }
      for (const row of statuses) {
        rows.push([
          { text: station.stationCode, bold: true, align: "left" },
          { text: row.status, align: "left" },
          { text: String(row.count), align: "right" },
          { text: "", align: "right" },
        ]);
      }
      rows.push([
        { text: station.stationCode, bold: true, align: "left" },
        { text: "Grand Total", bold: true, align: "left" },
        { text: String(station.board.cReturnTotal), bold: true, align: "right" },
        { text: `${station.board.pickupDonePct}%`, bold: true, bg: "#fff4bf", align: "right" },
      ]);
    }
    return { title: "C-Return", subtitle, headers, rows, footerNote: "Ops Pulse Station board · share to WhatsApp" };
  }

  const headers = ["Station", "DA's Name", "Delivered", "Failed", "Rejected", "OOR", "Total", "DSR%"];
  const rows: BoardShareCell[][] = [];
  for (const station of stations) {
    const das = station.board.daDsr.filter((da) => da.delivered === 0);
    for (const da of das) {
      rows.push([
        { text: station.stationCode, bold: true, align: "left" },
        { text: da.driverName || da.driverId, align: "left" },
        { text: String(da.delivered), align: "right" },
        { text: String(da.failed), align: "right" },
        { text: String(da.rejected), align: "right" },
        { text: String(da.oor), align: "right" },
        { text: String(da.total), align: "right" },
        { text: `${da.dsrPct}%`, bold: true, bg: dsrHeatColor(da.dsrPct), align: "right" },
      ]);
    }
  }
  return { title: "Zero deliveries (DSR 0%)", subtitle, headers, rows, footerNote: "Ops Pulse Station board · share to WhatsApp" };
}

export function StationBoardView({ initial, stationNames = {}, initialRegion, initialView }: Props) {
  const [payload, setPayload] = useState(initial);
  const [run, setRun] = useState<EddNetworkRunStatus | null>(initial.run);
  const [view, setView] = useState<StationBoardView>(() => asView(initialView));
  const [region, setRegion] = useState<StationBoardRegionId | "ALL">(() => asRegion(initialRegion));
  const [busy, setBusy] = useState<"refresh" | "download" | "image" | "share" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zeroOnly, setZeroOnly] = useState(true);

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

  async function refresh() {
    setBusy("refresh");
    setError(null);
    try {
      await fetch("/api/ops-pulse/edd/flash/network/refresh-all", { method: "POST", cache: "no-store" });
      const response = await fetch(`/api/ops-pulse/edd/board?date=${encodeURIComponent(payload.businessDate)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Unable to refresh the station board.");
      const next = (await response.json()) as LoadFlashBoardNetwork;
      setPayload(next);
      setRun(next.run);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed.");
    } finally {
      setBusy(null);
    }
  }

  async function onDownload() {
    setBusy("download");
    setError(null);
    try {
      await downloadWorkbook(payload.businessDate, view === "zero" ? "zero" : view, region);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed.");
    } finally {
      setBusy(null);
    }
  }

  async function onImage(share: boolean) {
    setBusy(share ? "share" : "image");
    setError(null);
    try {
      const table = buildShareTable(view, stations, payload.businessDate, regionLabel);
      if (!table.rows.length) throw new Error("Nothing to share for this view.");
      const fileName = `station-board-${payload.businessDate}-${view}-${region.toLowerCase()}`;
      if (share) {
        const files = await renderBoardShareImages(table);
        const result = await shareBoardImages(files, table.title, `${table.title} · ${table.subtitle}`);
        if (result === "downloaded") await downloadBoardShare(table, fileName);
      } else {
        await downloadBoardShare(table, fileName);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the image.");
    } finally {
      setBusy(null);
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
            {run?.status === "running" ? " · refresh in progress" : ""}
          </p>
        </div>

        <div className={s.segment} aria-label="Business date">
          {(payload.dates.length ? payload.dates : [payload.businessDate]).slice(0, 7).map((date) => (
            <Link
              key={date}
              href={`/edd/board?date=${encodeURIComponent(date)}&view=${view}${region === "ALL" ? "" : `&region=${region}`}`}
              aria-current={date === payload.businessDate ? "page" : undefined}
              style={date === payload.businessDate ? { background: "var(--brand-dark, #de5a16)", color: "#fff", borderRadius: 9, padding: "0 12px", height: 32, display: "inline-flex", alignItems: "center", fontWeight: 650, textDecoration: "none" } : { padding: "0 12px", height: 32, display: "inline-flex", alignItems: "center", color: "var(--muted)", textDecoration: "none", fontWeight: 650 }}
            >
              {shortDate(date)}
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
            {busy === "refresh" ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Refresh
          </button>
          <button type="button" disabled={busy !== null} onClick={() => void onDownload()}>
            {busy === "download" ? <Loader2 size={14} className="spin" /> : <Download size={14} />} Excel
          </button>
          <button type="button" disabled={busy !== null} onClick={() => void onImage(false)}>
            {busy === "image" ? <Loader2 size={14} className="spin" /> : <ImageDown size={14} />} Image
          </button>
          <button type="button" className={s.primary} disabled={busy !== null} onClick={() => void onImage(true)}>
            {busy === "share" ? <Loader2 size={14} className="spin" /> : <Share2 size={14} />} WhatsApp
          </button>
        </div>
      </div>

      {error ? <p className={s.error}>{error}</p> : null}

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
            <span>Heatmap like the Excel pivot · red = high volume</span>
          </div>
          {!stations.length ? <p className={s.empty}>No stations in this region.</p> : (
            groups.map((group) => {
              const local = eddPivot(group.stations, dates);
              return (
                <div key={group.id}>
                  <p className={s.region}>{group.label}</p>
                  <div className={s.scroll}>
                    <table className={s.table}>
                      <thead>
                        <tr>
                          <th>Station</th>
                          {dates.map((d) => <th key={d}>{shortDate(d)}</th>)}
                          <th>Grand Total</th>
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
                                  {count(value)}
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
            })
          )}
        </section>
      ) : null}

      {view === "creturn" ? (
        <section className={s.panel}>
          <div className={s.panelHead}>
            <h3>C-Return · station status</h3>
            <span>Pickup Done % highlighted for WhatsApp-ready cards</span>
          </div>
          {!stations.length ? <p className={s.empty}>No stations in this region.</p> : (
            groups.map((group) => (
              <div key={group.id}>
                <p className={s.region}>{group.label}</p>
                <div className={s.cards}>
                  {group.stations.map((station) => {
                    const statuses = cReturnStatuses(station.board);
                    return (
                      <article key={station.stationCode} className={s.card}>
                        <div className={s.cardHead}>
                          <strong>{station.stationCode}</strong>
                          <span>{stationNames[station.stationCode] || "Station"}</span>
                        </div>
                        <table>
                          <tbody>
                            {statuses.map((row) => (
                              <tr key={row.status}>
                                <td>{row.status}</td>
                                <td>{row.count ? row.count.toLocaleString("en-IN") : ""}</td>
                              </tr>
                            ))}
                            <tr>
                              <td><strong>Grand Total</strong></td>
                              <td><strong>{station.board.cReturnTotal.toLocaleString("en-IN")}</strong></td>
                            </tr>
                            <tr className={s.pct}>
                              <td>Pickup Done %</td>
                              <td>{station.board.pickupDonePct}%</td>
                            </tr>
                          </tbody>
                        </table>
                      </article>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </section>
      ) : null}

      {view === "zero" ? (
        <section className={s.panel}>
          <div className={s.panelHead}>
            <h3>Zero deliveries · DA DSR</h3>
            <span>
              <label className={s.muted}>
                <input type="checkbox" checked={zeroOnly} onChange={(e) => setZeroOnly(e.target.checked)} /> Show only DAs with 0 delivered
              </label>
            </span>
          </div>
          {!stations.length ? <p className={s.empty}>No stations in this region.</p> : (
            groups.map((group) => (
              <div key={group.id}>
                <p className={s.region}>{group.label}</p>
                <div className={s.scroll}>
                  <table className={s.table}>
                    <thead>
                      <tr>
                        <th>Station</th>
                        <th style={{ textAlign: "left" }}>DA&apos;s Name</th>
                        <th>Delivered</th>
                        <th>Failed</th>
                        <th>Rejected</th>
                        <th>OOR</th>
                        <th>Grand Total</th>
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
                              <td colSpan={7} className={s.muted} style={{ textAlign: "left" }}>{zeroOnly ? "No zero-delivery DAs" : "No DA DSR rows yet"}</td>
                            </tr>,
                          ];
                        }
                        return rows.map((da) => (
                          <tr key={`${station.stationCode}-${da.driverId}`}>
                            <td>{station.stationCode}</td>
                            <td style={{ textAlign: "left", position: "static", fontWeight: 500 }}>{da.driverName || da.driverId}</td>
                            <td>{da.delivered}</td>
                            <td>{da.failed || ""}</td>
                            <td>{da.rejected || ""}</td>
                            <td>{da.oor || ""}</td>
                            <td>{da.total}</td>
                            <td className={s.heat} style={{ background: dsrHeatColor(da.dsrPct) }}>{da.dsrPct}%</td>
                          </tr>
                        ));
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
          )}
        </section>
      ) : null}

      {!pivot.grandTotal && view === "edd" && stations.some((row) => row.hasSnapshot) ? (
        <p className={s.muted}>EDD date cells fill after the next Ops Live hourly refresh writes board summaries.</p>
      ) : null}
    </div>
  );
}
