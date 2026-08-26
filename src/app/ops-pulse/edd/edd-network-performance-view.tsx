"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Loader2 } from "lucide-react";
import { formatCiaDisplayDate, todayIstYmd } from "@/lib/ops-pulse/cia-types";
import type { EddPerformancePayload } from "@/lib/ops-pulse/edd-worker";
import type { EddStationOption } from "./page";
import { EddDateRangePicker } from "./edd-date-range-picker";

/** How many stations to fetch performance for at once — each is a real live Amazon pull, so this stays modest. */
const CONCURRENCY = 4;

type RowState =
  | { status: "pending" }
  | { status: "ok"; data: EddPerformancePayload }
  | { status: "error"; message: string };

type SortColumn = "stationCode" | "assigned" | "delivered" | "returned" | "held";
type SortDir = "asc" | "desc";

const COLUMNS: Array<{ key: SortColumn; label: string; align?: "num" }> = [
  { key: "stationCode", label: "Station" },
  { key: "assigned", label: "Assigned", align: "num" },
  { key: "delivered", label: "Delivered", align: "num" },
  { key: "returned", label: "Returned", align: "num" },
  { key: "held", label: "Held", align: "num" }
];

async function fetchPerformance(stationCode: string, from: string, to: string): Promise<EddPerformancePayload> {
  const url = new URL("/api/ops-pulse/edd/performance", window.location.origin);
  url.searchParams.set("stationCode", stationCode);
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  const response = await fetch(url.toString(), { headers: { Accept: "application/json" }, cache: "no-store" });
  const raw = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(raw.error ?? `Unable to load performance (${response.status}).`));
  return raw as EddPerformancePayload;
}

function compareValues(a: string | number, b: string | number, dir: SortDir) {
  const factor = dir === "asc" ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return (a - b) * factor;
  return String(a).localeCompare(String(b)) * factor;
}

/**
 * Network-wide assigned/delivered/returned/held — one live Amazon fetch per
 * station (reusing the same /api/ops-pulse/edd/performance the station page
 * uses), run with limited concurrency rather than one big worker-side call:
 * 38 stations' worth of live pulls in a single request risks a timeout, and
 * this way rows fill in as they complete instead of an all-or-nothing wait.
 */
