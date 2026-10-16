"use client";
import Link from "next/link";
import { Fragment, useMemo, useState } from "react";
import { stationScore, type ScorecardStation } from "./scorecard-math";
import styles from "./scorecard.module.css";

export type ScorecardDa = { station: string; id: string; name: string | null; dropx_id: string | null; days: number; delivered: number; assigned: number; returns: number; last_day: string };
export type ScorecardData = { stations: ScorecardStation[]; das: ScorecardDa[]; latest: string | null };

const n0 = (n: number) => Math.round(Number(n) || 0).toLocaleString("en-IN");
const n1 = (n: number) => (Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 1 });
const SORTS = { delivered: "Deliveries", perDa: "Per DA / day", change: "Change", returnRate: "Return rate" } as const;

function Spark({ points }: { points: Array<[string, number, number]> | null }) {
  const values = (points ?? []).map((p) => Number(p[1]) || 0);
  if (values.length < 2) return <span className={styles.muted}>—</span>;
  const max = Math.max(...values, 1), w = 84, h = 22;
  const d = values.map((v, i) => `${i ? "L" : "M"}${((i / (values.length - 1)) * w).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`).join(" ");
  return <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden><path d={d} fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>;
}

export function ScorecardView({ data, days, ranges, from, to, stationNames }: { data: ScorecardData; days: number; ranges: number[]; from: string; to: string; stationNames: Record<string, string> }) {
  const [sort, setSort] = useState<keyof typeof SORTS>("delivered");
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const scored = useMemo(() => data.stations.map((s) => ({ ...s, ...stationScore(s) })), [data.stations]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return scored
      .filter((s) => !q || `${s.station} ${stationNames[s.station] ?? ""}`.toLowerCase().includes(q))
      .sort((a, b) => sort === "returnRate" ? b.returnRate - a.returnRate : sort === "change" ? (a.change ?? 0) - (b.change ?? 0) : (b[sort] as number) - (a[sort] as number));
  }, [scored, sort, query, stationNames]);
  const total = scored.reduce((t, s) => ({ delivered: t.delivered + s.delivered, prev: t.prev + s.prev_delivered, daDays: t.daDays + s.da_days, das: t.das + s.das, returns: t.returns + s.returns }), { delivered: 0, prev: 0, daDays: 0, das: 0, returns: 0 });
  const change = total.prev ? ((total.delivered - total.prev) / total.prev) * 100 : null;
  const dasBy = useMemo(() => {
    const m = new Map<string, ScorecardDa[]>();
    for (const d of data.das) m.set(d.station, [...(m.get(d.station) ?? []), d]);
    return m;
  }, [data.das]);

  return (
    <section className={styles.wrap}>
      <div className={styles.kpis}>
        <div><span>Deliveries</span><strong>{n0(total.delivered)}</strong><small>{from} → {to}</small></div>
        <div><span>vs previous {days} days</span><strong className={change == null ? "" : change >= 0 ? styles.up : styles.down}>{change == null ? "—" : `${change >= 0 ? "+" : ""}${n1(change)}%`}</strong><small>{n0(total.prev)} before</small></div>
        <div><span>Per DA per day</span><strong>{n1(total.daDays ? total.delivered / total.daDays : 0)}</strong><small>{n0(total.daDays)} DA-days worked</small></div>
        <div><span>Return rate</span><strong>{n1(total.delivered + total.returns ? (total.returns / (total.delivered + total.returns)) * 100 : 0)}%</strong><small>Customer + MFN returns</small></div>
      </div>
      <div className={styles.bar}>
        <nav className={styles.ranges}>{ranges.map((r) => <Link key={r} href={`?days=${r}`} className={r === days ? styles.active : undefined} prefetch={false}>{r} days</Link>)}</nav>
        <input aria-label="Find station" placeholder="Find station" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label>Sort <select value={sort} onChange={(e) => setSort(e.target.value as keyof typeof SORTS)}>{Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead><tr><th>Station</th><th className={styles.num}>Deliveries</th><th className={styles.num}>Change</th><th className={styles.num}>DAs</th><th className={styles.num}>Per DA / day</th><th className={styles.num}>Return rate</th><th>Daily trend</th><th /></tr></thead>
          <tbody>
            {rows.map((s) => (
              <Fragment key={s.station}>
                <tr className={s.flag ? styles.flagged : undefined}>
                  <td><b>{s.station}</b><small>{stationNames[s.station] ?? ""}{s.flag ? ` · ${s.flag}` : ""}</small></td>
                  <td className={styles.num}>{n0(s.delivered)}</td>
                  <td className={`${styles.num} ${s.change == null ? "" : s.change >= 0 ? styles.up : styles.down}`}>{s.change == null ? "new" : `${s.change >= 0 ? "+" : ""}${n1(s.change)}%`}</td>
                  <td className={styles.num}>{s.das}</td>
                  <td className={styles.num}>{n1(s.perDa)}</td>
                  <td className={styles.num}>{n1(s.returnRate)}%</td>
                  <td className={styles.spark}><Spark points={s.trend} /></td>
                  <td><button className={styles.link} aria-expanded={open === s.station} onClick={() => setOpen(open === s.station ? null : s.station)}>{open === s.station ? "Hide DAs" : "DAs"}</button></td>
                </tr>
                {open === s.station ? (
                  <tr><td colSpan={8} className={styles.drill}>
                    <table className={styles.inner}>
                      <thead><tr><th>#</th><th>DA</th><th className={styles.num}>Days</th><th className={styles.num}>Deliveries</th><th className={styles.num}>Per day</th><th className={styles.num}>Returns</th><th>Last worked</th></tr></thead>
                      <tbody>{(dasBy.get(s.station) ?? []).map((d, i) => {
                        const perDay = d.days ? d.delivered / d.days : 0;
                        return <tr key={d.id} className={perDay < s.perDa * 0.6 ? styles.low : undefined}><td>{i + 1}</td><td>{d.name ?? "—"} <small>{d.dropx_id ?? d.id}</small></td><td className={styles.num}>{d.days}</td><td className={styles.num}>{n0(d.delivered)}</td><td className={styles.num}>{n1(perDay)}</td><td className={styles.num}>{n0(d.returns)}</td><td>{d.last_day}</td></tr>;
                      })}</tbody>
                    </table>
                    <p className={styles.muted}>Highlighted DAs deliver under 60% of the station&apos;s per-DA average.</p>
                  </td></tr>
                ) : null}
              </Fragment>
            ))}
            {!rows.length ? <tr><td colSpan={8} className={styles.muted}>No deliveries in this period.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
