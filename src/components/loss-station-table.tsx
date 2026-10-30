"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { monthLabel } from "@/lib/ops-pulse/nl-loss-policy";
import {
  filterLossFacts,
  lossSummaryPeriods,
  filterLossSummaryPeriod,
  filterLossFactsByOwnership,
  recoverableLossFacts,
  groupLossFacts,
  totalLossFacts,
  LOSS_SUMMARY_STATUSES,
  type LossFact,
  type LossFactSort,
  type LossFactSortDirection,
} from "@/lib/ops-pulse/loss-station-summary";
import styles from "./loss-station-table.module.css";

const money = (n: number) => new Intl.NumberFormat("en-IN", { style:"currency", currency:"INR", minimumFractionDigits:2, maximumFractionDigits:2 }).format(n);
const date = (s: string) => s ? new Date(s).toLocaleDateString("en-IN",{day:"2-digit",month:"short",timeZone:"Asia/Kolkata"}) : "—";
const sorts: [LossFactSort, string][] = [["amount","Value · highest first"],["station","Station · A–Z"],["count","Shipments · highest first"],["pending","Pending update · highest first"],["remaining","Pending recovery · highest first"],["recovered","Recovered · highest first"],["updatedAt","Latest update"]];
function Pair({count,amount}:{count:number;amount:number}) { return <span className={styles.pair}><b>{count.toLocaleString("en-IN")}</b><span>{money(amount)}</span></span>; }

