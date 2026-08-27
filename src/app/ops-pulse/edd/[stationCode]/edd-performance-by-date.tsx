"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { addDaysYmd, formatCiaDisplayDate, todayIstYmd } from "@/lib/ops-pulse/cia-types";
import type { EddPerformanceDailyRow } from "@/lib/ops-pulse/edd-worker";
import { deliverySeverity, deliverySeverityLabel } from "../edd-performance-severity";

/** How far back a single day can be fetched live and backfilled on demand — matches the worker's own backfill cap. */
const MAX_LOOKBACK_DAYS = 90;

/** Client-side call to this dashboard's own API route (never the worker directly — that needs a server-only admin key). */
async function fetchOrBackfillDay(stationCode: string, date: string): Promise<EddPerformanceDailyRow> {
  const url = new URL("/api/ops-pulse/edd/performance/backfill-day", window.location.origin);
  url.searchParams.set("stationCode", stationCode);
  url.searchParams.set("date", date);
  const response = await fetch(url.toString(), { method: "POST", headers: { Accept: "application/json" }, cache: "no-store" });
  const raw = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(raw.error ?? `Unable to fetch ${date} (${response.status}).`));
  return raw.day as EddPerformanceDailyRow;
}

type DaySummary = {
  date: string;
  assigned: number;
  delivered: number;
  returned: number;
  held: number;
  yetToDispatch: number;
  deliveredPct: number;
};

/**
 * Pick one day with a plain native date input (or combine several with the
 * preset chips) to see totals — a single day missing from the archive is
 * fetched and archived live from Amazon on the spot (see
 * fetchOrBackfillDay below), so "By date" never dead-ends on "not swept
 * yet" the way it used to. A native <input type="date"> (same edd-range-field
 * pattern as Ageing's own date filter) opens the browser's own compact
 * date-picker modal instead of an always-open custom calendar grid, which
 * read as oversized against the rest of the page.
 * Multi-day presets don't auto-fetch every missing day one at a time (that's
 * what the Day-wise ledger's bulk "Backfill" button is for) — they just
 * report which of the selected days aren't archived.
 */
