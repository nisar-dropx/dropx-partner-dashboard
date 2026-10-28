"use client";
import Link from "next/link";
import { useState } from "react";
import { filterLossFacts, recoverableLossFacts, groupLossFacts, totalLossFacts, LOSS_SUMMARY_STATUSES, type LossFact } from "@/lib/ops-pulse/loss-station-summary";
import styles from "./loss-station-table.module.css";

const money = (n: number) => new Intl.NumberFormat("en-IN", { style:"currency", currency:"INR", maximumFractionDigits:0 }).format(n);
const date = (s: string) => s ? new Date(s).toLocaleDateString("en-IN",{day:"2-digit",month:"short",timeZone:"Asia/Kolkata"}) : "—";
const sorts = [["amount","Value · highest first"],["station","Station · A–Z"],["count","TIDs · highest first"],["pending","Pending update · highest first"],["remaining","Pending recovery · highest first"],["recovered","Recovered · highest first"],["updatedAt","Latest update"]];
function Pair({count,amount}:{count:number;amount:number}) { return <span className={styles.pair}><b>{count.toLocaleString("en-IN")}</b><span>{money(amount)}</span></span>; }

export function LossStationTable({ facts, title, initial = false, compact = false, href, controls = true, sort: selectedSort = "amount" }: {
  facts: LossFact[]; title: string; initial?: boolean; compact?: boolean; href: string; controls?: boolean; sort?: string;
}) {
  const [status,setStatus] = useState("all"), [sort,setSort] = useState(selectedSort);
  const filtered = filterLossFacts(facts,{status}), rows = groupLossFacts(filtered,controls?sort:selectedSort), total = totalLossFacts(filtered);
  function stationHref(station:string) {
    const [path,query] = href.split("?"), q = new URLSearchParams(query);
    q.set("station",station);
    q.set("phase",({pending_update:"pending_updates",updated:"updated",station:"todo",amazon:"amazon",nonrecoverable:"nonrecoverable"} as Record<string,string>)[status] || (compact ? "recoverable" : "all"));
    return `${path}?${q}`;
  }
  const metrics = (row: ReturnType<typeof totalLossFacts>) => <>
    <td><Pair count={row.count} amount={row.amount}/></td>
    {initial ? <>
      <td className={styles.warn}><Pair {...row.stationPending}/></td><td className={styles.info}><Pair {...row.amazon}/></td>
    </> : <>
      {!compact ? <><td className={styles.good}><Pair {...row.updated}/></td><td className={styles.warn}><Pair {...row.pending}/></td></> : null}
      <td className={styles.good}><Pair count={row.recoveredCount} amount={row.recovered}/></td>
      <td className={styles.warn}><Pair count={row.remainingCount} amount={row.remaining}/></td>
      {!compact ? <td><Pair {...row.nonrecoverable}/></td> : null}
    </>}
    {compact ? <td className={styles.rowBreakup}><span className={styles.warn}>Update pending <b>{row.pending.count} · {money(row.pending.amount)}</b></span><span className={styles.good}>Updated <b>{row.updated.count} · {money(row.updated.amount)}</b></span></td>:null}
    {!compact ? <td className={styles.dates}><span title={row.updatedAt}>Updated {date(row.updatedAt)}</span><span title={row.sourceAt}>Source {date(row.sourceAt)}</span></td> : null}
  </>;
  return <section className={`${styles.panel} ${compact ? styles.compact : ""}`} aria-label={title}>
    <div className={styles.head}><h2>{title}</h2>{controls ? <div className={styles.controls}>
      <select aria-label={`${title} status`} value={status} onChange={e=>setStatus(e.target.value)}>{LOSS_SUMMARY_STATUSES.filter(([key])=>initial ? ["all","station","amazon"].includes(key) : !["station","amazon"].includes(key)).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select>
      <select aria-label={`${title} sort`} value={sort} onChange={e=>setSort(e.target.value)}>{sorts.map(([key,label])=><option key={key} value={key}>{label}</option>)}</select>
    </div>:null}</div>
    <div className={styles.scroll}><table><caption className={styles.caption}>Each cell shows TIDs and value. Updated is saved recovery detail; recovered is posted payroll or an approved receipt.</caption><thead><tr><th>Station</th><th title={compact ? "Confirmed recoverable tracking IDs and value" : "Total tracking IDs and loss value"}>{compact ? "Recoverable" : "Total TIDs / value"}</th>
      {initial ? <><th>Waiting on station</th><th>Awaiting Amazon / final</th></> : <>{!compact?<><th>Updated</th><th>Pending update</th></>:null}<th>Recovered</th><th>Pending recovery</th>{!compact?<th>Non-recoverable</th>:null}</>}
      {compact?<th>Status breakup</th>:<th>Last dates</th>}</tr></thead><tbody>
      {rows.map(row=><tr key={row.station}><th scope="row"><Link href={stationHref(row.station)} prefetch={false}>{row.station} ↗</Link>{compact?<small className={styles.stationDate}>Updated {date(row.updatedAt)}</small>:null}</th>{metrics(row)}</tr>)}
      {!rows.length?<tr><td colSpan={initial?5:compact?5:8}>No cases match these filters.</td></tr>:null}
    </tbody>{rows.length>0?<tfoot><tr><th scope="row">Total</th>{metrics(total)}</tr></tfoot>:null}</table></div>
  </section>;
}

export function LossSummary({facts,ledgerReady}:{facts:LossFact[];ledgerReady:boolean}) {
  const [station,setStation]=useState(""),[period,setPeriod]=useState(""),[status,setStatus]=useState("all"),[sort,setSort]=useState("amount");
  const recoverable=recoverableLossFacts(facts);
  const filtered=filterLossFacts(recoverable,{station,period,status});
  const reset=()=>{setStation("");setPeriod("");setStatus("all");setSort("amount");};
  return <div className={styles.summary}>
    <div className={styles.filters}>
      <label>Station<select value={station} onChange={e=>setStation(e.target.value)}><option value="">All my stations</option>{[...new Set(recoverable.map(r=>r.station))].sort().map(s=><option key={s}>{s}</option>)}</select></label>
      <label>Loss period<select value={period} onChange={e=>setPeriod(e.target.value)}><option value="">All periods</option>{[...new Set(recoverable.map(r=>r.period))].sort().reverse().map(s=><option key={s}>{s}</option>)}</select></label>
      <label>Status<select value={status} onChange={e=>setStatus(e.target.value)}>{LOSS_SUMMARY_STATUSES.filter(([key])=>!["station","amazon","nonrecoverable"].includes(key)).map(([k,l])=><option key={k} value={k}>{l}</option>)}</select></label>
      <label>Sort<select value={sort} onChange={e=>setSort(e.target.value)}>{sorts.map(([k,l])=><option key={k} value={k}>{l}</option>)}</select></label><button type="button" onClick={reset}>Reset</button>
    </div>
    {!ledgerReady?<p role="status">Payroll recovery totals are unavailable. Recovered and pending recovery amounts are incomplete.</p>:null}
    <p className={styles.note}>Confirmed recoverable TIDs and ₹ value only. Recovered is posted payroll or approved receipts. Pending recovery includes cases without a plan and excludes waivers.</p>
    <div className={styles.sides}>{(["nl","slp"] as const).map(report=>{
      const rows=filtered.filter(r=>r.report===report), total=totalLossFacts(rows);
      const q=new URLSearchParams({view:"final"});
      if(period)q.set(report==="nl"?"month":"period",period);
      return <div key={report}><LossStationTable facts={rows} title={report.toUpperCase()} compact href={`/team-ops/losses/${report}?${q}`} controls={false} sort={sort}/>
        {total.waived > 0 ? <div className={styles.breakup}><span>Waived <b>{money(total.waived)}</b> · excluded from pending recovery</span></div> : null}
      </div>;
    })}</div>
    <Link href="/team-ops/losses/potential">Potential package loss report ↗</Link>
  </div>;
}
