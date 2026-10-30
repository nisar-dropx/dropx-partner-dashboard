"use client";
import { useState } from "react";
import type { PnlTotal } from "@/lib/finance/pnl";

const money = (value: number | null) => value === null ? "Unavailable" : `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const shortMoney = (value: number) => `₹${new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 }).format(value)}`;
const date = (value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

export function PnlInsights({ daily, total, includeUnreportedDays=false, costItems }: { daily: PnlTotal[]; total: PnlTotal; includeUnreportedDays?:boolean; costItems?:{label:string;value:number;color:string}[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedCost, setSelectedCost] = useState<number | null>(null);
  const [view, setView] = useState("trend");
  const days = daily.filter(day => includeUnreportedDays ? day.revenue !== null || day.cost !== null : day.deliveries !== null);
  const active = days.find(d => d.key === selected) ?? days.at(-1);
  const max = Math.max(1, ...days.flatMap(d => [d.revenue ?? 0, d.cost ?? 0]));
  const min = Math.min(0, ...days.flatMap(d => [d.revenue ?? 0, d.cost ?? 0]));
  const dateNumber = (key: string) => Date.parse(`${key}T00:00:00Z`) / 86400000;
  const firstDay = days.length ? dateNumber(days[0].key) : 0;
  const lastDay = days.length ? dateNumber(days.at(-1)!.key) : 0;
  const x = (index: number) => 48 + (dateNumber(days[index].key) - firstDay) * 430 / Math.max(1, lastDay - firstDay);
  const y = (value: number) => 175 - (value - min) / (max - min) * 145;
  const series = (key: "revenue" | "cost") => days.map((day, i) => day[key] === null ? "" : `${i === 0 || days[i-1][key] === null || dateNumber(day.key) - dateNumber(days[i-1].key) > 1 ? "M" : "L"}${x(i).toFixed(1)},${y(day[key]!).toFixed(1)}`).join(" ");
  const costs = costItems ?? [
    { label: "Delivery associates", value: total.da, color: "#3578cb" },
    { label: "Station team", value: total.utr, color: "#8b66c4" },
    { label: "Vehicles & fuel", value: total.van, color: "#168777" },
    { label: "Rent & maintenance", value: total.rent, color: "#c78635" },
    { label: "Other costs", value: total.other, color: "#718391" },
  ];
  const sum = costs.reduce((n, c) => n + c.value, 0);
  let offset = 0;
  const hasAdjustments = costs.some(c => c.value < 0);
  return <section className={`pnl-insights showing-${view}`} aria-label="Business insights">
    <div className="pnl-insight-switch"><button aria-pressed={view === "trend"} onClick={() => setView("trend")}>Revenue & cost</button><button aria-pressed={view === "mix"} onClick={() => setView("mix")}>Expense mix</button></div>
    <article className="pnl-chart pnl-chart-trend">
      <header><div><span className="pnl-eyebrow">THE DAILY PICTURE</span><h2>Revenue meets cost</h2></div><span className="pnl-chart-legend"><i /> Revenue <i /> Cost</span></header>
      {active ? <>
        <svg viewBox="0 0 510 205" className="pnl-line-chart" role="img" aria-label={`Daily revenue and cost, ${date(days[0].key)} to ${date(days.at(-1)!.key)}. Choose a date below for exact figures.`}>
          {[0, .5, 1].map(f => <g key={f}><line x1="48" x2="488" y1={y(min + (max-min)*f)} y2={y(min+(max-min)*f)} stroke="#e7edf0" strokeDasharray="3 4" /><text x="0" y={y(min+(max-min)*f)+4} fill="#647785" fontSize="10">{shortMoney(min+(max-min)*f)}</text></g>)}
          <path d={series("revenue")} fill="none" stroke="#168777" strokeWidth="3" strokeLinejoin="round" />
          <path d={series("cost")} fill="none" stroke="#d98948" strokeWidth="2.5" strokeDasharray="5 3" strokeLinejoin="round" />
          {days.map((d,i) => <g key={d.key}>{d.revenue !== null && <circle cx={x(i)} cy={y(d.revenue)} r={d.key === active.key ? 5 : 2.5} fill="#168777" />}{d.cost !== null && <circle cx={x(i)} cy={y(d.cost)} r={d.key === active.key ? 4 : 2} fill="#d98948" />}</g>)}
          <text x="48" y="199" fill="#647785" fontSize="11">{date(days[0].key)}</text><text x="478" y="199" fill="#647785" fontSize="11" textAnchor="end">{days.length > 1 ? date(days.at(-1)!.key) : ""}</text>
        </svg>
        <div className="pnl-chart-readout"><label>Inspect day<select aria-label="Inspect chart day" value={active.key} onChange={e => setSelected(e.target.value)}>{days.map(d => <option key={d.key} value={d.key}>{date(d.key)}</option>)}</select></label><span>Revenue<strong>{money(active.revenue)}</strong></span><span>Cost<strong>{money(active.cost)}</strong></span><span>Profit / loss<strong className={(active.profit ?? 0) < 0 ? "pnl-negative" : "pnl-positive"}>{money(active.profit)}</strong></span></div>
      </> : <p className="pnl-empty">A trend will appear when delivery reports are available.</p>}
      <small>Reported dates only. Gaps and provisional inputs remain visible in the report.</small>
    </article>
    <article className="pnl-chart pnl-chart-mix"><header><div><span className="pnl-eyebrow">WHERE IT GOES</span><h2>Your expense mix</h2></div><small>Known operating costs</small></header>
      <div className="pnl-mix-layout">
        <div className="pnl-donut-wrap"><svg viewBox="0 0 180 180" role="img" aria-label={`Operating expense mix. Total ${money(total.cost)}. Values listed alongside.`}><circle cx="90" cy="90" r="69" fill="none" stroke="#edf2f4" strokeWidth="20" />{sum > 0 && !hasAdjustments && costs.map((cost, i) => { const share = cost.value / sum * 100; const start = offset; offset += share; return <circle key={cost.label} cx="90" cy="90" r="69" pathLength="100" fill="none" stroke={cost.color} strokeWidth={selectedCost === i ? 24 : 20} strokeDasharray={`${share} ${100-share}`} strokeDashoffset={-start} transform="rotate(-90 90 90)" opacity={selectedCost === null || selectedCost === i ? 1 : .25} />; })}</svg><div><small>{selectedCost === null ? "Total cost" : costs[selectedCost].label}</small><strong>{shortMoney(selectedCost === null ? sum : costs[selectedCost].value)}</strong></div></div>
        <div className="pnl-mix-legend">{costs.map((cost,i) => <button key={cost.label} aria-pressed={selectedCost === i} onClick={() => setSelectedCost(selectedCost === i ? null : i)}><i style={{background:cost.color}} /><span>{cost.label}<strong>{money(cost.value)}</strong></span><b>{sum > 0 ? `${(cost.value/sum*100).toFixed(1)}%` : "—"}</b></button>)}</div>
      </div>
      <small>{hasAdjustments ? "Credits are included in the amounts. A ring is not drawn for negative cost groups." : "Select a category to highlight its share. Expand the statement below for every source and calculation."}</small>
    </article>
  </section>;
}
