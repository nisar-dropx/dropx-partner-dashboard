import type {HighValueRow} from './lm-high-value';
export type ShipmentScan={state:string;time:string|null;source?:string|null;destination?:string|null;reasonCode?:string|null};
export type HighValueEvidence={trackingId:string;stationCode:string;state:string;checkedAt:string;updatedAt:string|null;product:string;history:ShipmentScan[]};
const day=(at:number)=>new Date(at+19800000).toISOString().slice(0,10);
const stamp=(v:string|null|undefined)=>v?Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(v)?v:v.replace(' ','T')+'+05:30'):NaN;
export const highValueClosed=(state:string)=>['DELIVERED','CASH_AT_STATION','CASH_IN_ASSOCIATE','RETURNED_TO_FC','RETURN_RECEIVED_AT_FC','RETURNED_TO_SELLER'].includes(state.toUpperCase());
export function highValueException(row:HighValueRow,evidence:HighValueEvidence,now:number,minimumDays=3,threshold=5000){
 if(row.trackingId!==evidence.trackingId||row.stationCode!==evidence.stationCode||!Number.isFinite(row.shipmentValue)||row.shipmentValue!<threshold||highValueClosed(evidence.state))return null;
 const history=[...new Map(evidence.history.filter(h=>Number.isFinite(stamp(h.time))&&stamp(h.time)<=now).map(h=>[h.state+':'+h.time,h])).values()].sort((a,b)=>stamp(a.time)-stamp(b.time));
 // A return must actually have left this station toward FC; READY_FOR_FC_RETURN,
 // rejected, attempted, or a fresh outward delivery scan does not close the case.
 const last=history.at(-1);
 if(last&&['DEPARTED','IN_TRANSIT'].includes(last.state)&&last.source===row.stationCode&&last.destination&&last.destination!==row.stationCode&&/FC|FULFILLMENT_CENTER|RETURN_CENTER/.test(last.destination)&&['DEPARTED','IN_TRANSIT'].includes(evidence.state))return null;
 const local=history.filter(h=>!h.source||h.source===row.stationCode||h.destination===row.stationCode);
 const inducts=local.filter(h=>['INDUCT','INDUCTED','AT_STATION'].includes(h.state)&&!h.reasonCode?.includes('CANNOT_BE_INDUCTED')).map(h=>stamp(h.time));
 const first=Math.min(...inducts,...[row.inductedAt,row.firstSeenAt].map(stamp).filter(n=>Number.isFinite(n)&&n<=now));
 const ageDays=Number.isFinite(first)?Math.max(0,Math.floor((Date.parse(day(now))-Date.parse(day(first)))/86400000)):null;
 const activities=local.filter(h=>(['IN_TRANSIT_TO_CUSTOMER','ON_ROAD_WITH_DELIVERY_ASSOCIATE','DELIVERY_FAILED','DELIVERY_ATTEMPTED','REJECTED','DELIVERY_REJECTED'].includes(h.state)||h.state==='IN_TRANSIT'&&h.destination==='CUSTOMER_ADDRESS')&&(!h.destination||h.destination==='CUSTOMER_ADDRESS'));
 const activityDays=new Set(activities.map(h=>day(stamp(h.time)))).size;
 if((ageDays??0)<minimumDays&&activityDays<minimumDays)return null;
 return {...row,state:evidence.state,product:evidence.product,ageDays,activityDays,firstAt:Number.isFinite(first)?new Date(first).toISOString():null,history:local,checkedAt:evidence.checkedAt};
}
export function highValueScanLabel(state:string){
 const labels:Record<string,string>={INDUCTED:'Inducted',RECEIVED:'Received',IN_TRANSIT:'Dispatched',IN_TRANSIT_TO_CUSTOMER:'Out on road',ON_ROAD_WITH_DELIVERY_ASSOCIATE:'Out on road',DELIVERY_FAILED:'Attempt failed',DELIVERY_ATTEMPTED:'Attempted',REJECTED:'Rejected',DELIVERY_REJECTED:'Rejected',HOLD_FOR_REDELIVERY:'Held · HFR',HOLD_FOR_CUSTOMER_REQUEST:'Held · HCR',READY_FOR_FC_RETURN:'Return pending',HELD:'Held'};
 return labels[state]||state.replaceAll('_',' ').toLowerCase();
}
export function highValueExceptionCaption(station:string,count:number,value:number,escalation:boolean){
 return `*${station} · ${escalation?'Escalation':'High-value check'} · ${count} shipment${count===1?'':'s'} · ₹${value.toLocaleString('en-IN',{maximumFractionDigits:2})}*\n${escalation?'Still unresolved. Verify physical stock and record delivery or confirmed return handover now.':'Verify physical stock and arrange delivery or confirmed return handover today.'} Out-on-road or another attempt does not close this alert.`;
}
