"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown, Loader2, RefreshCw, Search } from "lucide-react";
import type { EddBucketKey, EddNetworkStation } from "@/lib/ops-pulse/edd-worker";
import type { EddStationOption } from "./page";

type SortColumn = "stationCode" | "totalCount" | "overdue" | "dueToday" | "dueTomorrow" | "future" | "fetchedAt";
type SortDir = "asc" | "desc";

const COLUMNS: Array<{ key: SortColumn; label: string; align?: "num" }> = [
  { key: "stationCode", label: "Station" },
  { key: "totalCount", label: "Total live", align: "num" },
  { key: "overdue", label: "Overdue", align: "num" },
  { key: "dueToday", label: "Due today", align: "num" },
  { key: "dueTomorrow", label: "Due tomorrow", align: "num" },
  { key: "future", label: "Future", align: "num" },
  { key: "fetchedAt", label: "Last refreshed" }
];

function formatFetchedAt(value: string | null) {
  if (!value) return "Never refreshed";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function sortValue(row: EddNetworkStation, column: SortColumn): string | number {
  switch (column) {
    case "stationCode": return row.stationCode;
    case "totalCount": return row.totalCount;
    case "overdue": return row.buckets.overdue;
    case "dueToday": return row.buckets.dueToday;
    case "dueTomorrow": return row.buckets.dueTomorrow;
    case "future": return row.buckets.future;
    case "fetchedAt": return row.fetchedAt ?? "";
    default: return "";
  }
}

function compareValues(a: string | number, b: string | number, dir: SortDir) {
  const factor = dir === "asc" ? 1 : -1;
  const aEmpty = a === "" || a == null;
  const bEmpty = b === "" || b == null;
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  if (typeof a === "number" && typeof b === "number") return (a - b) * factor;
  return String(a).localeCompare(String(b)) * factor;
}

async function refreshStation(stationCode: string) {
  const url = new URL("/api/ops-pulse/edd/refresh", window.location.origin);
  url.searchParams.set("stationCode", stationCode);
  const response = await fetch(url.toString(), { method: "POST", headers: { Accept: "application/json" }, cache: "no-store" });
  const text = await response.text();
  let raw: Record<string, unknown> = {};
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    raw = {};
  }
  if (!response.ok) {
    throw new Error(String(raw.error ?? `Unable to refresh ${stationCode} (${response.status}).`));
  }
  return raw as unknown as { fetchedAt: string; totalCount: number; buckets: Record<EddBucketKey, number> };
}

export function EddNetworkClient({
  stations,
  initialNetwork
}: {
  stations: EddStationOption[];
  initialNetwork: EddNetworkStation[];
}) {
  const nameByCode = useMemo(() => new Map(stations.map((s) => [s.code, s.name])), [stations]);
  const [rows, setRows] = useState<EddNetworkStation[]>(initialNetwork);
  const [search, setSearch] = useState("");
  const [sortColumn, setSortColumn] = useState<SortColumn>("overdue");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [refreshingCode, setRefreshingCode] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ code: string; message: string } | null>(null);

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, row) => {
        acc.total += row.totalCount;
        acc.overdue += row.buckets.overdue;
        acc.dueToday += row.buckets.dueToday;
        acc.stationsWithData += row.hasSnapshot ? 1 : 0;
        return acc;
      },
      { total: 0, overdue: 0, dueToday: 0, stationsWithData: 0 }
    );
  }, [rows]);

  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((row) => {
      const name = nameByCode.get(row.stationCode) ?? "";
      return row.stationCode.toLowerCase().includes(term) || name.toLowerCase().includes(term);
    });
  }, [rows, search, nameByCode]);

  const sortedRows = useMemo(
    () => [...filteredRows].sort((a, b) => compareValues(sortValue(a, sortColumn), sortValue(b, sortColumn), sortDir)),
    [filteredRows, sortColumn, sortDir]
  );

  function toggleSort(column: SortColumn) {
    if (sortColumn !== column) {
      setSortColumn(column);
      setSortDir(column === "stationCode" ? "asc" : "desc");
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
              ? { ...row, hasSnapshot: true, fetchedAt: fresh.fetchedAt, totalCount: fresh.totalCount, buckets: fresh.buckets }
              : row
          )
        );
      })
      .catch((err) => {
        setRowError({ code: stationCode, message: err instanceof Error ? err.message : "Unable to refresh this station." });
      })
      .finally(() => setRefreshingCode(null));
  }

  return (
    <>
      <section className="edd-bucket-grid">
        <div className="edd-bucket-card static">
          <span>Stations tracked</span>
          <strong>{rows.length.toLocaleString("en-IN")}</strong>
          <small>{totals.stationsWithData.toLocaleString("en-IN")} with a live snapshot</small>
        </div>
        <div className="edd-bucket-card static">
          <span>Total live TIDs</span>
          <strong>{totals.total.toLocaleString("en-IN")}</strong>
          <small>Across every tracked station</small>
        </div>
        <div className="edd-bucket-card static overdue">
          <span>Overdue</span>
          <strong>{totals.overdue.toLocaleString("en-IN")}</strong>
          <small>EAD already passed, network-wide</small>
        </div>
        <div className="edd-bucket-card static dueToday">
          <span>Due today</span>
          <strong>{totals.dueToday.toLocaleString("en-IN")}</strong>
          <small>Must deliver today, network-wide</small>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>Stations</h3>
          <p className="subtle">Open a station for its full bucket breakdown, EAD trend, and live tracking ID table.</p>
        </div>
        <div className="panel-body">
          <div className="edd-toolbar">
            <div style={{ position: "relative" }}>
              <Search size={15} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--muted)" }} />
              <input
                type="search"
                placeholder="Search station code or name…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
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
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row) => {
                  const isRefreshing = refreshingCode === row.stationCode;
                  const name = nameByCode.get(row.stationCode);
                  return (
                    <tr key={row.stationCode}>
                      <td>
                        <Link className="edd-station-link" href={`/edd/${encodeURIComponent(row.stationCode)}`} prefetch={false}>
                          <strong>{row.stationCode}</strong>
                          {name ? <small>{name}</small> : null}
                        </Link>
                      </td>
                      <td className="num">{row.totalCount.toLocaleString("en-IN")}</td>
                      <td className="num">
                        {row.buckets.overdue ? <span className="edd-pill overdue">{row.buckets.overdue.toLocaleString("en-IN")}</span> : "—"}
                      </td>
                      <td className="num">
                        {row.buckets.dueToday ? <span className="edd-pill dueToday">{row.buckets.dueToday.toLocaleString("en-IN")}</span> : "—"}
                      </td>
                      <td className="num">{row.buckets.dueTomorrow ? row.buckets.dueTomorrow.toLocaleString("en-IN") : "—"}</td>
                      <td className="num">{row.buckets.future ? row.buckets.future.toLocaleString("en-IN") : "—"}</td>
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
                          <Link className="button secondary" href={`/edd/${encodeURIComponent(row.stationCode)}`} prefetch={false}>
                            Open
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!sortedRows.length ? <p className="subtle" style={{ marginTop: 10 }}>No stations match this search.</p> : null}
          </div>
        </div>
      </section>
    </>
  );
}
