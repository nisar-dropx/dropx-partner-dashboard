"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { addDaysYmd, formatCiaDisplayDate, todayIstYmd } from "@/lib/ops-pulse/cia-types";
import type { EddPerformancePayload } from "@/lib/ops-pulse/edd-worker";

/** Same lookback ceiling CIA's own date-range picker uses. */
const MAX_LOOKBACK_DAYS = 90;

function validYmd(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function clampYmd(value: string, min: string, max: string) {
  if (!validYmd(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

async function fetchPerformance(stationCode: string, from: string, to: string): Promise<EddPerformancePayload> {
  const url = new URL("/api/ops-pulse/edd/performance", window.location.origin);
  url.searchParams.set("stationCode", stationCode);
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  const response = await fetch(url.toString(), { headers: { Accept: "application/json" }, cache: "no-store" });
  const raw = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(raw.error ?? `Unable to load the performance report (${response.status}).`));
  return raw as EddPerformancePayload;
}

/**
 * Assigned / delivered / returned / held for a station over a date range —
 * always a live Amazon fetch (see fetchEddPerformance), so this has its own
 * date-range picker rather than reusing the Ageing tab's cached-snapshot
 * "Filter to one day" control. Defaults to today.
 */
export function EddPerformanceView({ stationCode }: { stationCode: string }) {
  const today = todayIstYmd();
  const yesterday = addDaysYmd(today, -1);
  const earliestAllowed = addDaysYmd(today, -(MAX_LOOKBACK_DAYS - 1));

  const [appliedFrom, setAppliedFrom] = useState(today);
  const [appliedTo, setAppliedTo] = useState(today);
  const [draftFrom, setDraftFrom] = useState(today);
  const [draftTo, setDraftTo] = useState(today);
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<EddPerformancePayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPerformance(stationCode, appliedFrom, appliedTo)
      .then((data) => {
        if (!cancelled) setPayload(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Unable to load the performance report.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [stationCode, appliedFrom, appliedTo]);

  const dirty = draftFrom !== appliedFrom || draftTo !== appliedTo;
  const todaySelected = appliedFrom === today && appliedTo === today;
  const yesterdaySelected = appliedFrom === yesterday && appliedTo === yesterday;

  function applySingleDay(day: string) {
    const next = clampYmd(day, earliestAllowed, today);
    setDraftFrom(next);
    setDraftTo(next);
    setAppliedFrom(next);
    setAppliedTo(next);
    setFormError(null);
  }

  function applyPreset(days: number) {
    const to = today;
    const from = clampYmd(addDaysYmd(to, -(days - 1)), earliestAllowed, today);
    setDraftFrom(from);
    setDraftTo(to);
    setAppliedFrom(from);
    setAppliedTo(to);
    setFormError(null);
  }

  function applyRange() {
    const from = clampYmd(draftFrom, earliestAllowed, today);
    const to = clampYmd(draftTo, earliestAllowed, today);
    if (from > to) {
      setFormError("From date must be on or before To date.");
      return;
    }
    setFormError(null);
    setAppliedFrom(from);
    setAppliedTo(to);
  }

  const assigned = payload?.assigned ?? 0;

  return (
    <>
      <section className="panel">
        <div className="panel-body">
          <h3 style={{ margin: 0 }}>Check performance for a date range</h3>
          <p className="subtle" style={{ marginTop: 4 }}>
            Assigned, delivered, returned, and held packages for {stationCode} — defaults to today. Always pulled live
            from Amazon, so a wide range can take a little longer.
          </p>

          <div className="edd-preset-row" style={{ marginTop: 12 }}>
            <button type="button" className={`button secondary edd-chip edd-chip-today${todaySelected ? " active" : ""}`} onClick={() => applySingleDay(today)}>
              Today
            </button>
            <button type="button" className={`button secondary edd-chip${yesterdaySelected ? " active" : ""}`} onClick={() => applySingleDay(yesterday)}>
              Yesterday
            </button>
            <button type="button" className="button secondary edd-chip" onClick={() => applyPreset(7)}>
              Last 7 days
            </button>
            <button type="button" className="button secondary edd-chip" onClick={() => applyPreset(30)}>
              Last 30 days
            </button>
          </div>

          <div className="edd-range-form" style={{ marginTop: 12 }}>
            <label className="edd-range-field">
              <span>From date</span>
              <input
                type="date"
                className="field"
                min={earliestAllowed}
                max={today}
                value={draftFrom}
                onChange={(event) => {
                  const next = event.target.value;
                  if (!validYmd(next)) return;
                  setDraftFrom(clampYmd(next, earliestAllowed, today));
                  setFormError(null);
                }}
              />
            </label>
            <label className="edd-range-field">
              <span>To date</span>
              <input
                type="date"
                className="field"
                min={earliestAllowed}
                max={today}
                value={draftTo}
                onChange={(event) => {
                  const next = event.target.value;
                  if (!validYmd(next)) return;
                  setDraftTo(clampYmd(next, earliestAllowed, today));
                  setFormError(null);
                }}
              />
            </label>
            <div className="edd-range-actions">
              <button type="button" className="button" disabled={loading || !dirty} onClick={applyRange}>
                {loading ? <Loader2 size={16} className="edd-spin" /> : null}
                {loading ? "Loading…" : "Show results"}
              </button>
              {dirty ? (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => {
                    setDraftFrom(appliedFrom);
                    setDraftTo(appliedTo);
                    setFormError(null);
                  }}
                >
                  Reset
                </button>
              ) : null}
            </div>
          </div>
          {formError ? <p className="edd-range-error">{formError}</p> : null}
        </div>
      </section>

      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Unable to load performance for {stationCode}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{error}</p>
          </div>
        </section>
      ) : null}

      {loading && !payload ? (
        <section className="panel">
          <div className="panel-body" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Loader2 size={18} className="edd-spin" />
            <span className="subtle">Pulling assigned/delivered/returned/held live from Amazon…</span>
          </div>
        </section>
      ) : null}

      {payload ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>
                {formatCiaDisplayDate(payload.window.from)}
                {payload.window.from !== payload.window.to ? ` – ${formatCiaDisplayDate(payload.window.to)}` : ""}
              </h3>
              <p className="subtle">{assigned.toLocaleString("en-IN")} packages assigned to {stationCode} in this window.</p>
            </div>
          </div>
          <div className="panel-body">
            <div className="edd-performance-grid">
              <div className="edd-bucket-card static">
                <span>Assigned</span>
                <strong>{assigned.toLocaleString("en-IN")}</strong>
                <small>Total packages in this window</small>
              </div>
              <div className="edd-bucket-card static future">
                <span>Delivered</span>
                <strong>{payload.delivered.toLocaleString("en-IN")}</strong>
                <small>{payload.deliveredPct}% · reached the customer</small>
              </div>
              <div className="edd-bucket-card static dueToday">
                <span>Held</span>
                <strong>{payload.held.toLocaleString("en-IN")}</strong>
                <small>{payload.heldPct}% · still moving through the station</small>
              </div>
              <div className="edd-bucket-card static overdue">
                <span>Returned</span>
                <strong>{payload.returned.toLocaleString("en-IN")}</strong>
                <small>{payload.returnedPct}% · failed, rejected, or undeliverable</small>
              </div>
            </div>

            {assigned ? (
              <>
                <div className="edd-performance-bar" role="img" aria-label="Delivered, held, and returned share of assigned packages">
                  <div className="edd-performance-bar-segment delivered" style={{ width: `${payload.deliveredPct}%` }} />
                  <div className="edd-performance-bar-segment held" style={{ width: `${payload.heldPct}%` }} />
                  <div className="edd-performance-bar-segment returned" style={{ width: `${payload.returnedPct}%` }} />
                </div>
                <div className="edd-performance-legend">
                  <span><i className="edd-legend-dot delivered" aria-hidden="true" /> Delivered {payload.deliveredPct}%</span>
                  <span><i className="edd-legend-dot held" aria-hidden="true" /> Held {payload.heldPct}%</span>
                  <span><i className="edd-legend-dot returned" aria-hidden="true" /> Returned {payload.returnedPct}%</span>
                </div>
              </>
            ) : (
              <p className="subtle" style={{ marginTop: 10 }}>No packages were assigned to {stationCode} in this window.</p>
            )}
          </div>
        </section>
      ) : null}
    </>
  );
}
