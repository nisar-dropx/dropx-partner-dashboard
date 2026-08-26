"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { formatCiaDisplayDate } from "@/lib/ops-pulse/cia-types";
import type { EddPerformanceDailyRow } from "@/lib/ops-pulse/edd-worker";
import { deliverySeverity } from "../edd-performance-severity";

type SortColumn = "date" | "assigned" | "deliveredPct";
type SortDir = "asc" | "desc";

/**
 * Day-over-day performance history for one station — reads the archive
 * EddPerformanceDailyStore builds up one real day at a time (every sweep
 * and manual refresh upserts today's totals into it). Starts empty on a
 * station that's never been refreshed before this shipped; there's no way
 * to backfill days from before the archive existed.
 */
export function EddPerformanceLedger({ rows }: { rows: EddPerformanceDailyRow[] }) {
  const [sortColumn, setSortColumn] = useState<SortColumn>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const sorted = useMemo(() => {
    const factor = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sortColumn === "date") return a.date.localeCompare(b.date) * factor;
      if (sortColumn === "assigned") return (a.assigned - b.assigned) * factor;
      return (a.deliveredPct - b.deliveredPct) * factor;
    });
  }, [rows, sortColumn, sortDir]);

  function toggleSort(column: SortColumn) {
    if (sortColumn !== column) {
      setSortColumn(column);
      setSortDir(column === "date" ? "desc" : "desc");
      return;
    }
    setSortDir((current) => (current === "asc" ? "desc" : "asc"));
  }

  function sortIcon(column: SortColumn) {
    if (sortColumn !== column) return <ArrowUpDown size={12} className="edd-sort-icon" />;
    return sortDir === "asc" ? <ArrowUp size={12} className="edd-sort-icon active" /> : <ArrowDown size={12} className="edd-sort-icon active" />;
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h3>Day-wise ledger</h3>
          <p className="subtle">Every day this station has been refreshed, most recent first. Builds up from today onward — there's no history before this shipped.</p>
        </div>
      </div>
      <div className="panel-body">
        {!rows.length ? (
          <p className="subtle">No archived days yet — this fills in automatically as the 15-minute sweep (or a manual refresh) runs for this station.</p>
        ) : (
          <div className="edd-table-wrap">
            <table className="edd-table">
              <thead>
                <tr>
                  <th><button type="button" className="edd-sort-btn" onClick={() => toggleSort("date")}>Date {sortIcon("date")}</button></th>
                  <th className="num"><button type="button" className="edd-sort-btn" onClick={() => toggleSort("assigned")}>Assigned {sortIcon("assigned")}</button></th>
                  <th className="num">Delivered</th>
                  <th className="num">Returned</th>
                  <th className="num">Held</th>
                  <th className="num"><button type="button" className="edd-sort-btn" onClick={() => toggleSort("deliveredPct")}>Delivery Performance {sortIcon("deliveredPct")}</button></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((row) => {
                  const severity = row.assigned > 0 ? deliverySeverity(row.deliveredPct) : null;
                  return (
                    <tr key={row.date}>
                      <td>{formatCiaDisplayDate(row.date)}</td>
                      <td className="num">{row.assigned.toLocaleString("en-IN")}</td>
                      <td className="num">{row.delivered.toLocaleString("en-IN")}</td>
                      <td className="num">{row.returned ? row.returned.toLocaleString("en-IN") : "—"}</td>
                      <td className="num">{row.held.toLocaleString("en-IN")}</td>
                      <td className="num">{severity ? <span className={`edd-severity ${severity}`}>{row.deliveredPct}%</span> : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
