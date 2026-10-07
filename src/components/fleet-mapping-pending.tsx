'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {SearchableSelect} from './searchable-select';
import './fleet-mapping-pending.css';
type PendingData={trackingFrom:string|null;today:string;totalGroups:number;totalPending:number;overdue:number;offset:number;pendingDates?:{date:string;count:number}[];stations:{code:string;name:string}[];rows:{station_code:string;work_date:string;pending_count:number;vehicles?:{id:string;vehicle_no:string;model:string|null;station_code:string;status:string;da_name?:string}[]}[]};
const dateLabel=(date:string)=>new Date(`${date}T12:00:00+05:30`).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Kolkata'});
export function FleetMappingPending({surface='ops'}:{surface?:'fleet'|'ops'}){
 const [data,setData]=useState<PendingData|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[denied,setDenied]=useState(false);
 const [station,setStation]=useState(''),[from,setFrom]=useState(''),[to,setTo]=useState(''),[offset,setOffset]=useState(0);
 const active=useRef<AbortController|null>(null),version=useRef(0);
 const load=useCallback(async()=>{
  active.current?.abort();const controller=new AbortController();active.current=controller;const n=++version.current;
  setBusy(true);const timer=window.setTimeout(()=>controller.abort(),12000);
  try{const r=await fetch(`/api/fleet/da-mapping/pending?${new URLSearchParams({station,from,to,offset:String(offset)})}`,{cache:'no-store',signal:controller.signal});if([401,403].includes(r.status)){if(n===version.current)setDenied(true);return;}const d=await r.json();if(!r.ok)throw Error(d.error||'Unable to check pending mappings.');if(n===version.current){setData(d);setError('');setDenied(false);}}
  catch(e){if(n===version.current)setError(e instanceof Error&&e.name!=='AbortError'?e.message:'Pending mappings could not be checked. Retry.');}
  finally{clearTimeout(timer);if(n===version.current)setBusy(false);}
 },[station,from,to,offset]);
 useEffect(()=>{
  void load();const refresh=()=>{if(!document.hidden)void load();};const timer=window.setInterval(refresh,60000);
  window.addEventListener('focus',refresh);window.addEventListener('fleet-mapping-saved',refresh);
  return()=>{version.current++;active.current?.abort();clearInterval(timer);window.removeEventListener('focus',refresh);window.removeEventListener('fleet-mapping-saved',refresh);};
 },[load]);
 if(denied)return null;
 const pendingDates=data?.pendingDates??[...new Map((data?.rows??[]).map(r=>[r.work_date,{date:r.work_date,count:0}])).values()];
 const href=(s:string,d:string,v?:string)=>`${surface==='fleet'?'/fleet-control?section=assignments&':'/fleet/da-mapping?'}${new URLSearchParams({mappingStation:s,mappingDate:d,...(v?{mappingVehicle:v}:{})})}`;
 return <section className="mapping-pending" aria-label="Pending vehicle DA mappings" aria-busy={busy}>
  <header><div><strong>Vehicle mapping pending</strong><small>{data?`${data.totalPending-data.overdue} today · ${data.overdue} overdue vehicle-days`:'Checking daily confirmations…'}</small></div><button type="button" disabled={busy} onClick={()=>void load()}>{busy?'Checking…':'Refresh'}</button></header>
  {error&&<p className="mapping-pending-error" role="status">{error} <a href={surface==='fleet'?'/fleet-control?section=assignments':'/fleet/da-mapping'}>Open mapping</a></p>}
  {data&&<details><summary>{data.totalPending?`Pending dates: ${pendingDates.slice(0,3).map(d=>dateLabel(d.date)).join(', ')}${pendingDates.length>3?` + ${pendingDates.length-3} more`:''}`:'No pending mappings in this view'} <span>{data.totalPending} pending · View vehicles</span></summary>
   <div className="mapping-pending-date-list" aria-label="Pending dates">{pendingDates.map(d=><button key={d.date} type="button" disabled={busy} onClick={()=>{setFrom(d.date);setTo(d.date);setOffset(0);}}>{dateLabel(d.date)}{d.count?` · ${d.count}`:''}</button>)}</div>
   <div className="mapping-pending-filters"><div><span>Location</span><SearchableSelect name="pending-mapping-station" value={station} options={data.stations.map(s=>({value:s.code,label:`${s.code} · ${s.name}`}))} placeholder="All permitted locations · search" maxOptions={data.stations.length} onValueChange={s=>{setStation(s);setOffset(0);}}/></div><label>From<input type="date" value={from} max={data.today} onChange={e=>{setFrom(e.target.value);setOffset(0);}}/></label><label>To<input type="date" value={to} max={data.today} onChange={e=>{setTo(e.target.value);setOffset(0);}}/></label><button type="button" onClick={()=>{setStation('');setFrom('');setTo('');setOffset(0);}}>Clear</button></div>
   <div className="mapping-pending-list">{data.rows.map(row=><article key={`${row.station_code}-${row.work_date}`}><div><strong>{row.station_code}</strong><small>{dateLabel(row.work_date)}{row.work_date<data.today?' · Overdue':' · Today'}</small></div><span>{row.pending_count} vehicle{row.pending_count===1?'':'s'}</span><a href={href(row.station_code,row.work_date)}>Complete mapping →</a>{row.vehicles?.length?<details className="mapping-pending-vehicles"><summary>View {row.pending_count} pending vehicles</summary>{row.vehicles.map(v=><div key={v.id}><span><strong>{v.vehicle_no.startsWith('PENDING-')?v.da_name||v.model||'Registration not added':v.vehicle_no}</strong><small>{v.model||'Model not recorded'} · {v.station_code}</small></span><a href={href(row.station_code,row.work_date,v.id)}>Update this day →</a></div>)}</details>:null}</article>)}</div>
   {data.totalGroups>20&&<nav aria-label="Pending mapping pages"><button disabled={busy||offset===0} onClick={()=>setOffset(Math.max(0,offset-20))}>Previous</button><span>{Math.min(offset+1,data.totalGroups)}–{Math.min(offset+20,data.totalGroups)} of {data.totalGroups}</span><button disabled={busy||offset+20>=data.totalGroups} onClick={()=>setOffset(offset+20)}>Next</button></nav>}
   <small className="mapping-pending-note">{data.trackingFrom?`Tracked from ${dateLabel(data.trackingFrom)}. `:''}Save each day’s assignment, or confirm no delivery work with a reason. Defaults alone do not clear pending days.</small>
  </details>}
 </section>;
}
