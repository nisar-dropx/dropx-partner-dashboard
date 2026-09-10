"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emptyUnplannedFilters, filterUnplannedRows, unplannedQuery, type UnplannedFilters, type UnplannedWorkspace } from "@/lib/ops-pulse/unplanned-leaves";
import "./ops-unplanned-leaves.css";

const dateLabel=(value:string)=>new Date(value+"T12:00:00Z").toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric",timeZone:"Asia/Kolkata"});
const checkedLabel=(value:string)=>new Date(value).toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit",timeZone:"Asia/Kolkata"});
const distinct=(values:(string|null)[])=>[...new Set(values.filter((s):s is string=>Boolean(s)))].sort();
export function OpsUnplannedLeaves({initial,initialFilters}: {initial:UnplannedWorkspace;initialFilters:UnplannedFilters}) {
  const [data,setData]=useState(initial), [filters,setFilters]=useState(initialFilters), [date,setDate]=useState(initial.date);
  const [busy,setBusy]=useState(false), [error,setError]=useState(""), [page,setPage]=useState(0);
  const requestId=useRef(0);
  const badManager=Boolean(filters.manager && !data.managers.some(m=>m.id===filters.manager));
  const rows=useMemo(()=>badManager?[]:filterUnplannedRows(data,filters),[data,filters,badManager]);
  const selectedManager=data.managers.find(m=>m.id===filters.manager);
  const baseManager=filters.manager||data.viewerPersonId;
  const branches=data.managers.filter(m=>m.id!==baseManager && m.managerPersonIds[0]===baseManager)
    .map(m=>({...m,count:data.rows.filter(r=>r.manager_person_ids.includes(m.id)).length}))
    .filter(m=>m.count).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name));
  function change(next:Partial<UnplannedFilters>) {
    const updated={...filters,...next};setFilters(updated);setPage(0);
    window.history.replaceState(null,"","?"+unplannedQuery(data.date,updated));
  }
  const refresh=useCallback(async (event?:React.FormEvent) => {
    event?.preventDefault();const id=++requestId.current;setBusy(true);setError("");
    try {
      const response=await fetch("/api/ops-pulse/unplanned-leaves?"+new URLSearchParams({date}),{cache:"no-store"});
      const result=await response.json();if(!response.ok)throw Error(result.error||"Attendance could not be checked.");
      if(id!==requestId.current)return;
      setData(result);setPage(0);
      window.history.replaceState(null,"","?"+unplannedQuery(result.date,filters));
    } catch(e) {if(id===requestId.current)setError(e instanceof Error?e.message:"Attendance could not be checked.");}
    finally {if(id===requestId.current)setBusy(false);}
  },[date,filters]);
  useEffect(()=>{
    const timer=window.setInterval(()=>{if(document.visibilityState==="visible" && navigator.onLine && !busy && date===data.date) void refresh();},120000);
    return ()=>window.clearInterval(timer);
  },[refresh,busy,date,data.date]);
  const pageCount=Math.max(1,Math.ceil(rows.length/25));
  const exportUrl="/api/ops-pulse/unplanned-leaves?"+unplannedQuery(data.date,filters)+"&format=xlsx";
  return <div className="oul">
    <section className="panel oul-intro">
      <div><span className="oul-eyebrow">OPS PULSE · ATTENDANCE</span><h1>Unplanned Leaves</h1>
        <p>People with no recorded punch after their scheduled grace period. Confirm with the person or responsible manager.</p></div>
      <span className="status-pill">Read-only</span>
    </section>
      <div className="oul-notice">Reasons, attendance corrections and HR follow-up stay in People. Approved leave, roster off, recorded punches and closed cases are excluded. A missing punch is not proof of uninformed leave. Refreshes every two minutes while visible and online.</div>
    <section className="panel">
      <div className="oul-toolbar">
        <form onSubmit={refresh}><label>Attendance day<input className="field" type="date" value={date} max={new Date(Date.now()+330*60000).toISOString().slice(0,10)} onChange={e=>setDate(e.target.value)} required/></label><button className="button" disabled={busy}>{busy?"Checking…":"Check attendance"}</button></form>
        <div className="oul-checked" aria-live="polite">Showing {dateLabel(data.date)}<br/>{error?"Refresh failed · previous result shown":`Checked at ${checkedLabel(data.checkedAt)} IST`}</div>
        {!badManager&&<a className="button secondary" href={exportUrl}>Download Excel</a>}
      </div>
      {error&&<p className="oul-error" role="alert">{error}</p>}
      {!data.enabled&&<p className="oul-notice">Unplanned leave detection is disabled in People’s attendance policy.</p>}
      <div className="oul-metrics">
        <div><strong>{rows.length}</strong><span>People to confirm</span></div>
        <div><strong>{distinct(rows.map(r=>r.location_id)).length}</strong><span>Locations in this view</span></div>
        <div><strong>{data.graceMinutes} min</strong><span>Configured reporting grace</span></div>
      </div>
      <div className="oul-filters">
        <label>Reporting manager<select className="field" value={filters.manager} onChange={e=>change({manager:e.target.value,direct:false})}>
          <option value="">{data.scope==="company"?"Entire organisation":data.scope==="location"?"Your location team":"Your reporting team"}</option>
          {badManager&&<option value={filters.manager}>Manager not available</option>}
          {[...data.managers].sort((a,b)=>a.name.localeCompare(b.name)).map(m=><option key={m.id} value={m.id}>{m.name}{m.id===data.viewerPersonId?" · your team":""}</option>)}
        </select></label>
        <label>Location<select className="field" value={filters.location} onChange={e=>change({location:e.target.value})}><option value="">All in scope</option>{distinct(data.rows.map(r=>r.location_id)).map(id=><option key={id} value={id}>{data.rows.find(r=>r.location_id===id)?.station_code}</option>)}</select></label>
        <label>Cluster<select className="field" value={filters.cluster} onChange={e=>change({cluster:e.target.value})}><option value="">All clusters</option>{distinct(data.rows.map(r=>r.cluster)).map(s=><option key={s}>{s}</option>)}</select></label>
        <label>Region<select className="field" value={filters.region} onChange={e=>change({region:e.target.value})}><option value="">All regions</option>{distinct(data.rows.map(r=>r.region)).map(s=><option key={s}>{s}</option>)}</select></label>
        <label>Search<input className="field" placeholder="Name, ID, role or contact" value={filters.search} onChange={e=>change({search:e.target.value})}/></label>
      </div>
      <div className="oul-scope">
        <span>{selectedManager?`${selectedManager.name} · reporting team`:data.scope==="company"?"Company-wide access":data.scope==="location"?"Only your authorised location team":"Only your current reporting hierarchy"}</span>
        {data.scope!=="location"&&<label><input type="checkbox" checked={filters.direct} onChange={e=>change({direct:e.target.checked})}/> Direct reportees only</label>}
        <button className="button secondary" onClick={()=>change({...emptyUnplannedFilters})}>Clear filters</button>
      </div>
      {badManager?<div className="oul-error" role="alert">This manager is not available in your reporting scope for this date. No other team’s list has been substituted. Clear the manager filter to see your own scope.</div>:null}
      {!badManager&&branches.length>0&&<details className="oul-branches" open><summary>Drill into a manager’s team</summary><div>{branches.map(m=><button key={m.id} onClick={()=>change({manager:m.id,direct:false,location:"",cluster:"",region:"",search:""})}><span>{m.name}<small>{m.role}</small></span><b>{m.count} →</b></button>)}</div></details>}
      <div className="table-wrap"><table><thead><tr><th>Person / contact</th><th>Location</th><th>Scheduled shift · IST</th><th>Reports to</th><th>Attendance</th></tr></thead>
        <tbody>{rows.slice(page*25,page*25+25).map(r=><tr key={r.person_id}>
          <td><strong>{r.full_name}</strong><small>{r.worker_code} · {r.role_name}</small>{r.mobile&&<a href={"tel:"+r.mobile.replace(/[^+\d]/g,"")}>{r.mobile}</a>}</td>
          <td><strong>{r.station_code||"Unassigned"}</strong><small>{r.station_name}</small></td>
          <td>{r.shift_code}<small>{r.shift_start.slice(0,5)} – {r.shift_end.slice(0,5)}{r.shift_end<=r.shift_start?" (+1 day)":""}</small></td>
          <td>{r.manager_name||data.managers.find(m=>m.id===r.manager_person_ids[0])?.name||(r.manager_person_ids[0]?"Reporting manager":"Not linked")}</td>
          <td><span className="status-pill warn">No punch · confirm</span><small>In — · Out —</small></td>
        </tr>)}</tbody></table>
        {!rows.length&&!badManager&&<div className="oul-empty">No people to follow up in this view. Change the filters or attendance day if needed.</div>}
      </div>
      <div className="oul-pagination"><span>{rows.length} people · page {Math.min(page+1,pageCount)} of {pageCount}</span><button className="button secondary" disabled={page===0} onClick={()=>setPage(p=>p-1)}>Previous</button><button className="button secondary" disabled={page+1>=pageCount} onClick={()=>setPage(p=>p+1)}>Next</button></div>
    </section>
  </div>;
}
