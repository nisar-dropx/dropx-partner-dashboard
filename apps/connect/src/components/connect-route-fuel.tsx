"use client";
import { useRef, useState } from 'react';
import { Route, MapPinned, RefreshCw } from 'lucide-react';
import { type DailyRouteFuel, routePendingLabel } from '../../../../src/lib/workforce-route-distance';
import { ConnectRouteMap, type RouteGeometry } from './connect-route-map';
import styles from './connect-route-fuel.module.css';
import {createRoutePreviewCache} from '@/lib/route-preview-cache';
type RouteCache=ReturnType<typeof createRoutePreviewCache<RouteGeometry>>;
const money=(n:number)=>`₹${n.toLocaleString('en-IN',{maximumFractionDigits:2})}`;
const km=(n:number|null)=>n===null?'Pending':`${n.toLocaleString('en-IN',{maximumFractionDigits:4})} km`;
export function ConnectRouteFuel({fuels,account,cache}:{fuels:DailyRouteFuel[];account:{id:string;profileType:string};cache?:RouteCache}){const localCache=useRef(createRoutePreviewCache<RouteGeometry>());return <>{fuels.map(fuel=><FuelCard key={`${account.profileType}:${account.id}:${fuel.mappingId}:${fuel.date}:${fuel.routeId}:${fuel.updatedAt}`} fuel={fuel} account={account} cache={cache??localCache.current}/>)}</>;}
function FuelCard({fuel,account,cache}:{fuel:DailyRouteFuel;account:{id:string;profileType:string};cache:RouteCache}){
 const [open,setOpen]=useState(false),[geometry,setGeometry]=useState<RouteGeometry|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
 async function load(){
  setOpen(true);if(geometry||loading)return;setLoading(true);setError('');
  try{
   const key=`${account.profileType}:${account.id}:${fuel.routeId}:${fuel.updatedAt}`;
   const saved=await cache.get(key,async()=>{
    const q=new URLSearchParams({accountId:account.id,profileType:account.profileType,routeId:fuel.routeId!});
    const r=await fetch(`/api/connect/route-distance?${q}`,{cache:'no-store',signal:AbortSignal.timeout(12000)}),payload=await r.json();
    if(!r.ok)throw new Error(payload.error||'Unable to load route');
    if(!payload.route_geometry?.path?.length)throw new Error('The saved map is not available. Your distance and fuel amount are unchanged.');
    return payload.route_geometry as RouteGeometry;
   });
   setGeometry(saved);
  }catch(e){setError(e instanceof Error&&e.name!=='TimeoutError'?e.message:'The map is taking longer than usual. Your distance and fuel amount are already shown above.');}
  finally{setLoading(false);}
 }

 return <section className={styles.card}>
  <header><span><Route/><strong>{fuel.source==='manual'?'Recorded distance':'Calculated route km'}</strong></span><b className={fuel.status==='pending'?styles.pending:styles.ready}>{fuel.status==='pending'?'Distance pending':'Ready'}</b></header>
  <div className={styles.fuelTotals}><div><small>Distance</small><strong>{km(fuel.km)}</strong></div><span>×</span><div><small>Mapped fuel rate</small><strong>{money(fuel.rate)}<small> / km</small></strong></div><span>=</span><div><small>Fuel allowance</small><strong>{fuel.amount===null?'Pending':money(fuel.amount)}</strong></div></div>
  {fuel.status==='pending'?<p className={styles.pendingNote}>{routePendingLabel(fuel.reason)}. Your known pay is shown. Fuel will be added when the distance is confirmed.</p>:fuel.source==='calculated'?<><div className={styles.legs}><span><small>Station → first stop</small><b>{km(fuel.departureKm)}</b></span><span><small>Delivery route</small><b>{km(fuel.deliveryKm)}</b></span><span><small>Last stop → station</small><b>{km(fuel.returnKm)}</b></span></div><p className={styles.hint}>Roads between Amazon delivery scans, including station departure and return. This is not a continuous GPS trace.</p></>:<p className={styles.hint}>Workforce uploaded these kilometre units. No calculated route map is attached.</p>}
  {fuel.routeId?<button className={styles.mapButton} aria-expanded={open} type="button" onClick={()=>open?setOpen(false):void load()}><MapPinned/>{open?'Hide route':'View route & numbered stops'}</button>:null}
  {open&&loading?<p role="status">Loading your route…</p>:null}
  {open&&error?<p role="alert">{error} <button onClick={()=>void load()} type="button"><RefreshCw size={16}/> Retry</button></p>:null}
  {open&&geometry?<ConnectRouteMap geometry={geometry}/>:null}
  {fuel.updatedAt?<small className={styles.updated}>Updated {new Date(fuel.updatedAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'short',hour:'numeric',minute:'2-digit'})}</small>:null}
 </section>;
}
