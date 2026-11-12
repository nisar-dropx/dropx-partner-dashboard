type PickupRow = {trackingId:string;stationCode:string;edd:string;state:string;driverId?:string};
export const CRETURN_COLUMNS = ['Station','Scheduled','At station','Assigned','On road','Picked up','Pickup failed','Cancelled','Delayed','Unpickupable','Other','Pickup %'];
export type CReturnSummary = {Station:string;Scheduled:number;'At station':number;Assigned:number;'On road':number;'Picked up':number;'Pickup failed':number;Cancelled:number;Delayed:number;Unpickupable:number;Other:number;'Pickup %':string};
const picked = new Set(['PICKUP_DONE','PICKED_UP','DELIVERED','READY_FOR_FC_RETURN','DEPARTED_FOR_FC','COMPLETE','COMPLETED','FC_RECEIVED','RETURNED_TO_FC','DELIVERED_TO_FC']);
const onRoad = new Set(['ON_ROAD_WITH_DELIVERY_ASSOCIATE','ON_ROAD','IN_TRANSIT']);
export function cReturnSummary(station:string,day:string,rows:PickupRow[]):CReturnSummary {
 const out:CReturnSummary={Station:station,Scheduled:0,'At station':0,Assigned:0,'On road':0,'Picked up':0,'Pickup failed':0,Cancelled:0,Delayed:0,Unpickupable:0,Other:0,'Pickup %':'—'};
 const seen=new Set<string>();
 for(const row of rows){
  if(row.stationCode!==station||row.edd!==day||!row.trackingId||seen.has(row.trackingId))continue;
  seen.add(row.trackingId);out.Scheduled++;
  const state=row.state.trim().toUpperCase();
  const owner=!!row.driverId?.trim()&&!['(no DA)','UNKNOWN','UNASSIGNED'].includes(row.driverId.trim());
  if(owner||onRoad.has(state)||picked.has(state)||state==='PICKUP_FAILED')out.Assigned++;
  if(picked.has(state))out['Picked up']++;
  else if(onRoad.has(state))out['On road']++;
  else if(state==='PICKUP_FAILED')out['Pickup failed']++;
  else if(['CANCELLED','CANCELED'].includes(state))out.Cancelled++;
  else if(state==='DELAYED')out.Delayed++;
  else if(state==='UNPICKUPABLE')out.Unpickupable++;
  else if(state==='AT_STATION'&&!owner)out['At station']++;
  else out.Other++;
 }
 out['Pickup %']=out.Scheduled?`${(out['Picked up']/out.Scheduled*100).toFixed(1)}%`:'—';return out;
}
export function cReturnTotal(rows:CReturnSummary[]):CReturnSummary {
 const out=cReturnSummary('Grand total','',[]);
 for(const key of CRETURN_COLUMNS.filter(k=>k!=='Station'&&k!=='Pickup %'))(out as Record<string,string|number>)[key]=rows.reduce((n,r)=>n+Number((r as Record<string,string|number>)[key]||0),0);
 out['Pickup %']=out.Scheduled?`${(out['Picked up']/out.Scheduled*100).toFixed(1)}%`:'—';return out;
}
export function requireReportFreshness(stamp:string|null,day:string,maxMinutes:number,now=Date.now()){
 const at=Date.parse(stamp||'');
 if(!Number.isFinite(at)||new Date(at+330*60000).toISOString().slice(0,10)!==day||now-at>maxMinutes*60000||at>now+60000)throw new Error(`Waiting for current refresh: report data must be within ${maxMinutes} minutes.`);
 return stamp!;
}
export function performanceTitle(report:'dsr'|'creturn'|'dot',day:string,asOf?:string,slot?:string){
 const date=new Date(`${day}T00:00:00+05:30`).toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'Asia/Kolkata'});
 const name=report==='creturn'?'C-return':report==='dot'?'DOT':asOf&&slot==='08:00'?'At-station':'DSR';
 const clock=asOf?new Date(asOf).toLocaleTimeString('en-IN',{hour:'numeric',minute:'2-digit',timeZone:'Asia/Kolkata'}):'';
 return `${name}${asOf?(report==='dsr'&&slot!=='08:00'?' live':' status'):''} · ${date}${clock?' · '+clock+' IST':''}`;
}
