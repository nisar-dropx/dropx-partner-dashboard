"use client";
import { useMemo, useState } from "react";
import { ArrowRight, RefreshCw, Search, ShieldCheck, MapPin } from "lucide-react";
import type { EddStationOption } from "@/lib/ops-pulse/edd-stations";
import { STATION_EDD_RULE, stationEddFreshness, summarizeStationEdd, type StationEddSummary } from "@/lib/ops-pulse/station-edd";
import { StationEddDownload } from "./station-edd-download";
import s from "./station-edd.module.css";

const cols = [["todayAtStation","Pending","atStation"],["todayOnRoad","On road","onRoad"],["todayDelivered","Delivered","delivered"],["todayHfr","HFR","hfr"],["todayUnverified","To verify","unverified"],["overdueAtStation","Overdue pending","atStation"]] as const;
type Sort = "stationCode" | typeof cols[number][0];
const href = (code:string,position="atStation",day="today") => `/edd/${encodeURIComponent(code)}/edds?position=${position}&day=${day}`;
const n = (value:number) => value.toLocaleString("en-IN");
export function StationEddNetworkClient({stations,initialNetwork,initialError}:{stations:EddStationOption[];initialNetwork:StationEddSummary[];initialError:string|null}) {
  const [rows,setRows] = useState(initialNetwork.length ? initialNetwork : stations.map(v=>summarizeStationEdd(v.code,null,null)));
  const [query,setQuery] = useState(""); const [sort,setSort] = useState<Sort>("todayAtStation");
  const [asc,setAsc] = useState(false); const [busy,setBusy] = useState("");
  const [error,setError] = useState(initialError); const [message,setMessage] = useState("");
  const [period,setPeriod] = useState("today");
  const names = useMemo(()=>new Map(stations.map(v=>[v.code,v.name])),[stations]);
  const filtered = useMemo(()=>rows.filter(r=>`${r.stationCode} ${names.get(r.stationCode)}`.toLowerCase().includes(query.trim().toLowerCase())).sort((a,b)=>(typeof a[sort] === "number" ? Number(a[sort])-Number(b[sort]) : String(a[sort]).localeCompare(String(b[sort])))*(asc?1:-1)),[rows,names,query,sort,asc]);
  const sum = (key:typeof cols[number][0] | "todayTotal" | "missingDate") => rows.reduce((v,r)=>v+r[key],0);
  async function reload(verify=false) {
    setBusy(verify?"verify":"reload"); setError(null); setMessage("");
    try {
      if (verify) {
        const response = await fetch("/api/ops-pulse/station-edd/verify",{method:"POST"});
        const body = await response.json(); if(!response.ok) throw new Error(body.error || "Verification failed.");
        setMessage(body.busy ? "Background verification is already running, or no records are due for a check." : `${body.verified} histories verified; ${body.failed} could not be verified. Remaining records stay visible in To verify.`);
      }
      const response = await fetch("/api/ops-pulse/station-edd/network",{cache:"no-store"});
      const body = await response.json(); if(!response.ok) throw new Error(body.error || "Counts could not be loaded.");
      setRows(body.stations);
    } catch(e) { setError(e instanceof Error ? e.message : "Unable to refresh."); }
    finally { setBusy(""); }
  }
  return <div className={s.workspace}>
    <div className={s.contextBar}><span><MapPin size={15}/> {stations.length} locations in your access</span><span>EDD {rows[0]?.today} <i/> India Standard Time</span></div>
    <section className={s.metrics} aria-label="Today's EDD position">
      {[["Known EDDs today",sum("todayTotal"),"Retained after dispatch and delivery","neutral"],["Pending first dispatch",sum("todayAtStation"),`${n(sum("todayUnverified"))} station packages awaiting history checks`,"orange"],["On the road",sum("todayOnRoad"),"Dispatched, not yet completed","blue"],["Delivered",sum("todayDelivered"),"Confirmed delivery outcome","green"],["HFR",sum("todayHfr"),"Attempted before today · separate cohort","purple"]].map(([label,count,hint,tone])=><div key={label} className={`${s.metric} ${s[String(tone)]}`}><span>{label}</span><strong>{n(Number(count))}</strong><small>{hint}</small></div>)}
    </section>
    <section className={s.panel}>
      <div className={s.panelHead}><div><span className={s.eyebrow}>NETWORK OVERVIEW</span><h2>Every station. One clear view.</h2><p>Today’s EDD position. Select a count to open its tracking IDs.</p></div><div className={s.actions}><button className={s.button} disabled={!!busy} onClick={()=>void reload()}><RefreshCw size={15} className={busy==="reload"?s.spin:""}/> Reload</button><StationEddDownload href="/api/ops-pulse/station-edd/network/report" label="Station report"/></div></div>
      <div className={s.coverage}><ShieldCheck size={20}/><div><strong>History-verified pending, with transparent coverage</strong><p>{n(sum("todayUnverified"))} due-today station TIDs still need history checks. {n(sum("missingDate"))} recent records have no confirmed EDD date and are excluded from today’s totals. Background checks fill these gaps; the totals are the known cohort, not a claim of full source coverage.</p></div><button className={s.button} disabled={!!busy} onClick={()=>void reload(true)}>{busy==="verify"?"Checking histories…":"Verify next batch"}</button></div>
      <div className={s.toolbar}><div className={s.search}><Search size={17}/><input type="search" aria-label="Search stations" placeholder="Search station code or location" value={query} onChange={e=>setQuery(e.target.value)}/></div><span className={s.muted}>{filtered.length} of {stations.length} locations</span><div className={s.exportGroup}><select aria-label="Download EDD period" value={period} onChange={e=>setPeriod(e.target.value)}><option value="today">Pending · today</option><option value="overdue">Pending · overdue</option><option value="pending">Pending · today + overdue</option></select><StationEddDownload href={`/api/ops-pulse/station-edd/network/report?report=pending&day=${period}`} label="Download TIDs"/></div></div>
      {error?<p className={s.error} role="alert">{error}</p>:null}{message?<p className={s.notice} role="status">{message}</p>:null}
      <div className={s.tableWrap}><table className={s.table}><thead><tr><th aria-sort={sort==="stationCode"?(asc?"ascending":"descending"):"none"}><button onClick={()=>{setSort("stationCode");setAsc(sort==="stationCode"?!asc:true);}}>Station {sort==="stationCode"?(asc?"↑":"↓"):""}</button></th>{cols.map(([key,label])=><th key={key} className={s.numeric} aria-sort={sort===key?(asc?"ascending":"descending"):"none"}><button onClick={()=>{setSort(key);setAsc(sort===key?!asc:false);}}>{label} {sort===key?(asc?"↑":"↓"):""}</button></th>)}<th>Latest observation</th><th><span className={s.srOnly}>Open station</span></th></tr></thead><tbody>
        {filtered.map(row=><tr key={row.stationCode}><td><a className={s.stationLink} href={href(row.stationCode)}><span className={s.stationIcon}><MapPin size={17}/></span><span><strong>{row.stationCode}</strong><small>{names.get(row.stationCode)}</small></span></a></td>{cols.map(([key,label,position])=><td className={s.numeric} key={key}>{row.hasSnapshot?<a className={key==="todayAtStation"?s.pendingNumber:s.numberLink} href={href(row.stationCode,position,key==="overdueAtStation"?"overdue":"today")} aria-label={`${row.stationCode} ${label}: ${row[key]} TIDs`}>{key==="todayAtStation"&&!row[key]&&row.todayUnverified?"Checking":n(row[key])}</a>:<span className={s.muted}>—</span>}</td>)}<td><span className={s.timestamp}>{row.fetchedAt?new Date(row.fetchedAt).toLocaleString("en-IN",{timeZone:"Asia/Kolkata",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}):"No records"}</span><small className={stationEddFreshness(row.fetchedAt)==="Recent snapshot"?s.fresh:s.stale}>{stationEddFreshness(row.fetchedAt)==="Recent snapshot"?"Recent observations":"Older observations"}</small></td><td><a className={s.iconButton} aria-label={`Open ${row.stationCode} details`} href={href(row.stationCode)}><ArrowRight size={18}/></a></td></tr>)}
      </tbody></table></div>{!filtered.length?<div className={s.empty}>No stations match “{query}”.</div>:null}
      <div className={s.footer}>All {filtered.length} matching locations shown · no hidden pages. Pending excludes dispatched, delivered and attempted TIDs.</div>
    </section>
    <details className={s.definitions}><summary>Counting rules & data coverage</summary><p>{STATION_EDD_RULE}</p><p>The ledger retains observed packages after they leave backlog. It includes records seen in the last seven days; unknown EDD dates and unverified history remain explicit. HFR counts here are for packages whose EDD is today; open a station to inspect other date periods.</p></details>
  </div>;
}
