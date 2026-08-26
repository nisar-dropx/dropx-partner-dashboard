"use client";

import { useMemo, useState } from "react";
import { addDaysYmd, formatCiaDisplayDate, todayIstYmd } from "@/lib/ops-pulse/cia-types";
import type { EddPerformanceDailyRow } from "@/lib/ops-pulse/edd-worker";
import { deliverySeverity, deliverySeverityLabel } from "../edd-performance-severity";

/** How far back "By date" lets you pick — matches the ledger/archive's own practical horizon. */
const MAX_LOOKBACK_DAYS = 90;

/**
 * Pick any day and see its totals — mirrors CIA's "By date" date controls
 * (Today/Yesterday chips + a date input) rather than a plain dropdown of
 * only-already-archived days. Aggregate totals only, even for today: the
 * driver-level breakdown lives in its own "By associate" tab so the two
 * don't end up showing the same content twice.
 */
export function EddPerformanceByDate({
  stationCode,
  rows,
  todayAssigned,
  todayDelivered,
  todayReturned,
  todayHeld,
  todayDeliveredPct
}: {
  stationCode: string;
  rows: EddPerformanceDailyRow[];
  todayAssigned: number;
  todayDelivered: number;
  todayReturned: number;
  todayHeld: number;
  todayDeliveredPct: number;
}) {
  const today = todayIstYmd();
  const yesterday = addDaysYmd(today, -1);
  const earliestAllowed = addDaysYmd(today, -(MAX_LOOKBACK_DAYS - 1));
  const [selectedDate, setSelectedDate] = useState(today);

  const rowsByDate = useMemo(() => new Map(rows.map((row) => [row.date, row])), [rows]);

  const selected = useMemo(() => {
    if (selectedDate === today) {
      return {
        date: today,
        assigned: todayAssigned,
        delivered: todayDelivered,
        returned: todayReturned,
        held: todayHeld,
        deliveredPct: todayDeliveredPct
      };
    }
    return rowsByDate.get(selectedDate) ?? null;
  }, [selectedDate, today, todayAssigned, todayDelivered, todayReturned, todayHeld, todayDeliveredPct, rowsByDate]);

  const severity = selected && selected.assigned > 0 ? deliverySeverity(selected.deliveredPct) : null;

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h3>By date</h3>
          <p className="subtle">Pick a day to see its totals — driver-level detail lives in the By associate tab.</p>
        </div>
      </div>
      <div className="panel-body">
        <div className="edd-preset-row">
          <button
            type="button"
            className={`button secondary edd-chip edd-chip-today${selectedDate === today ? " active" : ""}`}
            onClick={() => setSelectedDate(today)}
          >
            Today
          </button>
          <button
            type="button"
            className={`button secondary edd-chip${selectedDate === yesterday ? " active" : ""}`}
            onClick={() => setSelectedDate(yesterday)}
          >
            Yesterday
          </button>
          <label className="edd-range-field" style={{ minWidth: 0 }}>
            <span>Or pick a day</span>
            <input
              type="date"
              className="field"
              min={earliestAllowed}
              max={today}
              value={selectedDate}
              onChange={(event) => {
                if (event.target.value) setSelectedDate(event.target.value);
              }}
            />
          </label>
        </div>

        <div style={{ marginTop: 16 }}>
          {selected ? (
            <>
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
            </>
          ) : (
            <p className="subtle">
              No archived data for {formatCiaDisplayDate(selectedDate)} at {stationCode} — it hasn&apos;t been swept/refreshed on this day, or is before the archive started.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