export function LossStationTable({ facts, title, initial = false, compact = false, href, controls = true, sort: selectedSort = "amount", sortDirection = "desc", sortableHeaders = false, onSort, headerControls, selectedStatus = "all", ledgerReady = true }: {
  facts: LossFact[]; title: string; headerControls?: ReactNode; selectedStatus?: string; ledgerReady?: boolean; initial?: boolean; compact?: boolean; href: string; controls?: boolean;
  sort?: LossFactSort; sortDirection?: LossFactSortDirection; sortableHeaders?: boolean; onSort?: (sort: LossFactSort) => void;
}) {
  const [status,setStatus] = useState("all"), [sort,setSort] = useState<LossFactSort>(selectedSort);
  const activeSort = controls ? sort : selectedSort;
  const activeDirection = controls ? (sort === "station" ? "asc" : "desc") : sortDirection;
  const activeStatus = controls ? status : selectedStatus;
  const filtered = filterLossFacts(facts,{status:activeStatus}), rows = groupLossFacts(filtered,activeSort,activeDirection), total = totalLossFacts(filtered);
  function stationHref(station:string) {
    const [path,query] = href.split("?"), q = new URLSearchParams(query);
    q.set("station",station);
    q.set("phase",({pending_update:"pending_updates",updated:"updated",station:"todo",amazon:"amazon",nonrecoverable:"nonrecoverable"} as Record<string,string>)[activeStatus] || (compact ? "recoverable" : "all"));
    return `${path}?${q}`;
  }
  const metrics = (row: ReturnType<typeof totalLossFacts>) => <>
    <td><Pair count={row.count} amount={row.amount}/></td>
    {initial ? <>
      <td className={styles.warn}><Pair {...row.stationPending}/></td><td className={styles.info}><Pair {...row.amazon}/></td>
    </> : <>
      {compact ? <>
        <td className={styles.warn}><Pair {...row.pending}/></td>
        <td className={styles.good}><Pair {...row.updated}/>{ledgerReady && row.draft > 0 ? <small className={styles.draft} title="Draft payroll is not yet confirmed as recovered">Draft {money(row.draft)}</small> : null}</td>
      </> : <><td className={styles.good}><Pair {...row.updated}/></td><td className={styles.warn}><Pair {...row.pending}/></td></>}
      <td className={styles.good}>{ledgerReady ? <Pair count={row.recoveredCount} amount={row.recovered}/> : <span title="Payroll recovery totals unavailable">—</span>}</td>
      {!compact ? <td className={styles.info}><Pair count={row.draftCount} amount={row.draft}/></td> : null}
      <td className={styles.warn}>{ledgerReady ? <Pair count={row.remainingCount} amount={row.remaining}/> : <span title="Payroll recovery totals unavailable">—</span>}</td>
      {!compact ? <td><Pair {...row.nonrecoverable}/></td> : null}
    </>}
    {!compact ? <td className={styles.dates}><span title={row.updatedAt}>Updated {date(row.updatedAt)}</span><span title={row.sourceAt}>Source {date(row.sourceAt)}</span></td> : null}
  </>;
  const sortHeader = (label: string, key: LossFactSort, title?: string) => sortableHeaders ? (
    <button
      type="button"
      className={`${styles.sortHeader} ${activeSort === key ? styles.sortActive : ""}`}
      onClick={() => onSort?.(key)}
      title={title || `Sort by ${label}`}
      aria-label={`${title || `Sort by ${label}`}${activeSort === key ? `, currently ${activeDirection === "asc" ? "ascending" : "descending"}` : ""}`}
    >
      <span>{label}</span><span aria-hidden="true">{activeSort === key ? (activeDirection === "asc" ? "↑" : "↓") : "↕"}</span>
    </button>
  ) : label;
  const ariaSort = (key: LossFactSort): "ascending" | "descending" | undefined => activeSort === key ? (activeDirection === "asc" ? "ascending" : "descending") : undefined;
  return <section className={`${styles.panel} ${compact ? styles.compact : ""}`} aria-label={title}>
    <div className={styles.head}><h2>{title}</h2>{headerControls}{controls ? <div className={styles.controls}>
      <select aria-label={`${title} status`} value={status} onChange={e=>setStatus(e.target.value)}>{LOSS_SUMMARY_STATUSES.filter(([key])=>initial ? ["all","station","amazon"].includes(key) : !["station","amazon"].includes(key)).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select>
      <select aria-label={`${title} sort`} value={sort} onChange={e=>setSort(e.target.value as LossFactSort)}>{sorts.map(([key,label])=><option key={key} value={key}>{label}</option>)}</select>
    </div>:null}</div>
    <div className={styles.scroll}><table><caption className={styles.caption}>Each cell shows shipment count and exact rupee value. Updated means recovery details saved, not money recovered. Recovered includes partial collections; outstanding includes unconfirmed draft payroll.</caption><thead><tr><th aria-sort={ariaSort("station")}>{sortHeader("Station", "station")}</th><th aria-sort={ariaSort("amount")} title={compact ? "Confirmed recoverable shipment count and value" : "Total tracking IDs and loss value"}>{sortHeader(compact ? "Recoverable" : "Total shipments / value", "amount", "Sort by loss value")}</th>
      {initial ? <><th>Waiting on station</th><th>Awaiting Amazon / final</th></> : <>
        {compact ? <><th aria-sort={ariaSort("pending")}>{sortHeader("Needs update", "pending", "Sort by pending update value")}</th><th title="Saved recovery details; not confirmed collections">Updated</th></> : <><th>Updated</th><th>Pending update</th></>}
        <th aria-sort={ariaSort("recovered")} title="Shipments with full or partial confirmed recovery">{sortHeader("Recovered", "recovered")}</th>
        {!compact ? <th title="Applied in an open payroll; included in pending recovery until payroll is confirmed">Draft payroll</th> : null}
        <th aria-sort={ariaSort("remaining")} title="Amount still to collect, including draft payroll">{sortHeader(compact ? "Outstanding" : "Pending recovery", "remaining")}</th>
        {!compact ? <th>Non-recoverable</th> : null}
      </>}
      {!compact ? <th>Last dates</th> : null}</tr></thead><tbody>
      {rows.map(row=><tr key={row.station}><th scope="row"><Link href={stationHref(row.station)} prefetch={false}>{row.station} ↗</Link>{compact?<small className={styles.stationDate}>Updated {date(row.updatedAt)}</small>:null}</th>{metrics(row)}</tr>)}
      {!rows.length?<tr><td colSpan={initial?5:compact?6:9}>No cases match these filters.</td></tr>:null}
    </tbody>{rows.length>0?<tfoot><tr><th scope="row">Total</th>{metrics(total)}</tr></tfoot>:null}</table></div>
  </section>;
}

type LossSummaryStation = {
  station: string;
  clusterKeys: string[];
  region: string;
};

export function LossSummary({facts,ledgerReady,stations,clusterOptions}:{
  facts:LossFact[];
  ledgerReady:boolean;
  stations:LossSummaryStation[];
  clusterOptions:{value:string;label:string}[];
}) {
  const [station,setStation]=useState(""),[cluster,setCluster]=useState(""),[region,setRegion]=useState(""),[status,setStatus]=useState("all");
  const [sort,setSort]=useState<LossFactSort>("amount"),[sortDirection,setSortDirection]=useState<LossFactSortDirection>("desc");
  const periodOptions={nl:lossSummaryPeriods(facts,"nl"),slp:lossSummaryPeriods(facts,"slp")};
  const [nlPeriod,setNlPeriod]=useState(()=>periodOptions.nl[0] || "");
  const [slpPeriod,setSlpPeriod]=useState(()=>periodOptions.slp[0] || "");
  const recoverable=recoverableLossFacts(facts);
  const factStations=new Set(recoverable.map((row)=>row.station));
  const scopedStations=stations.filter((item)=>factStations.has(item.station));
  const activeClusterKeys=new Set(scopedStations.flatMap((item)=>item.clusterKeys));
  const visibleClusters=clusterOptions.filter((item)=>activeClusterKeys.has(item.value));
  const regions=[...new Set(scopedStations.map((item)=>item.region))].sort((a,b)=>Number(a==="unmapped")-Number(b==="unmapped")||a.localeCompare(b));
  const ownershipFiltered=filterLossFactsByOwnership(recoverable,scopedStations,{cluster,region});
  const filtered=filterLossFacts(ownershipFiltered,{station,status});
  const stationOptions=[...new Set(ownershipFiltered.map((row)=>row.station))].sort();
  const reset=()=>{setStation("");setCluster("");setRegion("");setNlPeriod(periodOptions.nl[0] || "");setSlpPeriod(periodOptions.slp[0] || "");setStatus("all");setSort("amount");setSortDirection("desc");};
  const toggleSort=(next:LossFactSort)=>{
    if(next===sort){setSortDirection(current=>current==="asc"?"desc":"asc");return;}
    setSort(next);setSortDirection(next==="station"?"asc":"desc");
  };
  return <div className={styles.summary}>
    <div className={styles.filters}>
      <label>Station<select value={station} onChange={e=>setStation(e.target.value)}><option value="">All my stations</option>{stationOptions.map(s=><option key={s}>{s}</option>)}</select></label>
      <label>Cluster / AOM<select value={cluster} onChange={e=>{setCluster(e.target.value);setStation("");}}><option value="">All clusters / AOMs</option>{visibleClusters.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <label>Region<select value={region} onChange={e=>{setRegion(e.target.value);setStation("");}}><option value="">All regions</option>{regions.map(value=><option key={value} value={value}>{value==="unmapped"?"Region not mapped":value}</option>)}</select></label>
      <label>Status<select value={status} onChange={e=>setStatus(e.target.value)}>{LOSS_SUMMARY_STATUSES.filter(([key])=>!["station","amazon","nonrecoverable"].includes(key)).map(([k,l])=><option key={k} value={k} disabled={!ledgerReady && ["recovered","outstanding"].includes(k)}>{l}</option>)}</select></label>
      <button type="button" onClick={reset}>Reset</button>
    </div>
    {!ledgerReady?<p role="status">Payroll totals unavailable. Recovered and outstanding are hidden until they can be verified.</p>:null}
    <p className={styles.note}>Confirmed recoverable shipments · count / ₹ value. Updated ≠ recovered; draft payroll stays outstanding.</p>
    <div className={styles.sides}>{(["nl","slp"] as const).map(report=>{
      const period=report==="nl"?nlPeriod:slpPeriod;
      const rows=filterLossSummaryPeriod(filtered,report,period), total=totalLossFacts(rows);
      const q=new URLSearchParams({view:"final"});
      q.set(report==="nl"?"month":"period",period || "all");
      const periodControl=<label className={styles.period}>{report==="nl"?"NL loss month":"SLP file period"}
        <select value={period} onChange={e=>(report==="nl"?setNlPeriod:setSlpPeriod)(e.target.value)}>
          {periodOptions[report].map((value,index)=><option key={value} value={value}>{report==="nl"?monthLabel(value):value}{index===0?" · latest":""}</option>)}
          <option value="">All {report.toUpperCase()} periods</option>
        </select>
      </label>;
      return <div key={report}><LossStationTable facts={rows} title={report.toUpperCase()} compact href={`/team-ops/losses/${report}?${q}`} controls={false} sort={sort} sortDirection={sortDirection} sortableHeaders onSort={toggleSort} headerControls={periodControl} selectedStatus={status} ledgerReady={ledgerReady}/>
        {ledgerReady && total.waived > 0 ? <div className={styles.breakup}><span>Waived <b>{money(total.waived)}</b> · excluded from pending recovery</span></div> : null}
      </div>;
    })}</div>
    <Link href="/team-ops/losses/potential">Potential package loss report ↗</Link>
  </div>;
}