export function EddNetworkPerformanceView({ stations }: { stations: EddStationOption[] }) {
  const today = todayIstYmd();
  const [appliedFrom, setAppliedFrom] = useState(today);
  const [appliedTo, setAppliedTo] = useState(today);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [sortColumn, setSortColumn] = useState<SortColumn>("assigned");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const requestId = useRef(0);

  useEffect(() => {
    const thisRequest = ++requestId.current;
    setRows(Object.fromEntries(stations.map((station) => [station.code, { status: "pending" } as RowState])));

    let cursor = 0;
    async function worker() {
      while (cursor < stations.length) {
        if (thisRequest !== requestId.current) return;
        const station = stations[cursor];
        cursor += 1;
        try {
          const data = await fetchPerformance(station.code, appliedFrom, appliedTo);
          if (thisRequest !== requestId.current) return;
          setRows((current) => ({ ...current, [station.code]: { status: "ok", data } }));
        } catch (err) {
          if (thisRequest !== requestId.current) return;
          setRows((current) => ({
            ...current,
            [station.code]: { status: "error", message: err instanceof Error ? err.message : "Unable to load." }
          }));
        }
      }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, stations.length) }, () => worker());
    void Promise.all(workers);

    return () => {
      requestId.current += 1;
    };
  }, [stations, appliedFrom, appliedTo]);

  const rowList = useMemo(() => stations.map((station) => ({ station, state: rows[station.code] ?? { status: "pending" as const } })), [stations, rows]);
  const doneCount = rowList.filter((row) => row.state.status !== "pending").length;
  const allDone = doneCount === stations.length && stations.length > 0;

  const totals = useMemo(() => {
    return rowList.reduce(
      (acc, row) => {
        if (row.state.status !== "ok") return acc;
        acc.assigned += row.state.data.assigned;
        acc.delivered += row.state.data.delivered;
        acc.returned += row.state.data.returned;
        acc.held += row.state.data.held;
        return acc;
      },
      { assigned: 0, delivered: 0, returned: 0, held: 0 }
    );
  }, [rowList]);
  const pct = (value: number) => (totals.assigned > 0 ? Math.round((value / totals.assigned) * 1000) / 10 : 0);

  function toggleSort(column: SortColumn) {
    if (sortColumn !== column) {
      setSortColumn(column);
      setSortDir(column === "stationCode" ? "asc" : "desc");
      return;
    }
    setSortDir((current) => (current === "asc" ? "desc" : "asc"));
  }

  function sortValue(row: (typeof rowList)[number]): string | number {
    if (row.state.status !== "ok") return sortColumn === "stationCode" ? row.station.code : -1;
    switch (sortColumn) {
      case "stationCode": return row.station.code;
      case "assigned": return row.state.data.assigned;
      case "delivered": return row.state.data.delivered;
      case "returned": return row.state.data.returned;
      case "held": return row.state.data.held;
      default: return 0;
    }
  }

  const sortedRows = useMemo(
    () => [...rowList].sort((a, b) => compareValues(sortValue(a), sortValue(b), sortDir)),
    [rowList, sortColumn, sortDir]
  );

  return (
    <>
      <section className="panel">
        <div className="panel-body">
          <h3 style={{ margin: 0 }}>Check network performance for a date range</h3>
          <p className="subtle" style={{ marginTop: 4 }}>
            Assigned, delivered, returned, and held packages across every station — defaults to today. Pulled live
            from Amazon one station at a time, so a wide range across the whole network can take a while.
          </p>
          <div style={{ marginTop: 12 }}>
            <EddDateRangePicker
              from={appliedFrom}
              to={appliedTo}
              loading={!allDone}
              onApply={(from, to) => {
                setAppliedFrom(from);
                setAppliedTo(to);
              }}
            />
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>
              {formatCiaDisplayDate(appliedFrom)}{appliedFrom !== appliedTo ? ` – ${formatCiaDisplayDate(appliedTo)}` : ""}
            </h3>
            <p className="subtle">
              {allDone
                ? `${totals.assigned.toLocaleString("en-IN")} packages assigned network-wide in this window.`
                : `Loading ${doneCount}/${stations.length} stations…`}
            </p>
          </div>
          {!allDone ? <Loader2 size={18} className="edd-spin" /> : null}
        </div>
        <div className="panel-body">
          <div className="edd-performance-grid">
            <div className="edd-bucket-card static">
              <span>Assigned</span>
              <strong>{totals.assigned.toLocaleString("en-IN")}</strong>
              <small>{doneCount}/{stations.length} stations loaded</small>
            </div>
            <div className="edd-bucket-card static future">
              <span>Delivered</span>
              <strong>{totals.delivered.toLocaleString("en-IN")}</strong>
              <small>{pct(totals.delivered)}% · reached the customer</small>
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
          </div>

          <div className="edd-table-wrap" style={{ marginTop: 14 }}>
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
                </tr>
              </thead>
              <tbody>
                {sortedRows.map(({ station, state }) => (
                  <tr key={station.code}>
                    <td><strong>{station.code}</strong>{station.name ? <small style={{ display: "block", color: "var(--muted)" }}>{station.name}</small> : null}</td>
                    {state.status === "pending" ? (
                      <td colSpan={4} className="subtle"><Loader2 size={13} className="edd-spin" style={{ marginRight: 6, verticalAlign: "middle" }} />Loading…</td>
                    ) : state.status === "error" ? (
                      <td colSpan={4} className="subtle" style={{ color: "var(--red)" }}>{state.message}</td>
                    ) : (
                      <>
                        <td className="num">{state.data.assigned.toLocaleString("en-IN")}</td>
                        <td className="num">{state.data.delivered.toLocaleString("en-IN")} <span className="subtle">({state.data.deliveredPct}%)</span></td>
                        <td className="num">{state.data.returned.toLocaleString("en-IN")} <span className="subtle">({state.data.returnedPct}%)</span></td>
                        <td className="num">{state.data.held.toLocaleString("en-IN")} <span className="subtle">({state.data.heldPct}%)</span></td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}
