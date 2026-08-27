"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { addDaysYmd, formatCiaDisplayDate, todayIstYmd } from "@/lib/ops-pulse/cia-types";
import type { EddPerformanceDailyRow } from "@/lib/ops-pulse/edd-worker";
import { deliverySeverity, deliverySeverityLabel } from "../edd-performance-severity";
import { EddMultiSelect } from "../edd-multi-select";

type DaySummary = {
  date: string;
  assigned: number;
  delivered: number;
  returned: number;
  held: number;
  deliveredPct: number;
};

/**
 * Pick one or many days and see their combined totals — mirrors the same
 * "select multiple dates" pattern the Ageing page's own date filter already
 * uses (`EddMultiSelect`), plus quick preset chips, with an explicit
 * "Search" button to apply a manual selection (so ticking several
 * checkboxes doesn't recompute the totals on every click). Aggregate
 * numbers only — driver-level detail lives in its own "By associate" tab.
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

  const rowsByDate = useMemo(() => new Map(rows.map((row) => [row.date, row])), [rows]);
  const todaySummary: DaySummary = useMemo(
    () => ({ date: today, assigned: todayAssigned, delivered: todayDelivered, returned: todayReturned, held: todayHeld, deliveredPct: todayDeliveredPct }),
    [today, todayAssigned, todayDelivered, todayReturned, todayHeld, todayDeliveredPct]
  );

  /** Every day this station has data for — today (live) plus whatever the archive holds, newest first. */
  const availableDates = useMemo(() => {
    const set = new Set<string>([today, ...rows.map((row) => row.date)]);
    return [...set].sort((a, b) => b.localeCompare(a));
  }, [today, rows]);

  function summaryFor(date: string): DaySummary | null {
    if (date === today) return todaySummary;
    const row = rowsByDate.get(date);
    return row ? { date, assigned: row.assigned, delivered: row.delivered, returned: row.returned, held: row.held, deliveredPct: row.deliveredPct } : null;
  }

  const [draftDates, setDraftDates] = useState<Set<string>>(new Set([today]));
  const [appliedDates, setAppliedDates] = useState<Set<string>>(new Set([today]));

  function applyPreset(dates: string[]) {
    const next = new Set(dates.filter((date) => availableDates.includes(date)));
    setDraftDates(next);
    setAppliedDates(next);
  }

  const dirty = draftDates.size !== appliedDates.size || [...draftDates].some((date) => !appliedDates.has(date));

  const selectedSummaries = useMemo(
    () => [...appliedDates].sort((a, b) => b.localeCompare(a)).map((date) => ({ date, summary: summaryFor(date) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appliedDates, rowsByDate, todaySummary]
  );
  const found = selectedSummaries.filter((row) => row.summary);
  const missing = selectedSummaries.filter((row) => !row.summary);

  const combined = useMemo(() => {
    const totals = found.reduce(
      (acc, row) => {
        const s = row.summary!;
        acc.assigned += s.assigned;
        acc.delivered += s.delivered;
        acc.returned += s.returned;
        acc.held += s.held;
        return acc;
      },
      { assigned: 0, delivered: 0, returned: 0, held: 0 }
    );
    const deliveredPct = totals.assigned > 0 ? Math.round((totals.delivered / totals.assigned) * 1000) / 10 : 0;
    return { ...totals, deliveredPct };
  }, [found]);

  const severity = combined.assigned > 0 ? deliverySeverity(combined.deliveredPct) : null;
  const rangeLabel = found.length === 1 ? formatCiaDisplayDate(found[0]!.date) : `${found.length} day${found.length === 1 ? "" : "s"} selected`;

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h3>By date</h3>
          <p className="subtle">Pick one or several days to see combined totals — driver-level detail lives in the By associate tab.</p>
        </div>
      </div>
      <div className="panel-body">
        <div className="edd-preset-row">
          <button type="button" className={`button secondary edd-chip edd-chip-today${appliedDates.size === 1 && appliedDates.has(today) ? " active" : ""}`} onClick={() => applyPreset([today])}>
            Today
          </button>
          <button type="button" className={`button secondary edd-chip${appliedDates.size === 1 && appliedDates.has(yesterday) ? " active" : ""}`} onClick={() => applyPreset([yesterday])}>
            Yesterday
          </button>
          <button type="button" className="button secondary edd-chip" onClick={() => applyPreset(availableDates.slice(0, 7))}>
            Last 7 days
          </button>
          <button type="button" className="button secondary edd-chip" onClick={() => applyPreset(availableDates.slice(0, 30))}>
            Last 30 days
          </button>
        </div>

        <div className="edd-range-form" style={{ alignItems: "center" }}>
          <EddMultiSelect
            label="days"
            options={availableDates}
            selected={draftDates}
            onChange={setDraftDates}
            renderOption={(date) => formatCiaDisplayDate(date)}
          />
          <div className="edd-range-actions">
            <button
              type="button"
              className="button"
              disabled={draftDates.size === 0 || !dirty}
              onClick={() => setAppliedDates(new Set(draftDates))}
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <Search size={14} /> Search
            </button>
          </div>
        </div>

        <div style={{ marginTop: 16 }}>
          {found.length ? (
            <>
              <div className="edd-performance-grid">
                <div className="edd-bucket-card static">
                  <span>Assigned</span>
                  <strong>{combined.assigned.toLocaleString("en-IN")}</strong>
                  <small>{rangeLabel}</small>
                </div>
                <div className="edd-bucket-card static future">
                  <span>Delivered</span>
                  <strong>{combined.delivered.toLocaleString("en-IN")}</strong>
                  <small>reached the customer</small>
                </div>
                <div className="edd-bucket-card static dueToday">
                  <span>Held</span>
                  <strong>{combined.held.toLocaleString("en-IN")}</strong>
                  <small>still moving through the station</small>
                </div>
                <div className="edd-bucket-card static overdue">
                  <span>Returned</span>
                  <strong>{combined.returned.toLocaleString("en-IN")}</strong>
                  <small>failed, rejected, or undeliverable</small>
                </div>
              </div>
              {severity ? (
                <div className="edd-insight-row">
                  <span className={`edd-insight-chip ${severity === "critical" ? "negative" : severity === "good" ? "positive" : ""}`}>
                    <span className={`edd-severity ${severity}`} style={{ marginRight: 6 }}>{deliverySeverityLabel(severity)}</span>
                    <strong>{combined.deliveredPct}%</strong> delivery performance across {found.length} day{found.length === 1 ? "" : "s"}
                  </span>
                </div>
              ) : null}

              {found.length > 1 ? (
                <div className="edd-table-wrap" style={{ marginTop: 14 }}>
                  <table className="edd-table compact">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th className="num">Assigned</th>
                        <th className="num">Delivered</th>
                        <th className="num">Held</th>
                        <th className="num">Returned</th>
                        <th className="num">Delivery Performance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {found.map((row) => {
                        const s = row.summary!;
                        const daySeverity = s.assigned > 0 ? deliverySeverity(s.deliveredPct) : null;
                        return (
                          <tr key={row.date}>
                            <td>{formatCiaDisplayDate(row.date)}</td>
                            <td className="num">{s.assigned.toLocaleString("en-IN")}</td>
                            <td className="num">{s.delivered.toLocaleString("en-IN")}</td>
                            <td className="num">{s.held.toLocaleString("en-IN")}</td>
                            <td className="num">{s.returned.toLocaleString("en-IN")}</td>
                            <td className="num">{daySeverity ? <span className={`edd-severity ${daySeverity}`}>{s.deliveredPct}%</span> : "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </>
          ) : (
            <p className="subtle">No archived data for the selected day(s) yet.</p>
          )}

          {missing.length ? (
            <p className="subtle" style={{ marginTop: 12 }}>
              No archived data yet for {missing.map((row) => formatCiaDisplayDate(row.date)).join(", ")} at {stationCode} — not swept/refreshed on {missing.length === 1 ? "that day" : "those days"}, or before the archive started. Totals above exclude {missing.length === 1 ? "it" : "them"}.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
