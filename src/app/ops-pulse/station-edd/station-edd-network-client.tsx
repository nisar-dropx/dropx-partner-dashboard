"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Download, Loader2, RefreshCw, Search } from "lucide-react";
import type { EddNetworkRunStatus, EddPerformanceNetworkStation } from "@/lib/ops-pulse/edd-worker";
import type { EddStationOption } from "@/lib/ops-pulse/edd-stations";
import { stationEddDeliveryProgress, stationEddTotal } from "@/lib/ops-pulse/station-edd";

type SortColumn = "stationCode" | "total" | "atStation" | "assigned" | "delivered" | "held" | "returned" | "progress";
type SortDir = "asc" | "desc";

const PAGE_SIZE = 15;
const RUN_POLL_MS = 15000;
const COLUMNS: Array<{ key: SortColumn; label: string; align?: "num" }> = [
  { key: "stationCode", label: "Station" },
  { key: "total", label: "EDD today", align: "num" },
  { key: "atStation", label: "At station EDD", align: "num" },
  { key: "assigned", label: "Assigned / dispatched", align: "num" },
  { key: "delivered", label: "Delivered", align: "num" },
  { key: "held", label: "On road / held", align: "num" },
  { key: "returned", label: "Returned", align: "num" },
  { key: "progress", label: "Delivery progress", align: "num" }
];

function formatFetchedAt(value: string | null) {
  if (!value) return "Never refreshed";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function sortValue(row: EddPerformanceNetworkStation, column: SortColumn): string | number {
  switch (column) {
    case "stationCode": return row.stationCode;
    case "total": return stationEddTotal(row);
    case "atStation": return row.yetToDispatch;
    case "assigned": return row.assigned;
    case "delivered": return row.delivered;
    case "held": return row.held;
    case "returned": return row.returned;
    case "progress": return stationEddDeliveryProgress(row);
    default: return 0;
  }
}

function compareValues(a: string | number, b: string | number, direction: SortDir) {
  const factor = direction === "asc" ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return (a - b) * factor;
  return String(a).localeCompare(String(b)) * factor;
}

async function readJson<T>(path: string, method: "GET" | "POST" = "GET"): Promise<T> {
  const response = await fetch(new URL(path, window.location.origin).toString(), {
    method,
    headers: { Accept: "application/json" },
    cache: "no-store"
  });
  const raw = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(raw.error ?? `Request failed (${response.status}).`));
  return raw as T;
}

