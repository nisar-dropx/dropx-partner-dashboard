"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { addDaysYmd, todayIstYmd } from "@/lib/ops-pulse/cia-types";

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

/**
 * Buttons (Today / Yesterday / Last 7 / Last 30) + From/To date inputs +
 * Show results/Reset — the CIA station-page pattern, shared by the EDD
 * performance views (station and network) since both need the same
 * "pick a window, then apply it" control.
 */
export function EddDateRangePicker({
  from,
  to,
  onApply,
  loading = false
}: {
  from: string;
  to: string;
  onApply: (from: string, to: string) => void;
  loading?: boolean;
}) {
  const today = todayIstYmd();
  const yesterday = addDaysYmd(today, -1);
  const earliestAllowed = addDaysYmd(today, -(MAX_LOOKBACK_DAYS - 1));

  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setDraftFrom(from);
    setDraftTo(to);
    setFormError(null);
  }, [from, to]);

  const dirty = draftFrom !== from || draftTo !== to;
  const todaySelected = from === today && to === today;
  const yesterdaySelected = from === yesterday && to === yesterday;

  function applySingleDay(day: string) {
    const next = clampYmd(day, earliestAllowed, today);
    setFormError(null);
    onApply(next, next);
  }

  function applyPreset(days: number) {
    const rangeTo = today;
    const rangeFrom = clampYmd(addDaysYmd(rangeTo, -(days - 1)), earliestAllowed, today);
    setFormError(null);
    onApply(rangeFrom, rangeTo);
  }

  function applyRange() {
    const nextFrom = clampYmd(draftFrom, earliestAllowed, today);
    const nextTo = clampYmd(draftTo, earliestAllowed, today);
    if (nextFrom > nextTo) {
      setFormError("From date must be on or before To date.");
      return;
    }
    setFormError(null);
    onApply(nextFrom, nextTo);
  }

  return (
    <>
      <div className="edd-preset-row">
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
                setDraftFrom(from);
                setDraftTo(to);
                setFormError(null);
              }}
            >
              Reset
            </button>
          ) : null}
        </div>
      </div>
      {formError ? <p className="edd-range-error">{formError}</p> : null}
    </>
  );
}
