/** Evidence for the first departure and last recorded stop, never intermediate delivery stops. */
export type EndpointFix = {at:string;lat:number;lng:number};
export type JourneyEndpoints = {start:EndpointFix|null;end:EndpointFix|null;observedThrough:string|null;reason?:string};
export type EndpointBase = {code:string;label:string;lat:number;lng:number;radiusM:number};
export type EndpointCheck = {state:'inside'|'outside'|'unverified'|'pending';distanceM:number|null;point:EndpointFix|null;reason:string;base:EndpointBase|null};
export type JourneyLocationCheck = {version:1;checkedAt:string;date:string;start:EndpointCheck;end:EndpointCheck};
export function distanceMetres(a:{lat:number;lng:number},b:{lat:number;lng:number}) {
 const r=Math.PI/180,h=Math.sin((b.lat-a.lat)*r/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin((b.lng-a.lng)*r/2)**2;
 return 12742000*Math.asin(Math.sqrt(Math.min(1,h)));
}
export const validCoordinate=(lat:unknown,lng:unknown)=>typeof lat==='number'&&typeof lng==='number'&&Number.isFinite(lat)&&Number.isFinite(lng)&&Math.abs(lat)<=90&&Math.abs(lng)<=180&&(lat!==0||lng!==0);
export function checkJourneyLocations(date:string,endpoints:JourneyEndpoints|undefined,bases:{start:EndpointBase|null;end:EndpointBase|null},now=new Date()):JourneyLocationCheck {
 const complete=Date.parse(`${date}T23:59:59.999+05:30`)<now.getTime();
 const check=(kind:'start'|'end'):EndpointCheck=>{
  const point=endpoints?.[kind]??null,base=bases[kind];
  const common={point,base,distanceM:null};
  if(kind==='end'&&!complete)return {...common,state:'pending',reason:'Day in progress · final stop not confirmed'};
  if(!point||!validCoordinate(point.lat,point.lng))return {...common,state:'unverified',reason:endpoints?.reason||'Departure / final stop not confirmed by GPS'};
  if(!base||!validCoordinate(base.lat,base.lng)||!(base.radiusM>0))return {...common,state:'unverified',reason:'Assigned location or geofence not configured'};
  const metres=distanceMetres(point,base);
  return {...common,state:metres>base.radiusM?'outside':'inside',distanceM:Math.round(metres),reason:`${Math.round(metres)} m from ${base.label} · ${base.radiusM} m radius`};
 };
 return {version:1,checkedAt:now.toISOString(),date,start:check('start'),end:check('end')};
}
export function endpointAlerts(check:JourneyLocationCheck|null|undefined){return (['start','end'] as const).filter(kind=>check?.[kind]?.state==='outside');}
export const endpointDistance=(metres:number)=>metres>=1000?`${(metres/1000).toFixed(2)} km`:`${metres} m`;
export function endpointLabel(kind:'start'|'end',check?:JourneyLocationCheck|null){
 const c=check?.[kind],label=kind==='start'?'Start':'Last stop';
 if(c?.distanceM!=null)return `${label}: ${endpointDistance(c.distanceM)} from ${c.base?.label||'assigned location'} · ${c.state==='outside'?'outside':'inside'}`;
 return `${label}: ${c?.state==='pending'?'day in progress':'unverified'}`;
}
/** Reverse transfer events after the observation to recover the assignment at that time. */
export function stationAt(current:string,at:string,transfers:Array<{created_at:string;metadata:unknown}>) {
 let station=current;
 for(const transfer of [...transfers].sort((a,b)=>b.created_at.localeCompare(a.created_at))){
  if(Date.parse(transfer.created_at)<=Date.parse(at))continue;
  const m=transfer.metadata as {from_station?:string;to_station?:string}|null;
  if(!m?.from_station||!m?.to_station||m.to_station!==station)return null;
  station=m.from_station;
 }
 return station||null;
}
