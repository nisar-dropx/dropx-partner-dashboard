"use client";

import { useMemo, useState } from "react";
import { formatCiaDisplayDate, todayIstYmd } from "@/lib/ops-pulse/cia-types";
import type { EddPerformanceDailyRow, EddPerformancePackage } from "@/lib/ops-pulse/edd-worker";
import { deliverySeverity, deliverySeverityLabel } from "../edd-performance-severity";
import { EddPerformanceByAssociate } from "./edd-performance-by-associate";

/**
 * Pick one day from the archive and see its totals — mirrors CIA's "By
 * date" tab. Driver-level detail only exists for today (see
 * EddPerformanceDailyStore), so picking today also shows the associate
 * breakdown inline; any other archived day shows totals only.
 */
export function EddPerformanceByDate({
  stationCode,
  rows,
  todayAssigned,
  todayDeliveredPct,
  todayDelivered,
  todayReturned,
  todayHeld,
  todayPackages
}: {
  stationCode: string;
  rows: EddPerformanceDailyRow[];
  todayAssigned: number;
  todayDeliveredPct: number;
  todayDelivered: number;
  todayReturned: number;
  todayHeld: number;
  todayPackages: EddPerformancePackage[];
}) {
  const today = todayIstYmd();
  const hasTodayRow = rows.some((row) => row.date === today);
  const allDays = useMemo(() => {
    const merged = hasTodayRow
      ? rows
      : [
          {
            stationCode,
            date: today,
            assigned: todayAssigned,
            delivered: todayDelivered,
            returned: todayReturned,
            held: todayHeld,
            deliveredPct: todayDeliveredPct,
            returnedPct: 0,
            heldPct: 0,
            updatedAt: new Date().toISOString()
          },
          ...rows
        ];
    return [...merged].sort((a, b) => b.date.localeCompare(a.date));
  }, [rows, hasTodayRow, stationCode, today, todayAssigned, todayDelivered, todayReturned, todayHeld, todayDeliveredPct]);

  const [selectedDate, setSelectedDate] = useState(today);
  const selected = allDays.find((row) => row.date === selectedDate) ?? allDays[0] ?? null;
  const severity = selected && selected.assigned > 0 ? deliverySeverity(selected.deliveredPct) : null;
  const isToday = selected?.date === today;

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>By date</h3>
            <p className="subtle">Pick a day to see its totals. Driver-level detail is only available for today.</p>
          </div>
          <label className="edd-focus-day">
            <span>Day</span>
            <select className="field" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)}>
              {allDays.map((row) => (
                <option key={row.date} value={row.date}>
                  {formatCiaDisplayDate(row.date)}{row.date === today ? " (today)" : ""} · {row.assigned.toLocaleString("en-IN")} assigned
                </option>
              ))}
            </select>
          </label>
        </div>

        {selected ? (
          <div className="panel-body">
            <div className="edd-performance-grid">
              <div className="edd-bucket-card static">
                <span>Assigned</span>
                <strong>{selected.assigned.toLocaleString("en-IN")}</strong>
                <small>{formatCiaDisplayDate(selected.date)}</small>
              </div>
              <div className="edd-bucket-card static future">
                <span>Delivered</span>
                <strong>{selected.delivered.toLocaleString("en-IN")}</strong>
                <small>reached the customer</small>
              </div>
              <div className="edd-bucket-card static dueToday">
                <span>Held</span>
                <strong>{selected.held.toLocaleString("en-IN")}</strong>
                <small>still moving through the station</small>
              </div>
              <div className="edd-bucket-card static overdue">
                <span>Returned</span>
                <strong>{selected.returned.toLocaleString("en-IN")}</strong>
                <small>failed, rejected, or undeliverable</small>
              </div>
            </div>
            {severity ? (
              <div className="edd-insight-row">
                <span className={`edd-insight-chip ${severity === "critical" ? "negative" : severity === "good" ? "positive" : ""}`}>
                  <span className={`edd-severity ${severity}`} style={{ marginRight: 6 }}>{deliverySeverityLabel(severity)}</span>
                  <strong>{selected.deliveredPct}%</strong> delivery performance
                </span>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="panel-body">
            <p className="subtle">No data for this day yet.</p>
          </div>
        )}
      </section>

      {isToday ? <EddPerformanceByAssociate packages={todayPackages} /> : null}
    </>
  );
}
