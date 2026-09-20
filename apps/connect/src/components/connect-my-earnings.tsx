"use client";

import { ChevronLeft, ChevronRight, IndianRupee } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type Account = { id: string; profileType: string };
type ProductionLine = { label: string; count: number; rate: number; amount: number };
type DailyEarning = { date: string; amount: number; production: ProductionLine[] };
type Earning = { id: string; location: string; provider: string; model: string; paymentMethod: string; workDays: number; production: ProductionLine[]; daily: DailyEarning[]; baseAmount: number; additions: number; grossAmount: number };
type Payload = { month: string; earnings: Earning[]; summary: { workDays: number; baseAmount: number; additions: number; grossAmount: number } };

function money(value: number) { return `₹${Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`; }
function monthLabel(value: string) { return new Date(`${value}-01T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" }); }
function moveMonth(value: string, direction: number) { const [year, month] = value.split("-").map(Number); return `${year + Math.floor((month - 1 + direction) / 12)}-${String(((month - 1 + direction + 12) % 12) + 1).padStart(2, "0")}`; }

export function ConnectMyEarnings({ account }: { account: Account }) {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState<"monthly" | "daily">("monthly");
  const maxMonth = new Date().toISOString().slice(0, 7);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType, month });
      const response = await fetch(`/api/connect/earnings?${query}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to load earnings.");
      setData(payload);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load earnings."); }
    finally { setLoading(false); }
  }, [account.id, account.profileType, month]);
  useEffect(() => { void load(); }, [load]);
  const summary = data?.summary ?? { workDays: 0, baseAmount: 0, additions: 0, grossAmount: 0 };
  const rows = useMemo(() => data?.earnings ?? [], [data]);

  return <section className="dx-earnings">
    <header className="dx-page-intro">
      <small className="dx-page-eyebrow">Payments</small><h1>My Earnings</h1>
    </header>
    <div className="dx-requests-month">
      <button aria-label="Previous month" onClick={() => setMonth((value) => moveMonth(value, -1))}><ChevronLeft /></button>
      <strong>{monthLabel(month)}</strong>
      <button aria-label="Next month" disabled={month >= maxMonth} onClick={() => setMonth((value) => moveMonth(value, 1))}><ChevronRight /></button>
    </div>
    <div className="dx-earnings-view"><button className={view === "monthly" ? "active" : ""} onClick={() => setView("monthly")} type="button">Monthly</button><button className={view === "daily" ? "active" : ""} onClick={() => setView("daily")} type="button">Daily</button></div>
    {error ? <div className="dx-alert error">{error}</div> : null}
    {loading ? <div className="dx-loader"><span /><small>Loading earnings…</small></div> : <>
      <div className="dx-earnings-summary">
        <article><small>Work days</small><strong>{summary.workDays}</strong></article>
        <article><small>Production pay</small><strong>{money(summary.baseAmount)}</strong></article>
        <article><small>Additional pay</small><strong>{money(summary.additions)}</strong></article>
        <article className="total"><small>Gross earnings</small><strong>{money(summary.grossAmount)}</strong></article>
      </div>
      {rows.length && view === "monthly" ? <div className="dx-earnings-list">{rows.map((earning) => <article key={earning.id}>
        <header><span><strong>{earning.location}</strong><small>{earning.provider}</small></span><b>{money(earning.grossAmount)}</b></header>
        <div className="dx-earnings-meta"><span>{earning.paymentMethod}</span><span>{earning.workDays} work day{earning.workDays === 1 ? "" : "s"}</span></div>
        <div className="dx-earnings-lines">{earning.production.map((line) => <div key={line.label}><span><strong>{line.label}</strong><small>{line.count.toLocaleString("en-IN")} × {money(line.rate)}</small></span><b>{money(line.amount)}</b></div>)}</div>
        <footer><span>Production pay <b>{money(earning.baseAmount)}</b></span><span>Additional pay <b>{money(earning.additions)}</b></span></footer>
      </article>)}</div> : null}
      {rows.length && view === "daily" ? <div className="dx-earnings-list">{rows.flatMap((earning) => earning.daily.map((day) => ({ ...day, location: earning.location }))).sort((left, right) => right.date.localeCompare(left.date)).map((day) => <article key={`${day.location}-${day.date}`}>
        <header><span><strong>{new Date(`${day.date}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</strong><small>{day.location}</small></span><b>{money(day.amount)}</b></header>
        <div className="dx-earnings-lines">{day.production.map((line) => <div key={line.label}><span><strong>{line.label}</strong><small>{line.count.toLocaleString("en-IN")} × {money(line.rate)}</small></span><b>{money(line.amount)}</b></div>)}</div>
      </article>)}</div> : null}
      {!rows.length ? <div className="dx-advance-empty"><IndianRupee /><strong>No earnings for this month</strong></div> : null}
    </>}
  </section>;
}
