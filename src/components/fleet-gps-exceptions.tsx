"use client";
import {normalizeGpsPolicy,gpsPolicyLabel} from "@/lib/fleet/gps-policy";
import {dayDuration,dayHours} from "@/lib/fleet/day-tracking";
import { FleetVehicleMeta } from "@/components/fleet-vehicle-meta";

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, MapPin, X } from 'lucide-react';
import type { FleetControlData } from '@/lib/fleet-control';
import { gpsExceptions, gpsExceptionKey, gpsReviewReasons, type GpsExceptionReview } from '@/lib/fleet/gps-exceptions';
import { RouteMap } from '@/components/fleet-dashboard';
import { FleetExportButtons } from '@/components/fleet-export-buttons';

export type ExceptionTarget = {vehicleNo:string;date:string};
type Movement = {points?:{lat:number;lng:number}[];afterHours?:{lat:number;lng:number;speed:number|null;at:string}[];error?:string};
const time = (value?:string|null) => value ? new Date(value).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : 'Unavailable';
const metric = (value?:number|null) => value == null ? '—' : value.toLocaleString('en-IN',{maximumFractionDigits:1});

export function FleetGpsExceptions({data,initialException,onReviewed}:{data:FleetControlData;initialException?:ExceptionTarget|null;onReviewed?:(review:GpsExceptionReview)=>void}) {
 const [from,setFrom]=useState(initialException?.date || data.today.slice(0,7)+'-01');
 const [to,setTo]=useState(data.today);
 const [filter,setFilter]=useState('open');
 const [search,setSearch]=useState('');
 const [selected,setSelected]=useState<ExceptionTarget|null>(initialException||null);
 const [localReviews,setLocalReviews]=useState<GpsExceptionReview[]>([]);
 const [movement,setMovement]=useState<Movement|null>(null);
 const [loading,setLoading]=useState(false);
 const [saving,setSaving]=useState(false);
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('');
 const [reason,setReason]=useState('');
 const [remarks,setRemarks]=useState('');
 const combined={...data,gpsExceptionReviews:[...(data.gpsExceptionReviews||[]),...localReviews]};
 const all=gpsExceptions(combined,'0000-01-01',data.today,'all');
 const current=selected ? all.find(r=>gpsExceptionKey(r.vehicleNo,r.date)===gpsExceptionKey(selected.vehicleNo,selected.date)) : null;
 const vehicles=new Map(data.vehicles.map(v=>[v.vehicleNo,v]));
 const rows=gpsExceptions(combined,from,to,filter).filter(r=>`${r.vehicleNo} ${vehicles.get(r.vehicleNo)?.stationCode||''}`.toLowerCase().includes(search.toLowerCase()));
 useEffect(()=>{if(initialException){setSelected(initialException);setFrom(initialException.date);setTo(data.today);}},[initialException,data.today]);
 useEffect(()=>{
  if(!selected)return;
  const controller=new AbortController();setMovement(null);setLoading(true);setError('');
  fetch(`/api/fleet/gps-exceptions?vehicle=${encodeURIComponent(selected.vehicleNo)}&date=${selected.date}`,{cache:'no-store',signal:controller.signal}).then(async response=>{const payload=await response.json();if(!response.ok)throw new Error(payload.error||'Unable to load GPS route.');setMovement(payload);}).catch(err=>{if(!controller.signal.aborted)setMovement({error:err.message});}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
  const review=all.find(r=>r.vehicleNo===selected.vehicleNo&&r.date===selected.date)?.review;
  setReason(review?.reason||'');setRemarks(review?.remarks||'');
  return()=>controller.abort();
  // Fetch the selected event only, independently of list filters and review updates.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[selected?.vehicleNo,selected?.date]);
 useEffect(()=>{if(!selected)return;const close=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!saving)setSelected(null);};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close);},[selected,saving]);
 async function save(event:React.FormEvent<HTMLFormElement>){
  event.preventDefault();if(!selected)return;setSaving(true);setError('');
  try{const response=await fetch('/api/fleet/gps-exceptions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...selected,reason,remarks})});const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to save acknowledgement.');setLocalReviews(previous=>[...previous,result.review]);onReviewed?.(result.review);setSelected(null);setNotice('Acknowledged. Removed from open alerts and saved in history.');}catch(err){setError(err instanceof Error?err.message:'Unable to save acknowledgement.');}finally{setSaving(false);}
 }
 const report={title:'Fleet GPS exceptions',subtitle:`${from} to ${to} · ${filter} · Saved GPS rules · metrics are full-day totals`,fileName:`fleet-gps-exceptions-${from}-${to}`,headers:['Date','Vehicle','Model','Station','Day km','Day moving hours','Day max speed','Status','Review reason','Remarks','Reviewed by','Reviewed at'],rows:rows.map(r=>[r.date,r.vehicleNo,vehicles.get(r.vehicleNo)?.model,vehicles.get(r.vehicleNo)?.stationCode,r.km,dayHours(r.movingMinutes),r.maxSpeed,r.review?'Acknowledged':'Open',r.review?gpsReviewReasons[r.review.reason]:'',r.review?.remarks,r.review?.reviewedBy,r.review?.reviewedAt])};
 return <section className="fc-gps-exceptions">
  <div className="fc-section-head"><div><span className="fc-eyebrow">GPS control tower</span><h1>Movement exceptions</h1><p>After-hours movement under the rules saved with each day. Review the route and record an explanation.</p></div><FleetExportButtons report={report}/></div>
  {notice?<div className="fc-flash notice" role="status">{notice}</div>:null}
  <div className="fc-exception-controls"><label>From<input type="date" max={to} value={from} onChange={e=>setFrom(e.target.value)}/></label><label>To<input type="date" min={from} max={data.today} value={to} onChange={e=>setTo(e.target.value)}/></label><label>Status<select aria-label="Status" value={filter} onChange={e=>setFilter(e.target.value)}><option value="open">Open</option><option value="acknowledged">Acknowledged</option><option value="all">All history</option></select></label><label>Vehicle / station<input placeholder="Search vehicle or station" value={search} onChange={e=>setSearch(e.target.value)}/></label></div>
  <div className="fc-panel fc-exception-cards">{rows.map(row=><button className="fc-exception-card" type="button" key={gpsExceptionKey(row.vehicleNo,row.date)} onClick={()=>setSelected({vehicleNo:row.vehicleNo,date:row.date})}><span className={row.review?'reviewed':'pending'}>{row.review?<CheckCircle2 size={20}/>:<AlertTriangle size={20}/>}</span><span><strong>{row.vehicleNo}</strong><FleetVehicleMeta vehicleNo={row.vehicleNo}/><small>{row.date} · {row.review?'Acknowledged':'Needs review'}</small><small>Day: {metric(row.km)} km · {dayDuration(row.movingMinutes)} moving · {metric(row.maxSpeed)} km/h max</small></span><b>View details →</b></button>)}{!rows.length?<div className="fc-empty"><CheckCircle2 size={28}/><strong>No {filter==='open'?'open alerts':'matching events'}</strong><p>Acknowledged events remain available in history.</p></div>:null}</div>
  {selected&&current?<div className="fc-modal-backdrop"><section className="fc-modal wide fc-exception-modal" role="dialog" aria-modal="true" aria-labelledby="gps-exception-title"><button className="fc-modal-close" aria-label="Close exception" disabled={saving} onClick={()=>setSelected(null)} type="button"><X size={20}/></button><div className="fc-modal-title"><span className="fc-vehicle-big"><AlertTriangle size={24}/></span><div><small>{current.date} · IST</small><h2 id="gps-exception-title">{current.vehicleNo} · After-hours movement</h2><FleetVehicleMeta vehicleNo={current.vehicleNo}/><p>{current.review?'Acknowledged · saved in history':'Open · explanation required'}</p></div></div>
   <div className="fc-route-summary"><div><small>Full-day distance</small><strong>{metric(current.km)} km</strong></div><div><small>Full-day moving time</small><strong>{dayDuration(current.movingMinutes)}</strong></div><div><small>Full-day max speed</small><strong>{metric(current.maxSpeed)} km/h</strong></div></div><p className="fc-exception-timing">First movement: {time(current.firstMovingAt)} · Last movement: {time(current.lastMovingAt)}</p>
   {loading?<p role="status">Loading recorded route and after-hours locations…</p>:movement?.error?<div className="fc-flash error">{movement.error} Saved daily figures remain available.</div>:<><h3>After-hours locations</h3><p className="fc-exception-timing">Recorded moving GPS fixes in {gpsPolicyLabel(normalizeGpsPolicy(current.gpsPolicy))}; gaps are not proof of continuous movement.</p>{movement?.afterHours?.length?<><div className="fc-exception-map"><RouteMap points={movement.afterHours.map(p=>({lat:p.lat,lng:p.lng}))}/></div><div className="fc-exception-fixes">{movement.afterHours.map((p,index)=><a key={`${p.at}-${index}`} href={`https://www.google.com/maps?q=${p.lat},${p.lng}`} target="_blank" rel="noopener noreferrer"><span>{time(p.at)}</span><b>{metric(p.speed)} km/h</b><span><MapPin size={14}/>{p.lat.toFixed(5)}, {p.lng.toFixed(5)} ↗</span></a>)}</div></>:<p>No detailed after-hours fixes are available from the provider for this saved event.</p>}</>}
   {current.review?<div className="fc-exception-review"><CheckCircle2 size={18}/><div><strong>{gpsReviewReasons[current.review.reason]}</strong><p>{current.review.remarks}</p><small>{current.review.reviewedBy} · {time(current.review.reviewedAt)}</small></div></div>:null}
   {data.capabilities.canReviewGps?<form className="fc-exception-review-form" onSubmit={save}><label>Review outcome<select required value={reason} onChange={e=>setReason(e.target.value)}><option value="">Choose outcome</option>{Object.entries(gpsReviewReasons).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><label>Remarks<textarea required maxLength={2000} rows={3} value={remarks} onChange={e=>setRemarks(e.target.value)} placeholder="Record why the vehicle moved and any follow-up taken."/></label>{error?<p className="fc-flash error" role="alert">{error}</p>:null}<div className="fc-form-actions"><button type="button" disabled={saving} className="fc-button secondary" onClick={()=>setSelected(null)}>Close</button><button type="submit" className="fc-button primary" disabled={saving||!reason||!remarks.trim()}>{saving?'Saving…':current.review?'Update acknowledgement':'Acknowledge & save'}</button></div></form>:<p>Contact a Fleet user with tracking edit access to acknowledge this event.</p>}
  </section></div>:null}
 </section>;
}
