"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { CpsParams } from "@/lib/ops-pulse/cps";

export function CpsFilters({
  params,
  period,
  today,
}: {
  params: CpsParams;
  period: {
    mode: string;
    date: string;
    month: string;
    from: string;
    to: string;
  };
  today: string;
}) {
  const router = useRouter(),
    [pending, start] = useTransition(),
    [from, setFrom] = useState(period.from),
    [to, setTo] = useState(period.to),
    [error, setError] = useState("");
  const yesterday = new Date(Date.parse(today) - 86400000)
    .toISOString()
    .slice(0, 10);
  const lastMonthEnd = new Date(
    Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, 0),
  )
    .toISOString()
    .slice(0, 10);
  const presets = [
    {
      label: "MTD",
      from: `${today.slice(0, 7)}-01`,
      to: yesterday.slice(0, 7) === today.slice(0, 7) ? yesterday : today,
    },
    {
      label: "Last month",
      from: `${lastMonthEnd.slice(0, 7)}-01`,
      to: lastMonthEnd,
    },
    { label: "Yesterday", from: yesterday, to: yesterday },
    { label: "Today", from: today, to: today },
  ];
  function apply(a: string, b: string) {
    if (!a || !b || a > b || b > today) {
      setError("Choose a valid date range ending on or before today.");
      return;
    }
    if ((Date.parse(b) - Date.parse(a)) / 86400000 >= 93) {
      setError("Choose up to 93 days at a time.");
      return;
    }
    setError("");
    setFrom(a);
    setTo(b);
    const q = new URLSearchParams(window.location.search);
    q.set("view", "overview");
    q.set("period", "custom");
    q.set("from", a);
    q.set("to", b);
    q.delete("date");
    q.delete("month");
    start(() => router.push(`/cps?${q}`, { scroll: false }));
  }
  return (
    <section
      className="panel cps-date-panel"
      aria-label="CPS date range"
      aria-busy={pending}
    >
      <div className="cps-date-heading">
        <div>
          <strong>Report period</strong>
          <p>
            Applies to the comparison and station details. Monthly costs accrue
            by calendar day.
          </p>
        </div>
        <div className="cps-quick-periods">
          {presets.map((p) => (
            <button
              type="button"
              key={p.label}
              aria-pressed={period.from === p.from && period.to === p.to}
              disabled={pending}
              onClick={() => apply(p.from, p.to)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <form
        className="cps-date-form"
        onSubmit={(e) => {
          e.preventDefault();
          apply(from, to);
        }}
      >
        <label>
          From
          <input
            type="date"
            required
            max={today}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          Through
          <input
            type="date"
            required
            min={from}
            max={today}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <button className="button primary" disabled={pending}>
          {pending ? "Loading costs…" : "Apply dates"}
        </button>
        <button
          className="button"
          type="button"
          disabled={pending}
          onClick={() => start(() => router.refresh())}
        >
          Refresh data
        </button>
        <span>Custom ranges up to 93 days</span>
      </form>
      {error && (
        <p className="cps-form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
