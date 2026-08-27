"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Download, Loader2, RefreshCw, Search } from "lucide-react";
import type { EddNetworkRunStatus, EddPerformanceNetworkStation } from "@/lib/ops-pulse/edd-worker";
import type { EddStationOption } from "@/lib/ops-pulse/edd-stations";
import { deliverySeverity, deliverySeverityLabel } from "./edd-performance-severity";
import { EddPerformanceChart } from "./edd-performance-chart";

type SortColumn = "stationCode" | "deliveryPerformance" | "assigned" | "delivered" | "returned" | "held";
type SortDir = "asc" | "desc";
const PAGE_SIZE = 12;
/** While a sweep is running, poll the (instant, cache-only) network endpoint at this cadence. */
const RUN_POLL_MS = 15000;

const COLUMNS: Array<{ key: SortColumn; label: string; align?: "num" }> = [
  { key: "stationCode", label: "Station" },
  { key: "deliveryPerformance", label: "Delivery Performance", align: "num" },
  { key: "assigned", label: "Assigned", align: "num" },
  { key: "delivered", label: "Delivered", align: "num" },
  { key: "returned", label: "Returned", align: "num" },
  { key: "held", label: "Held", align: "num" }
];

function formatFetchedAt(value: string | null) {
  if (!value) return "Never refreshed";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Stations with no data yet sort to the end regardless of direction, so they never masquerade as "worst performing". */
function sortValue(row: EddPerformanceNetworkStation, column: SortColumn, dir: SortDir): string | number {
  const hasData = row.hasSnapshot && row.assigned > 0;
  switch (column) {
    case "stationCode": return row.stationCode;
    case "deliveryPerformance": return hasData ? row.deliveredPct : (dir === "asc" ? Infinity : -Infinity);
    case "assigned": return row.assigned;
    case "delivered": return row.delivered;
    case "returned": return row.returned;
    case "held": return row.held;
    default: return "";
  }
}

function compareValues(a: string | number, b: string | number, dir: SortDir) {
  const factor = dir === "asc" ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return (a - b) * factor;
  return String(a).localeCompare(String(b)) * factor;
}

async function postJson<T>(path: string): Promise<T> {
  const response = await fetch(new URL(path, window.location.origin).toString(), {
    method: "POST",
    headers: { Accept: "application/json" },
    cache: "no-store"
  });
  const text = await response.text();
  let raw: Record<string, unknown> = {};
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    raw = {};
  }
  if (!response.ok) throw new Error(String(raw.error ?? `Request failed (${response.status}).`));
  return raw as T;
}

async function refreshStation(stationCode: string) {
  return postJson<{ fetchedAt: string; assigned: number; delivered: number; returned: number; held: number; yetToDispatch: number; deliveredPct: number; returnedPct: number; heldPct: number }>(
    `/api/ops-pulse/edd/performance/refresh?stationCode=${encodeURIComponent(stationCode)}`
  );
}

async function fetchNetwork(): Promise<{ stations: EddPerformanceNetworkStation[]; run: EddNetworkRunStatus | null }> {
  const response = await fetch(new URL("/api/ops-pulse/edd/performance/network", window.location.origin).toString(), {
    headers: { Accept: "application/json" },
    cache: "no-store"
  });
  const raw = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(raw.error ?? "Unable to refresh the network performance overview."));
  return { stations: raw.stations ?? [], run: raw.run ?? null };
}

/**
 * Snapshot-only network performance overview — mirrors EddNetworkClient
 * (Ageing) exactly: cached reads, per-row refresh, a network-wide
 * "Refresh all" that kicks off the worker's sweep in the background, and a
 * progress poll while one is running. No per-page live Amazon calls.
 *
 * Led by "Delivery Performance" (delivered ÷ assigned) as the headline
 * metric a manager actually scans for — a hero card network-wide, a chart
 * ranking the worst stations, and its own sortable/severity-colored column
 * in the table — rather than burying that percentage inside the Delivered
 * cell.
 */
