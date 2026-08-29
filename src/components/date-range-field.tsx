"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronDown } from "lucide-react";

type DateRangeFieldProps = {
  defaultFrom: string;
  defaultTo: string;
  fromName?: string;
  label?: string;
  toName?: string;
};

function displayDate(value: string) {
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}/${month}/${year}` : "Select date";
}

function today() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function offsetDate(days: number) {
  const date = new Date(`${today()}T00:00:00+05:30`);
  date.setDate(date.getDate() + days);
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

export function DateRangeField({
  defaultFrom,
  defaultTo,
  fromName = "from_date",
  label = "Report date range",
  toName = "to_date"
}: DateRangeFieldProps) {
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setFrom(defaultFrom);
    setTo(defaultTo);
  }, [defaultFrom, defaultTo]);

  useEffect(() => {
    if (!open) return;
    function close(event: MouseEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function selectRange(nextFrom: string, nextTo: string) {
    setFrom(nextFrom);
    setTo(nextTo);
  }

  const normalizedFrom = from <= to ? from : to;
  const normalizedTo = from <= to ? to : from;

  return (
    <div className="date-range-field" ref={wrapperRef}>
      <span className="date-range-label">{label}</span>
      <input name={fromName} readOnly type="hidden" value={normalizedFrom} />
      <input name={toName} readOnly type="hidden" value={normalizedTo} />
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`date-range-trigger ${open ? "open" : ""}`}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <CalendarDays aria-hidden="true" size={17} />
        <span>{displayDate(normalizedFrom)} <b>to</b> {displayDate(normalizedTo)}</span>
        <ChevronDown aria-hidden="true" className="date-range-chevron" size={16} />
      </button>
      {open ? (
        <div aria-label="Select attendance date range" className="date-range-popover" role="dialog">
          <div className="date-range-inputs">
            <label>
              From date
              <input
                className="field"
                onChange={(event) => {
                  const next = event.target.value;
                  setFrom(next);
                  if (next > to) setTo(next);
                }}
                type="date"
                value={from}
              />
            </label>
            <label>
              To date
              <input
                className="field"
                onChange={(event) => {
                  const next = event.target.value;
                  setTo(next);
                  if (next < from) setFrom(next);
                }}
                type="date"
                value={to}
              />
            </label>
          </div>
          <div className="date-range-quick-actions">
            <button onClick={() => selectRange(today(), today())} type="button">Today</button>
            <button onClick={() => selectRange(offsetDate(-6), today())} type="button">Last 7 days</button>
            <button onClick={() => selectRange(`${today().slice(0, 7)}-01`, today())} type="button">This month</button>
          </div>
          <button className="button date-range-apply" onClick={() => setOpen(false)} type="button">Apply range</button>
        </div>
      ) : null}
    </div>
  );
}
