import type {HighValueRow} from './lm-high-value';
export type ShipmentScan={state:string;time:string|null;source?:string|null;destination?:string|null;reasonCode?:string|null};
export type HighValueEvidence={trackingId:string;stationCode:string;state:string;checkedAt:string;updatedAt:string|null;reasonCode?:string|null;product:string;history:ShipmentScan[]};
const day=(at:number)=>new Date(at+19800000).toISOString().slice(0,10);
const stamp=(v:string|null|undefined)=>v?Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(v)?v:v.replace(' ','T')+'+05:30'):NaN;
export const highValueClosed=(state:string)=>['DELIVERED','CASH_AT_STATION','CASH_IN_ASSOCIATE','RETURNED_TO_FC','RETURN_RECEIVED_AT_FC','RETURNED_TO_SELLER'].includes(state.toUpperCase());
const customerDestination=(value:string|null|undefined)=>/^CUSTOMER_ADDRESS(?:_\d+)?$/.test(value||'');
const deliveryActivity=(h:ShipmentScan)=>(['IN_TRANSIT_TO_CUSTOMER','ON_ROAD_WITH_DELIVERY_ASSOCIATE','DELIVERY_FAILED','DELIVERY_ATTEMPTED','UNDELIVERABLE','REJECTED','DELIVERY_REJECTED'].includes(h.state)||['IN_TRANSIT','DEPARTED'].includes(h.state)&&customerDestination(h.destination))&&(!h.destination||customerDestination(h.destination));
const outsideArea=(reason:string|null|undefined)=>/^(OUT_OF_DELIVERY_AREA|OUTSIDE_DELIVERY_AREA|OUT_OF_SERVICE_AREA|OUTSIDE_SERVICE_AREA|OUT_OF_COVERAGE_AREA|UNSERVICEABLE_AREA|WRONG_NODE|WRONG_PLANNED_STATION_FC_RETURN|WRONG_STATION_SAME_CITY_FC_RETURN)$/.test(reason||'');
export function highValueMoney(value:number){return '₹'+value.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});}
export function highValueException(row:HighValueRow,evidence:HighValueEvidence,now:number,minimumDays=3,threshold=5000){
 if(row.trackingId!==evidence.trackingId||row.stationCode!==evidence.stationCode||!Number.isFinite(row.shipmentValue)||row.shipmentValue!<threshold||highValueClosed(evidence.state))return null;
 const history=[...new Map(evidence.history.filter(h=>Number.isFinite(stamp(h.time))&&stamp(h.time)<=now).map(h=>[h.state+':'+h.time,h])).values()].sort((a,b)=>stamp(a.time)-stamp(b.time));
 // A return must actually have left this station toward FC; READY_FOR_FC_RETURN,
 // rejected, attempted, or a fresh outward delivery scan does not close the case.
 const last=history.at(-1);
 if(last&&['DEPARTED','IN_TRANSIT'].includes(last.state)&&last.source===row.stationCode&&last.destination&&last.destination!==row.stationCode&&/FC|FULFILLMENT_CENTER|RETURN_CENTER/.test(last.destination)&&['DEPARTED','IN_TRANSIT'].includes(evidence.state))return null;
 // Restart evidence after a completed delivery or a handover away from this station.
 const boundary=history.filter(h=>highValueClosed(h.state)||(h.source===row.stationCode&&['DEPARTED','IN_TRANSIT'].includes(h.state)&&h.destination&&!customerDestination(h.destination)&&h.destination!==row.stationCode)).at(-1);
 const local=history.filter(h=>(!boundary||stamp(h.time)>stamp(boundary.time))&&(!h.source||h.source===row.stationCode||h.destination===row.stationCode));
 const latestReason=(evidence.reasonCode&&evidence.reasonCode!=='NONE'?evidence.reasonCode:null)||local.filter(h=>h.reasonCode&&h.reasonCode!=='NONE').at(-1)?.reasonCode;
 // A known service-area exception is handled through the normal undeliverable workflow.
 if(outsideArea(latestReason)&&!['IN_TRANSIT','DEPARTED','IN_TRANSIT_TO_CUSTOMER','ON_ROAD_WITH_DELIVERY_ASSOCIATE'].includes(evidence.state))return null;
 const inducts=local.filter(h=>['INDUCT','INDUCTED','AT_STATION'].includes(h.state)&&!h.reasonCode?.includes('CANNOT_BE_INDUCTED')).map(h=>stamp(h.time));
 const first=Math.min(...inducts);
 const ageDays=Number.isFinite(first)?Math.max(0,Math.floor((now-first)/86400000)):null;
 const activities=local.filter(deliveryActivity);
 const activityDays=new Set(activities.map(h=>day(stamp(h.time)))).size;
 const lastActivity=activities.at(-1);
 const idleFrom=lastActivity?stamp(lastActivity.time):first;
 const idleDays=Number.isFinite(idleFrom)?Math.max(0,Math.floor((now-idleFrom)/86400000)):null;
 const onRoad=['IN_TRANSIT','DEPARTED','IN_TRANSIT_TO_CUSTOMER','ON_ROAD_WITH_DELIVERY_ASSOCIATE'].includes(evidence.state);
 const repeated=activityDays>=minimumDays;
 const stalled=!onRoad&&idleDays!==null&&idleDays>=minimumDays;
 if(!repeated&&!stalled)return null;
 const reason=repeated?`Dispatch / attempt on ${activityDays} days; unresolved`:`No dispatch / attempt for ${idleDays} days`;
 return {...row,state:evidence.state,product:evidence.product,ageDays,activityDays,idleDays,reason,kind:repeated?'repeated_scans' as const:'stalled' as const,firstAt:Number.isFinite(first)?new Date(first).toISOString():null,history:local,checkedAt:evidence.checkedAt};
}
export function highValueScanLabel(state:string){
 const labels:Record<string,string>={INDUCTED:'Inducted',RECEIVED:'Received',IN_TRANSIT:'In transit',IN_TRANSIT_TO_CUSTOMER:'Out on road',ON_ROAD_WITH_DELIVERY_ASSOCIATE:'Out on road',DELIVERY_FAILED:'Attempt failed',DELIVERY_ATTEMPTED:'Attempted',REJECTED:'Rejected',DELIVERY_REJECTED:'Rejected',HOLD_FOR_REDELIVERY:'Held · HFR',HOLD_FOR_CUSTOMER_REQUEST:'Held · HCR',READY_FOR_FC_RETURN:'Return pending',HELD:'Held'};
 return labels[state]||state.replaceAll('_',' ').toLowerCase();
}
/** One outcome per activity day keeps repeated attempts visible instead of filling the image with same-day scans. */
export function highValueHistoryRows(history:ShipmentScan[]){
 const outcomes=new Set(['DELIVERY_FAILED','DELIVERY_ATTEMPTED','REJECTED','DELIVERY_REJECTED']);
 const byDay=new Map<string,ShipmentScan>();
 for(const h of history){
  if(!Number.isFinite(stamp(h.time)))continue;
  const active=deliveryActivity(h);
  if(!active)continue;
  const key=day(stamp(h.time)),prior=byDay.get(key);
  if(!prior||(outcomes.has(h.state)&&!outcomes.has(prior.state))||(outcomes.has(h.state)===outcomes.has(prior.state)&&stamp(h.time)>stamp(prior.time)))byDay.set(key,h);
 }
 const latest=history.filter(h=>!['MANIFESTED','CUSTOMER_NOTES_UPDATED'].includes(h.state)).sort((a,b)=>stamp(a.time)-stamp(b.time)).at(-1);
 const rows=[...byDay.values()].sort((a,b)=>stamp(b.time)-stamp(a.time)).slice(0,3);
 if(latest&&!rows.some(h=>h.state===latest.state&&h.time===latest.time))rows.push(latest);
 return rows.sort((a,b)=>stamp(b.time)-stamp(a.time));
}
export function highValueExceptionCaption(station:string,count:number,value:number,escalation:boolean){
 return `*${station} · ${escalation?'High-value escalation':'High-value scan alert'} · ${count} shipment${count===1?'':'s'} · ${highValueMoney(value)}*\n${escalation?'Still unresolved. TL: confirm physical location and the reason for repeated / missing attempts. CLM, CT, Head of Last Mile and SLP: investigate and confirm the next action.':'TL: physically verify these shipments and reply against each TID with its location, reason for repeated / missing attempts, and next action. CLM / CT: verify the explanation.'}`;
}
