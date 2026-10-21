"use client";
import Link from "next/link";
import { Fragment, useMemo, useState } from "react";
import { stationScore, type ScorecardStation } from "./scorecard-math";
import styles from "./scorecard.module.css";

export type ScorecardDa = {
  station: string; id: string; name: string | null; dropx_id: string | null; days: number;
  delivered: number; assigned: number; returns: number; last_day: string; delivery_success_pct?: number | null;
};
export type ScorecardData = { stations: ScorecardStation[]; das: ScorecardDa[]; latest: string | null };

const n0 = (n: number) => Math.round(Number(n) || 0).toLocaleString("en-IN");
const n1 = (n: number) => (Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 1 });
const SORTS = { delivered: "Deliveries", perDa: "Per DA / day", change: "Change", returnRate: "Return rate", successPct: "Delivery success", das: "DAs" } as const;
const successLabel = (pct: number | null | undefined) => pct == null ? "Not available from source data" : `${n1(pct)}%`;
function csv(rows: (string | number | null)[][], name: string) {
  const esc = (v: unknown) => { let s = String(v ?? ""); if (/^[=+@\-]/.test(s)) s = "'" + s; return `"${s.replaceAll('"', '""')}"`; };
  const url = URL.createObjectURL(new Blob(["\ufeff" + rows.map((r) => r.map(esc).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}

function Spark({ points }: { points: Array<[string, number, number]> | null }) {
  const values = (points ?? []).map((p) => Number(p[1]) || 0);
  if (values.length < 2) return <span className={styles.muted}>—</span>;
  const max = Math.max(...values, 1), w = 84, h = 22;
  const d = values.map((v, i) => `${i ? "L" : "M"}${((i / (values.length - 1)) * w).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`).join(" ");
  return <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden><path d={d} fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>;
}

export function ScorecardView({ data, days, ranges, from, to, stationNames }: { data: ScorecardData; days: number; ranges: number[]; from: string; to: string; stationNames: Record<string, string> }) {
  const [sort, setSort] = useState<keyof typeof SORTS>("delivered");
  const [asc, setAsc] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const scored = useMemo(() => data.stations.map((s) => ({ ...s, ...stationScore(s) })), [data.stations]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return scored
      .filter((s) => !q || `${s.station} ${stationNames[s.station] ?? ""}`.toLowerCase().includes(q))
      .sort((a, b) => {
        const d = sort === "returnRate" ? b.returnRate - a.returnRate
          : sort === "change" ? (a.change ?? 0) - (b.change ?? 0)
          : sort === "successPct" ? (a.successPct ?? -1) - (b.successPct ?? -1)
          : (Number(b[sort]) || 0) - (Number(a[sort]) || 0);
        return asc ? -d : d;
      });
  }, [scored, sort, asc, query, stationNames]);
  const sortBy = (k: keyof typeof SORTS) => { if (k === sort) setAsc((v) => !v); else { setSort(k); setAsc(false); } };
  const arrow = (k: keyof typeof SORTS) => (sort === k ? (asc ? " ↑" : " ↓") : "");
  const attention = scored.filter((s) => s.flag).sort((a, b) => (a.change ?? 0) - (b.change ?? 0)).slice(0, 4);
  const improved = scored.filter((s) => (s.change ?? 0) > 5).sort((a, b) => (b.change ?? 0) - (a.change ?? 0)).slice(0, 4);
  function exportStations() {
    csv([["Station", "Name", "Deliveries", "Assigned", "Delivery success %", "Previous period", "Change %", "DAs", "DA-days", "Per DA per day", "Returns", "Return rate %", "Flag"],
      ...scored.map((s) => [s.station, stationNames[s.station] ?? "", s.delivered, s.assigned, s.successPct == null ? "Not available from source data" : s.successPct.toFixed(1), s.prev_delivered, s.change == null ? "" : s.change.toFixed(1), s.das, s.da_days, s.perDa.toFixed(1), s.returns, s.returnRate.toFixed(1), s.flag])], `delivery-scorecard-stations-${from}-${to}.csv`);
  }
  function exportDas() {
    csv([["Station", "DA", "DropX ID", "Provider ID", "Days", "Deliveries", "Assigned", "Delivery success %", "Per day", "Returns", "Last worked"],
      ...data.das.map((d) => [d.station, d.name, d.dropx_id, d.id, d.days, d.delivered, d.assigned, d.assigned > 0 ? ((d.delivered / d.assigned) * 100).toFixed(1) : "Not available from source data", d.days ? (d.delivered / d.days).toFixed(1) : "0", d.returns, d.last_day])], `delivery-scorecard-das-${from}-${to}.csv`);
  }
  const total = scored.reduce((t, s) => ({ delivered: t.delivered + s.delivered, assigned: t.assigned + s.assigned, prev: t.prev + s.prev_delivered, daDays: t.daDays + s.da_days, das: t.das + s.das, returns: t.returns + s.returns }), { delivered: 0, assigned: 0, prev: 0, daDays: 0, das: 0, returns: 0 });
  const change = total.prev ? ((total.delivered - total.prev) / total.prev) * 100 : null;
  const totalSuccess = total.assigned > 0 ? (total.delivered / total.assigned) * 100 : null;
  const dasBy = useMemo(() => {
    const m = new Map<string, ScorecardDa[]>();
    for (const d of data.das) m.set(d.station, [...(m.get(d.station) ?? []), d]);
    return m;
  }, [data.das]);

  return (
    <section className={styles.wrap}>
      <div className={styles.kpis}>
        <div><span>Deliveries</span><strong>{n0(total.delivered)}</strong><small>{from} → {to}</small></div>
        <div><span>Delivery success</span><strong>{totalSuccess == null ? "—" : `${n1(totalSuccess)}%`}</strong><small>{totalSuccess == null ? "Not available from source data" : `${n0(total.assigned)} assigned`}</small></div>
        <div><span>vs previous {days} days</span><strong className={change == null ? "" : change >= 0 ? styles.up : styles.down}>{change == null ? "—" : `${change >= 0 ? "+" : ""}${n1(change)}%`}</strong><small>{n0(total.prev)} before</small></div>
        <div><span>Per DA per day</span><strong>{n1(total.daDays ? total.delivered / total.daDays : 0)}</strong><small>{n0(total.daDays)} DA-days worked</small></div>
        <div><span>Return rate</span><strong>{n1(total.delivered + total.returns ? (total.returns / (total.delivered + total.returns)) * 100 : 0)}%</strong><small>Customer + MFN returns</small></div>
      </div>
      <div className={styles.bar}>
        <nav className={styles.ranges}>{ranges.map((r) => <Link key={r} href={`?days=${r}`} className={r === days ? styles.active : undefined} prefetch={false}>{r} days</Link>)}</nav>
        <input aria-label="Find station" placeholder="Find station" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className={styles.ghost} onClick={exportStations}>Stations CSV</button>
        <button className={styles.ghost} onClick={exportDas}>DAs CSV</button>
      </div>
      {attention.length || improved.length ? (
        <div className={styles.highlights}>
          {attention.length ? <div className={styles.hlBad}><b>Needs attention</b>{attention.map((s) => <button key={s.station} onClick={() => setOpen(s.station)}>{s.station}<small>{s.flag}{s.change != null ? ` · ${n1(s.change)}%` : ""}</small></button>)}</div> : null}
          {improved.length ? <div className={styles.hlGood}><b>Most improved</b>{improved.map((s) => <button key={s.station} onClick={() => setOpen(s.station)}>{s.station}<small>+{n1(s.change ?? 0)}%</small></button>)}</div> : null}
        </div>
      ) : null}
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead><tr><th>Station</th>{(["delivered", "successPct", "change", "das", "perDa", "returnRate"] as const).map((k) => <th key={k} className={styles.num}><button className={styles.sort} onClick={() => sortBy(k)} aria-sort={sort === k ? (asc ? "ascending" : "descending") : "none"}>{SORTS[k]}{arrow(k)}</button></th>)}<th>Daily trend</th><th /></tr></thead>
          <tbody>
            {rows.map((s) => (
              <Fragment key={s.station}>
                <tr className={s.flag ? styles.flagged : undefined}>
                  <td><b>{s.station}</b><small>{stationNames[s.station] ?? ""}{s.flag ? ` · ${s.flag}` : ""}</small></td>
                  <td className={styles.num}>{n0(s.delivered)}</td>
                  <td className={styles.num} title={s.successPct == null ? "Assigned count was not present in the import source" : undefined}>{successLabel(s.successPct)}</td>
                  <td className={`${styles.num} ${s.change == null ? "" : s.change >= 0 ? styles.up : styles.down}`}>{s.change == null ? "new" : `${s.change >= 0 ? "+" : ""}${n1(s.change)}%`}</td>
                  <td className={styles.num}>{s.das}</td>
                  <td className={styles.num}>{n1(s.perDa)}</td>
                  <td className={styles.num}>{n1(s.returnRate)}%</td>
                  <td className={styles.spark}><Spark points={s.trend} /></td>
                  <td><button className={styles.link} aria-expanded={open === s.station} onClick={() => setOpen(open === s.station ? null : s.station)}>{open === s.station ? "Hide DAs" : "DAs"}</button></td>
                </tr>
                {open === s.station ? (
                  <tr><td colSpan={9} className={styles.drill}>
                    <table className={styles.inner}>
                      <thead><tr><th>#</th><th>DA</th><th className={styles.num}>Days</th><th className={styles.num}>Deliveries</th><th className={styles.num}>Success</th><th className={styles.num}>Per day</th><th className={styles.num}>Returns</th><th>Last worked</th></tr></thead>
                      <tbody>{(dasBy.get(s.station) ?? []).map((d, i) => {
                        const perDay = d.days ? d.delivered / d.days : 0;
                        const daSuccess = d.assigned > 0 ? (d.delivered / d.assigned) * 100 : null;
                        return <tr key={d.id} className={perDay < s.perDa * 0.6 ? styles.low : undefined}><td>{i + 1}</td><td>{d.name ?? "—"} <small>{d.dropx_id ?? d.id}</small></td><td className={styles.num}>{d.days}</td><td className={styles.num}>{n0(d.delivered)}</td><td className={styles.num}>{successLabel(daSuccess)}</td><td className={styles.num}>{n1(perDay)}</td><td className={styles.num}>{n0(d.returns)}</td><td>{d.last_day}</td></tr>;
                      })}</tbody>
                    </table>
                    <p className={styles.muted}>Highlighted DAs deliver under 60% of the station&apos;s per-DA average. Delivery success needs an assigned count from the source file.</p>
                  </td></tr>
                ) : null}
              </Fragment>
            ))}
            {!rows.length ? <tr><td colSpan={9} className={styles.muted}>No deliveries in this period.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
