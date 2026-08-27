"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

const WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function parseYmd(ymd: string): { y: number; m: number; d: number } {
  const [y, m, d] = ymd.split("-").map((part) => Number(part));
  return { y: y || 1970, m: m || 1, d: d || 1 };
}

function toYmd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Days in calendar month `m` (1-indexed) of year `y`. */
function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate();
}

/** 0 (Sunday) .. 6 (Saturday) for the 1st of calendar month `m` (1-indexed) of year `y`. */
function firstWeekday(y: number, m: number): number {
  return new Date(y, m - 1, 1).getDay();
}

/**
 * A real month-grid calendar for picking one day — replaces the plain
 * dropdown/checklist day picker. Days with archived data (or today, always
 * live) get a dot; days before `minDate` or after `maxDate` are disabled.
 * Click a day to select it — the caller (EddPerformanceByDate) decides what
 * happens next (show it if archived, fetch-and-archive it live if not).
 */
export function EddPerformanceCalendar({
  selectedDate,
  onSelectDate,
  archivedDates,
  today,
  minDate
}: {
  selectedDate: string;
  onSelectDate: (date: string) => void;
  archivedDates: Set<string>;
  today: string;
  minDate: string;
}) {
  const initial = parseYmd(selectedDate || today);
  const [viewYear, setViewYear] = useState(initial.y);
  const [viewMonth, setViewMonth] = useState(initial.m);

  const cells = useMemo(() => {
    const total = daysInMonth(viewYear, viewMonth);
    const leading = firstWeekday(viewYear, viewMonth);
    const list: Array<string | null> = [];
    for (let i = 0; i < leading; i++) list.push(null);
    for (let day = 1; day <= total; day++) list.push(toYmd(viewYear, viewMonth, day));
    return list;
  }, [viewYear, viewMonth]);

  function shiftMonth(delta: number) {
    let m = viewMonth + delta;
    let y = viewYear;
    if (m < 1) {
      m = 12;
      y -= 1;
    } else if (m > 12) {
      m = 1;
      y += 1;
    }
    setViewYear(y);
    setViewMonth(m);
  }

  const todayParsed = parseYmd(today);
  const atMaxMonth = viewYear === todayParsed.y && viewMonth === todayParsed.m;
  const monthLabel = new Date(viewYear, viewMonth - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  return (
    <div className="edd-calendar">
      <div className="edd-calendar-head">
        <button type="button" className="edd-calendar-nav" onClick={() => shiftMonth(-1)} aria-label="Previous month">
          <ChevronLeft size={15} />
        </button>
        <strong>{monthLabel}</strong>
        <button type="button" className="edd-calendar-nav" onClick={() => shiftMonth(1)} disabled={atMaxMonth} aria-label="Next month">
          <ChevronRight size={15} />
        </button>
      </div>
      <div className="edd-calendar-weekdays">
        {WEEKDAY_LABELS.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
      <div className="edd-calendar-grid">
        {cells.map((date, index) => {
          if (!date) return <span key={`blank-${index}`} className="edd-calendar-cell blank" aria-hidden />;
          const disabled = date > today || date < minDate;
          const isToday = date === today;
          const isSelected = date === selectedDate;
          const hasData = isToday || archivedDates.has(date);
          return (
            <button
              key={date}
              type="button"
              className={`edd-calendar-cell${isSelected ? " selected" : ""}${isToday ? " today" : ""}`}
              disabled={disabled}
              onClick={() => onSelectDate(date)}
              title={date}
            >
              {Number(date.slice(-2))}
              {hasData && !disabled ? <i className="edd-calendar-dot" /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