export function EddNetworkPerformanceView({
  stations,
  initialNetwork,
  initialRun
}: {
  stations: EddStationOption[];
  initialNetwork: EddPerformanceNetworkStation[];
  initialRun: EddNetworkRunStatus | null;
}) {
  const nameByCode = useMemo(() => new Map(stations.map((s) => [s.code, s.name])), [stations]);
  const [rows, setRows] = useState<EddPerformanceNetworkStation[]>(initialNetwork);
  const [run, setRun] = useState<EddNetworkRunStatus | null>(initialRun);
  const [search, setSearch] = useState("");
  const [sortColumn, setSortColumn] = useState<SortColumn>("deliveryPerformance");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [page, setPage] = useState(1);
  const [refreshingCode, setRefreshingCode] = useState<string | null>(null);
  const [startingSweep, setStartingSweep] = useState(false);
  const [rowError, setRowError] = useState<{ code: string; message: string } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, row) => {
        acc.assigned += row.assigned;
        acc.delivered += row.delivered;
        acc.returned += row.returned;
        acc.held += row.held;
        acc.yetToDispatch += row.yetToDispatch;
        acc.stationsWithData += row.hasSnapshot ? 1 : 0;
        return acc;
      },
      { assigned: 0, delivered: 0, returned: 0, held: 0, yetToDispatch: 0, stationsWithData: 0 }
    );
  }, [rows]);
  const pct = (value: number) => (totals.assigned > 0 ? Math.round((value / totals.assigned) * 1000) / 10 : 0);
  const networkDeliveryPct = pct(totals.delivered);
  const networkSeverity = deliverySeverity(networkDeliveryPct);

  const worstStation = useMemo(() => {
    const withData = rows.filter((row) => row.hasSnapshot && row.assigned > 0);
    if (!withData.length) return null;
    return [...withData].sort((a, b) => a.deliveredPct - b.deliveredPct)[0];
  }, [rows]);
  const bestStation = useMemo(() => {
    const withData = rows.filter((row) => row.hasSnapshot && row.assigned > 0);
    if (!withData.length) return null;
    return [...withData].sort((a, b) => b.deliveredPct - a.deliveredPct)[0];
  }, [rows]);
  const criticalCount = useMemo(
    () => rows.filter((row) => row.hasSnapshot && row.assigned > 0 && deliverySeverity(row.deliveredPct) === "critical").length,
    [rows]
  );

  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((row) => {
      const name = nameByCode.get(row.stationCode) ?? "";
      return row.stationCode.toLowerCase().includes(term) || name.toLowerCase().includes(term);
    });
  }, [rows, search, nameByCode]);

  const sortedRows = useMemo(
    () => [...filteredRows].sort((a, b) => compareValues(sortValue(a, sortColumn, sortDir), sortValue(b, sortColumn, sortDir), sortDir)),
    [filteredRows, sortColumn, sortDir]
  );

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pagedRows = useMemo(
    () => sortedRows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [sortedRows, currentPage]
  );

  useEffect(() => {
    if (run?.status !== "running") {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    pollRef.current = setInterval(() => {
      void fetchNetwork()
        .then((next) => {
          setRows(next.stations);
          setRun(next.run);
        })
        .catch(() => {
          // Transient poll failure — keep showing the last known state and try again next tick.
        });
    }, RUN_POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [run?.status]);

  function toggleSort(column: SortColumn) {
    setPage(1);
    if (sortColumn !== column) {
      setSortColumn(column);
      setSortDir(column === "stationCode" ? "asc" : column === "deliveryPerformance" ? "asc" : "desc");
      return;
    }
    setSortDir((current) => (current === "asc" ? "desc" : "asc"));
  }

  function handleRefresh(stationCode: string) {
    setRefreshingCode(stationCode);
    setRowError(null);
    void refreshStation(stationCode)
      .then((fresh) => {
        setRows((current) =>
          current.map((row) =>
            row.stationCode === stationCode
              ? {
                  ...row,
                  hasSnapshot: true,
                  fetchedAt: fresh.fetchedAt,
                  assigned: fresh.assigned,
                  delivered: fresh.delivered,
                  returned: fresh.returned,
                  held: fresh.held,
                  yetToDispatch: fresh.yetToDispatch,
                  deliveredPct: fresh.deliveredPct,
                  returnedPct: fresh.returnedPct,
                  heldPct: fresh.heldPct
                }
              : row
          )
        );
      })
      .catch((err) => {
        setRowError({ code: stationCode, message: err instanceof Error ? err.message : "Unable to refresh this station." });
      })
      .finally(() => setRefreshingCode(null));
  }

  function handleRefreshAll() {
    setStartingSweep(true);
    setRowError(null);
    void postJson<{ run: EddNetworkRunStatus | null }>("/api/ops-pulse/edd/performance/network/refresh-all")
      .then((result) => setRun(result.run))
      .catch((err) => {
        setRowError({ code: "Network sweep", message: err instanceof Error ? err.message : "Unable to start the network sweep." });
      })
      .finally(() => setStartingSweep(false));
  }

  const sweepRunning = run?.status === "running";
  const sweepPct = run && run.stationsTotal ? Math.round((run.stationsDone / run.stationsTotal) * 100) : 0;

  return (
    <>
      <section className={`edd-hero-card ${networkSeverity}`}>
        <div className="edd-hero-card-top">
          <span>Network delivery performance</span>
          <span className={`edd-severity ${networkSeverity}`}>{deliverySeverityLabel(networkSeverity)}</span>
        </div>
        <strong>{networkDeliveryPct}%</strong>
        <small>
          {totals.delivered.toLocaleString("en-IN")} of {totals.assigned.toLocaleString("en-IN")} assigned packages delivered today
          {totals.stationsWithData < rows.length ? ` · ${totals.stationsWithData}/${rows.length} stations reporting` : ""}
        </small>
        <div className="edd-insight-row">
          {criticalCount ? (
            <span className="edd-insight-chip negative"><strong>{criticalCount}</strong> station{criticalCount === 1 ? "" : "s"} critical (&lt;70%)</span>
          ) : (
            <span className="edd-insight-chip positive">No stations critical right now</span>
          )}
          {worstStation ? (
            <span className="edd-insight-chip negative">Lowest: <strong>{worstStation.stationCode}</strong> at {worstStation.deliveredPct}%</span>
          ) : null}
          {bestStation ? (
            <span className="edd-insight-chip positive">Highest: <strong>{bestStation.stationCode}</strong> at {bestStation.deliveredPct}%</span>
          ) : null}
          {totals.yetToDispatch > 0 ? (
            <span className="edd-insight-chip" title="Still at stations, no driver or store attached yet — not counted in Assigned above">
              <strong>{totals.yetToDispatch.toLocaleString("en-IN")}</strong> network-wide yet to dispatch
            </span>
          ) : null}
        </div>
      </section>

      <section className="edd-bucket-grid">
        <div className="edd-bucket-card static">
          <span>Assigned</span>
          <strong>{totals.assigned.toLocaleString("en-IN")}</strong>
          <small>{totals.stationsWithData.toLocaleString("en-IN")}/{rows.length} stations with data today</small>
        </div>
        <div className="edd-bucket-card static future">
          <span>Delivered</span>
          <strong>{totals.delivered.toLocaleString("en-IN")}</strong>
          <small>reached the customer</small>
        </div>
        <div className="edd-bucket-card static dueToday">
          <span>Held</span>
          <strong>{totals.held.toLocaleString("en-IN")}</strong>
          <small>{pct(totals.held)}% · still moving through the station</small>
        </div>
        <div className="edd-bucket-card static overdue">
          <span>Returned</span>
          <strong>{totals.returned.toLocaleString("en-IN")}</strong>
          <small>{pct(totals.returned)}% · failed, rejected, or undeliverable</small>
        </div>
        <div className="edd-bucket-card static unknown">
          <span>Yet to dispatch</span>
          <strong>{totals.yetToDispatch.toLocaleString("en-IN")}</strong>
          <small>not counted in Assigned — no driver/store yet</small>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Stations needing attention</h3>
            <p className="subtle">Lowest delivery performance today, worst first — click a bar to open that station.</p>
          </div>
        </div>
        <div className="panel-body">
          <EddPerformanceChart stations={rows} />
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>Stations</h3>
            <p className="subtle">Today's delivery performance, refreshed every 15 minutes. Open a station for its own Performance tab.</p>
          </div>
          <div className="panel-head-actions">
            <a className="button secondary" href="/api/ops-pulse/edd/performance/network/report" style={{ display: "inline-flex", alignItems: "center", gap: 6 }} title="Download the network overview as an Excel report">
              <Download size={16} /> Download report
            </a>
            <button
              type="button"
              className="button secondary"
              onClick={handleRefreshAll}
              disabled={startingSweep || sweepRunning}
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              {startingSweep ? <Loader2 size={16} className="edd-spin" /> : <RefreshCw size={16} />}
              {sweepRunning ? "Sweep running…" : startingSweep ? "Starting…" : "Refresh all"}
            </button>
          </div>
        </div>

        {run ? (
          <div className="panel-body edd-sweep-status">
            <div className="edd-sweep-bar">
              <div className="edd-sweep-bar-fill" style={{ width: `${sweepRunning ? sweepPct : 100}%` }} />
            </div>
            <span className="subtle">
              {sweepRunning
                ? `Sweep in progress — ${run.stationsDone}/${run.stationsTotal} stations (${run.stationsOk} ok${run.stationsFailed ? `, ${run.stationsFailed} failed` : ""}).`
                : `Last sweep: ${run.stationsOk}/${run.stationsTotal} ok${run.stationsFailed ? `, ${run.stationsFailed} failed` : ""}${run.finishedAt ? ` · finished ${formatFetchedAt(run.finishedAt)}` : ""}.`}
            </span>
          </div>
        ) : null}

        <div className="panel-body">
          <div className="edd-toolbar">
            <div style={{ position: "relative" }}>
              <Search size={15} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--muted)" }} />
              <input
                type="search"
                placeholder="Search station code or name…"
                value={search}
                onChange={(event) => {
                  setPage(1);
                  setSearch(event.target.value);
                }}
                style={{ paddingLeft: 30, minWidth: 240 }}
              />
            </div>
            <span className="subtle" style={{ marginLeft: "auto" }}>
              Showing {sortedRows.length.toLocaleString("en-IN")} of {rows.length.toLocaleString("en-IN")}
            </span>
          </div>

          {rowError ? (
            <p className="subtle" style={{ color: "var(--red)", marginTop: 8 }}>
              {rowError.code}: {rowError.message}
            </p>
          ) : null}

          <div className="edd-table-wrap">
            <table className="edd-table">
              <thead>
                <tr>
                  {COLUMNS.map((column) => {
                    const isActive = sortColumn === column.key;
                    return (
                      <th key={column.key} className={column.align}>
                        <button type="button" className="edd-sort-btn" onClick={() => toggleSort(column.key)}>
                          {column.label}
                          {isActive ? (
                            sortDir === "asc" ? <ArrowUp size={12} className="edd-sort-icon active" /> : <ArrowDown size={12} className="edd-sort-icon active" />
                          ) : (
                            <ArrowUpDown size={12} className="edd-sort-icon" />
                          )}
                        </button>
                      </th>
                    );
                  })}
                  <th>Last refreshed</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((row) => {
                  const isRefreshing = refreshingCode === row.stationCode;
                  const name = nameByCode.get(row.stationCode);
                  const hasData = row.hasSnapshot && row.assigned > 0;
                  const severity = hasData ? deliverySeverity(row.deliveredPct) : null;
                  return (
                    <tr key={row.stationCode}>
                      <td>
                        <Link className="edd-station-link" href={`/edd/${encodeURIComponent(row.stationCode)}/performance`} prefetch={false}>
                          <strong>{row.stationCode}</strong>
                          {name ? <small>{name}</small> : null}
                        </Link>
                      </td>
                      <td className="num">
                        {severity ? <span className={`edd-severity ${severity}`}>{row.deliveredPct}%</span> : <span className="subtle">—</span>}
                      </td>
                      <td className="num">{row.assigned.toLocaleString("en-IN")}</td>
                      <td className="num">{row.delivered.toLocaleString("en-IN")}</td>
                      <td className="num">{row.returned ? row.returned.toLocaleString("en-IN") : "—"}</td>
                      <td className="num">{row.held.toLocaleString("en-IN")}</td>
                      <td>{row.hasSnapshot ? formatFetchedAt(row.fetchedAt) : <span className="subtle">Never refreshed</span>}</td>
                      <td>
                        <div className="edd-row-actions">
                          <button
                            type="button"
                            className="button secondary edd-icon-btn"
                            title={`Refresh ${row.stationCode}`}
                            disabled={isRefreshing}
                            onClick={() => handleRefresh(row.stationCode)}
                          >
                            {isRefreshing ? <Loader2 size={14} className="edd-spin" /> : <RefreshCw size={14} />}
                            <span>{isRefreshing ? "Refreshing…" : "Refresh"}</span>
                          </button>
                          <Link className="button secondary" href={`/edd/${encodeURIComponent(row.stationCode)}/performance`} prefetch={false}>
                            Open
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!pagedRows.length ? <p className="subtle" style={{ marginTop: 10 }}>No stations match this search.</p> : null}
          </div>

          {sortedRows.length ? (
            <div className="edd-pagination">
              <span className="subtle">{sortedRows.length.toLocaleString("en-IN")} stations</span>
              <div className="edd-pagination-pages">
                <button type="button" className="button secondary" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} aria-label="Previous page">
                  <ChevronLeft size={16} />
                </button>
                <span className="subtle">Page {currentPage} of {totalPages}</span>
                <button type="button" className="button secondary" disabled={currentPage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))} aria-label="Next page">
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </>
  );
}