export function EddPerformanceByDate({
  stationCode,
  rows,
  todayAssigned,
  todayDelivered,
  todayReturned,
  todayHeld,
  todayYetToDispatch,
  todayDeliveredPct
}: {
  stationCode: string;
  rows: EddPerformanceDailyRow[];
  todayAssigned: number;
  todayDelivered: number;
  todayReturned: number;
  todayHeld: number;
  todayYetToDispatch: number;
  todayDeliveredPct: number;
}) {
  const today = todayIstYmd();
  const yesterday = addDaysYmd(today, -1);
  const earliestAllowed = addDaysYmd(today, -(MAX_LOOKBACK_DAYS - 1));

  const [extraRows, setExtraRows] = useState<Map<string, EddPerformanceDailyRow>>(new Map());
  const [fetchingDate, setFetchingDate] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [appliedDates, setAppliedDates] = useState<Set<string>>(new Set([today]));

  const rowsByDate = useMemo(() => {
    const map = new Map(rows.map((row) => [row.date, row]));
    for (const [date, row] of extraRows) map.set(date, row);
    return map;
  }, [rows, extraRows]);

  const todaySummary: DaySummary = useMemo(
    () => ({ date: today, assigned: todayAssigned, delivered: todayDelivered, returned: todayReturned, held: todayHeld, yetToDispatch: todayYetToDispatch, deliveredPct: todayDeliveredPct }),
    [today, todayAssigned, todayDelivered, todayReturned, todayHeld, todayYetToDispatch, todayDeliveredPct]
  );

  function summaryFor(date: string): DaySummary | null {
    if (date === today) return todaySummary;
    const row = rowsByDate.get(date);
    return row ? { date, assigned: row.assigned, delivered: row.delivered, returned: row.returned, held: row.held, yetToDispatch: row.yetToDispatch, deliveredPct: row.deliveredPct } : null;
  }

  function applyPreset(dates: string[]) {
    setFetchError(null);
    setAppliedDates(new Set(dates.filter((date) => date >= earliestAllowed && date <= today)));
  }

  function selectSingleDay(date: string) {
    setFetchError(null);
    setAppliedDates(new Set([date]));
  }

  // A single selected day with no archived data yet (and not today) is
  // fetched live from Amazon and archived on the spot — the whole point of
  // "should be able to fetch older data directly if it's not in the snapshot".
  useEffect(() => {
    if (appliedDates.size !== 1) return;
    const [date] = [...appliedDates];
    if (date === today || rowsByDate.has(date) || date < earliestAllowed) return;
    if (fetchingDate === date) return;

    let cancelled = false;
    setFetchingDate(date);
    setFetchError(null);
    fetchOrBackfillDay(stationCode, date)
      .then((row) => {
        if (cancelled) return;
        setExtraRows((current) => {
          const next = new Map(current);
          next.set(date, row);
          return next;
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setFetchError(err instanceof Error ? err.message : `Unable to fetch ${formatCiaDisplayDate(date)} from Amazon.`);
      })
      .finally(() => {
        if (!cancelled) setFetchingDate((current) => (current === date ? null : current));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedDates, stationCode, today, earliestAllowed]);

  const selectedSummaries = useMemo(
    () => [...appliedDates].sort((a, b) => b.localeCompare(a)).map((date) => ({ date, summary: summaryFor(date) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appliedDates, rowsByDate, todaySummary]
  );
  const found = selectedSummaries.filter((row) => row.summary);
  const missing = selectedSummaries.filter((row) => !row.summary && row.date !== fetchingDate);

  const combined = useMemo(() => {
    const totals = found.reduce(
      (acc, row) => {
        const s = row.summary!;
        acc.assigned += s.assigned;
        acc.delivered += s.delivered;
        acc.returned += s.returned;
        acc.held += s.held;
        acc.yetToDispatch += s.yetToDispatch;
        return acc;
      },
      { assigned: 0, delivered: 0, returned: 0, held: 0, yetToDispatch: 0 }
    );
    const deliveredPct = totals.assigned > 0 ? Math.round((totals.delivered / totals.assigned) * 1000) / 10 : 0;
    return { ...totals, deliveredPct };
  }, [found]);

  const severity = combined.assigned > 0 ? deliverySeverity(combined.deliveredPct) : null;
  const rangeLabel = found.length === 1 ? formatCiaDisplayDate(found[0]!.date) : `${found.length} day${found.length === 1 ? "" : "s"} selected`;
  const selectedSingleDate = appliedDates.size === 1 ? [...appliedDates][0]! : today;

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h3>By date</h3>
          <p className="subtle">Pick a day (or combine several with the chips) — driver-level detail lives in the By associate tab.</p>
        </div>
      </div>
      <div className="panel-body">
        <div className="edd-preset-row">
          <button type="button" className={`button secondary edd-chip edd-chip-today${appliedDates.size === 1 && appliedDates.has(today) ? " active" : ""}`} onClick={() => selectSingleDay(today)}>
            Today
          </button>
          <button type="button" className={`button secondary edd-chip${appliedDates.size === 1 && appliedDates.has(yesterday) ? " active" : ""}`} onClick={() => selectSingleDay(yesterday)}>
            Yesterday
          </button>
          <button type="button" className="button secondary edd-chip" onClick={() => applyPreset(Array.from({ length: 7 }, (_, i) => addDaysYmd(today, -i)))}>
            Last 7 days
          </button>
          <button type="button" className="button secondary edd-chip" onClick={() => applyPreset(Array.from({ length: 30 }, (_, i) => addDaysYmd(today, -i)))}>
            Last 30 days
          </button>
        </div>

        <label className="edd-range-field" style={{ marginTop: 14, maxWidth: 200 }}>
          <span>Or pick a day</span>
          <input
            type="date"
            className="field"
            min={earliestAllowed}
            max={today}
            value={selectedSingleDate}
            onChange={(event) => {
              if (event.target.value) selectSingleDay(event.target.value);
            }}
          />
        </label>

        {fetchingDate ? (
          <p className="subtle" style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 6 }}>
            <Loader2 size={14} className="edd-spin" /> Fetching {formatCiaDisplayDate(fetchingDate)} live from Amazon and archiving it…
          </p>
        ) : null}
        {fetchError ? (
          <p className="subtle" style={{ marginTop: 12, color: "var(--red)" }}>{fetchError}</p>
        ) : null}

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
              {severity || combined.yetToDispatch > 0 ? (
                <div className="edd-insight-row">
                  {severity ? (
                    <span className={`edd-insight-chip ${severity === "critical" ? "negative" : severity === "good" ? "positive" : ""}`}>
                      <span className={`edd-severity ${severity}`} style={{ marginRight: 6 }}>{deliverySeverityLabel(severity)}</span>
                      <strong>{combined.deliveredPct}%</strong> delivery performance across {found.length} day{found.length === 1 ? "" : "s"}
                    </span>
                  ) : null}
                  {combined.yetToDispatch > 0 ? (
                    <span className="edd-insight-chip" title="Still at the station, no driver or store attached yet — not counted in Assigned above">
                      <strong>{combined.yetToDispatch.toLocaleString("en-IN")}</strong> yet to dispatch (not in Assigned)
                    </span>
                  ) : null}
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
                        <th className="num">Yet to dispatch</th>
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
                            <td className="num">{s.yetToDispatch ? s.yetToDispatch.toLocaleString("en-IN") : "—"}</td>
                            <td className="num">{daySeverity ? <span className={`edd-severity ${daySeverity}`}>{s.deliveredPct}%</span> : "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </>
          ) : !fetchingDate ? (
            <p className="subtle">No archived data for the selected day(s) yet.</p>
          ) : null}

          {missing.length ? (
            <p className="subtle" style={{ marginTop: 12 }}>
              No archived data yet for {missing.map((row) => formatCiaDisplayDate(row.date)).join(", ")} at {stationCode}. Pick just one of these days to fetch it live, or use "Backfill last 30 days" on the Day-wise ledger tab to fill in a whole range at once.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