export function StationEddNetworkClient({
  stations,
  initialNetwork,
  initialRun
}: {
  stations: EddStationOption[];
  initialNetwork: EddPerformanceNetworkStation[];
  initialRun: EddNetworkRunStatus | null;
}) {
  const nameByCode = useMemo(() => new Map(stations.map((station) => [station.code, station.name])), [stations]);
  const [rows, setRows] = useState(initialNetwork);
  const [run, setRun] = useState(initialRun);
  const [search, setSearch] = useState("");
  const [sortColumn, setSortColumn] = useState<SortColumn>("atStation");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(1);
  const [refreshingCode, setRefreshingCode] = useState<string | null>(null);
  const [startingSweep, setStartingSweep] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const totals = useMemo(() => rows.reduce((total, row) => ({
    due: total.due + stationEddTotal(row),
    atStation: total.atStation + row.yetToDispatch,
    assigned: total.assigned + row.assigned,
    delivered: total.delivered + row.delivered,
    held: total.held + row.held,
    returned: total.returned + row.returned,
    reporting: total.reporting + (row.hasSnapshot ? 1 : 0)
  }), { due: 0, atStation: 0, assigned: 0, delivered: 0, held: 0, returned: 0, reporting: 0 }), [rows]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((row) => row.stationCode.toLowerCase().includes(term) || (nameByCode.get(row.stationCode) ?? "").toLowerCase().includes(term));
  }, [nameByCode, rows, search]);
  const sorted = useMemo(() => [...filtered].sort((a, b) => compareValues(sortValue(a, sortColumn), sortValue(b, sortColumn), sortDir)), [filtered, sortColumn, sortDir]);
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pagedRows = useMemo(() => sorted.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE), [currentPage, sorted]);

  useEffect(() => {
    if (run?.status !== "running") {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    pollRef.current = setInterval(() => {
      void readJson<{ stations: EddPerformanceNetworkStation[]; run: EddNetworkRunStatus | null }>("/api/ops-pulse/station-edd/network")
        .then((next) => {
          setRows(next.stations);
          setRun(next.run);
        })
        .catch(() => undefined);
    }, RUN_POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [run?.status]);

  function toggleSort(column: SortColumn) {
    setPage(1);
    if (sortColumn !== column) {
      setSortColumn(column);
      setSortDir(column === "stationCode" || column === "progress" ? "asc" : "desc");
      return;
    }
    setSortDir((current) => current === "asc" ? "desc" : "asc");
  }

  function refreshStation(stationCode: string) {
    setRefreshingCode(stationCode);
    setRowError(null);
    void readJson<{
      fetchedAt: string;
      assigned: number;
      delivered: number;
      returned: number;
      held: number;
      yetToDispatch: number;
      deliveredPct: number;
      returnedPct: number;
      heldPct: number;
    }>(`/api/ops-pulse/station-edd/refresh?stationCode=${encodeURIComponent(stationCode)}`, "POST")
      .then((fresh) => setRows((current) => current.map((row) => row.stationCode === stationCode ? {
        ...row,
        ...fresh,
        hasSnapshot: true
      } : row)))
      .catch((cause) => setRowError(cause instanceof Error ? cause.message : `Unable to refresh ${stationCode}.`))
      .finally(() => setRefreshingCode(null));
  }

  function refreshAll() {
    setStartingSweep(true);
    setRowError(null);
    void readJson<{ run: EddNetworkRunStatus | null }>("/api/ops-pulse/station-edd/network/refresh-all", "POST")
      .then((next) => setRun(next.run))
      .catch((cause) => setRowError(cause instanceof Error ? cause.message : "Unable to start the EDD refresh."))
      .finally(() => setStartingSweep(false));
  }

  const sweepRunning = run?.status === "running";
  const sweepPct = run?.stationsTotal ? Math.round((run.stationsDone / run.stationsTotal) * 100) : 0;

  return (
    <>
      <section className="edd-bucket-grid">
        <div className="edd-bucket-card static">
          <span>EDD today</span>
          <strong>{totals.due.toLocaleString("en-IN")}</strong>
          <small>{totals.reporting}/{rows.length} stations reporting</small>
        </div>
        <div className="edd-bucket-card static overdue">
          <span>Current at station</span>
          <strong>{totals.atStation.toLocaleString("en-IN")}</strong>
          <small>today's EDD · not assigned to a driver/store</small>
        </div>
        <div className="edd-bucket-card static future">
          <span>Delivered</span>
          <strong>{totals.delivered.toLocaleString("en-IN")}</strong>
          <small>completed today</small>
        </div>
        <div className="edd-bucket-card static dueToday">
          <span>On road / held</span>
          <strong>{totals.held.toLocaleString("en-IN")}</strong>
          <small>not yet delivered or returned</small>
        </div>
        <div className="edd-bucket-card static unknown">
          <span>Returned</span>
          <strong>{totals.returned.toLocaleString("en-IN")}</strong>
          <small>failed, rejected, or undeliverable</small>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Station-level EDD</h3>
            <p className="subtle">Open a station to see and download the tracking IDs behind every count.</p>
          </div>
          <div className="panel-head-actions">
            <a className="button secondary" href="/api/ops-pulse/station-edd/network/report" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Download size={16} /> Download report
            </a>
            <button className="button secondary" type="button" onClick={refreshAll} disabled={startingSweep || sweepRunning} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              {startingSweep ? <Loader2 size={16} className="edd-spin" /> : <RefreshCw size={16} />}
              {sweepRunning ? "Refresh running…" : startingSweep ? "Starting…" : "Refresh all"}
            </button>
          </div>
        </div>

        {run ? (
          <div className="panel-body edd-sweep-status">
            <div className="edd-sweep-bar"><div className="edd-sweep-bar-fill" style={{ width: `${sweepRunning ? sweepPct : 100}%` }} /></div>
            <span className="subtle">
              {sweepRunning
                ? `Refresh in progress — ${run.stationsDone}/${run.stationsTotal} stations complete.`
                : `Last refresh: ${run.stationsOk}/${run.stationsTotal} stations updated${run.finishedAt ? ` · ${formatFetchedAt(run.finishedAt)}` : ""}.`}
            </span>
          </div>
        ) : null}

        <div className="panel-body">
          <div className="edd-toolbar">
            <div style={{ position: "relative" }}>
              <Search size={15} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--muted)" }} />
              <input type="search" placeholder="Search station code or name…" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} style={{ paddingLeft: 30, minWidth: 240 }} />
            </div>
            <span className="subtle" style={{ marginLeft: "auto" }}>Showing {sorted.length} of {rows.length}</span>
          </div>
          {rowError ? <p className="subtle" style={{ color: "var(--red)", marginTop: 8 }}>{rowError}</p> : null}

          <div className="edd-table-wrap">
            <table className="edd-table">
              <thead>
                <tr>
                  {COLUMNS.map((column) => (
                    <th key={column.key} className={column.align}>
                      <button type="button" className="edd-sort-btn" onClick={() => toggleSort(column.key)}>
                        {column.label}
                        {sortColumn === column.key ? (sortDir === "asc" ? <ArrowUp size={12} className="edd-sort-icon active" /> : <ArrowDown size={12} className="edd-sort-icon active" />) : <ArrowUpDown size={12} className="edd-sort-icon" />}
                      </button>
                    </th>
                  ))}
                  <th>Last refreshed</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((row) => {
                  const name = nameByCode.get(row.stationCode);
                  const progress = stationEddDeliveryProgress(row);
                  const refreshing = refreshingCode === row.stationCode;
                  return (
                    <tr key={row.stationCode}>
                      <td>
                        <Link className="edd-station-link" href={`/station-edd/${encodeURIComponent(row.stationCode)}`} prefetch={false}>
                          <strong>{row.stationCode}</strong>{name ? <small>{name}</small> : null}
                        </Link>
                      </td>
                      <td className="num">{stationEddTotal(row).toLocaleString("en-IN")}</td>
                      <td className="num">{row.yetToDispatch ? <span className="edd-pill overdue">{row.yetToDispatch.toLocaleString("en-IN")}</span> : "—"}</td>
                      <td className="num">{row.assigned.toLocaleString("en-IN")}</td>
                      <td className="num">{row.delivered.toLocaleString("en-IN")}</td>
                      <td className="num">{row.held ? row.held.toLocaleString("en-IN") : "—"}</td>
                      <td className="num">{row.returned ? row.returned.toLocaleString("en-IN") : "—"}</td>
                      <td className="num"><strong>{row.hasSnapshot ? `${progress}%` : "—"}</strong></td>
                      <td>{row.hasSnapshot ? formatFetchedAt(row.fetchedAt) : <span className="subtle">Never refreshed</span>}</td>
                      <td>
                        <div className="edd-row-actions">
                          <button type="button" className="button secondary edd-icon-btn" onClick={() => refreshStation(row.stationCode)} disabled={refreshing}>
                            {refreshing ? <Loader2 size={14} className="edd-spin" /> : <RefreshCw size={14} />}<span>{refreshing ? "Refreshing…" : "Refresh"}</span>
                          </button>
                          <Link className="button secondary" href={`/station-edd/${encodeURIComponent(row.stationCode)}`} prefetch={false}>Open</Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!pagedRows.length ? <p className="subtle" style={{ marginTop: 10 }}>No stations match this search.</p> : null}
          </div>

          {sorted.length ? (
            <div className="edd-pagination">
              <span className="subtle">{sorted.length} stations</span>
              <div className="edd-pagination-pages">
                <button type="button" className="button secondary" aria-label="Previous station page" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={16} /></button>
                <span className="subtle">Page {currentPage} of {totalPages}</span>
                <button type="button" className="button secondary" aria-label="Next station page" disabled={currentPage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}><ChevronRight size={16} /></button>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </>
  );
}
