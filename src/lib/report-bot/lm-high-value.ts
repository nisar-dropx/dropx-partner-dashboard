export type HighValueRow = {stationCode:string;trackingId:string;state:string;shipmentValue?:number;paymentMethod?:string;driverId:string;driverName:string;inductedAt?:string;firstSeenAt?:string;edd:string};
export type HighValueStatus='At station'|'Held at station'|'Out on road'|'Attempted'|'Check status'|'Delivered'|'Rejected';
export function highValueStatus(state:string):HighValueStatus {
 const s=state.toUpperCase();
 if(['DELIVERED','CASH_AT_STATION','CASH_IN_ASSOCIATE'].includes(s))return 'Delivered';
 if(['DELIVERY_REJECTED','REJECTED'].includes(s))return 'Rejected';
 if(['DELIVERY_ATTEMPTED','DELIVERY_FAILED','UNDELIVERABLE'].includes(s))return 'Attempted';
 if(['IN_TRANSIT_TO_CUSTOMER','ON_ROAD_WITH_DELIVERY_ASSOCIATE'].includes(s))return 'Out on road';
 if(/HOLD|HELD|HFR|HCR|SIDELINED|RESCHEDULED|PROBLEM|WRONG|READY_FOR_FC_RETURN/.test(s))return 'Held at station';
 if(['INDUCT','INDUCTED','AT_STATION','RECEIVED','ARRIVED','STAGED','FDD','MARKED_FOR_REPROCESS','DELAYED_AT_STATION','CUSTOMER_NOTES_UPDATED','PENDING_CUSTOMER_FEEDBACK'].includes(s))return 'At station';
 return 'Check status';
}
export function pendingHighValue(rows:HighValueRow[],threshold=5000){
 const unique=new Map<string,HighValueRow>();
 for(const r of rows)if(Number.isFinite(r.shipmentValue)&&r.shipmentValue!>threshold&&!['Delivered','Rejected'].includes(highValueStatus(r.state)))unique.set(`${r.stationCode}:${r.trackingId}`,r);
 const rank={'Held at station':0,'At station':1,'Attempted':2,'Check status':3,'Out on road':4,'Delivered':5,'Rejected':6};
 return [...unique.values()].sort((a,b)=>rank[highValueStatus(a.state)]-rank[highValueStatus(b.state)]||b.shipmentValue!-a.shipmentValue!);
}
export function highValueSummary(rows:HighValueRow[]){
 return [...new Set(rows.map(r=>r.stationCode))].sort().map(station=>{
  const list=rows.filter(r=>r.stationCode===station),count=(status:HighValueStatus)=>list.filter(r=>highValueStatus(r.state)===status).length;
  return [station,count('At station'),count('Held at station'),count('Out on road'),count('Attempted'),count('Check status'),list.length,Math.round(list.reduce((n,r)=>n+r.shipmentValue!,0))];
 });
}
export function highValueCaption(slot:string){
 if(slot<'09:00')return 'Dispatch every listed high-value shipment today, regardless of EDD. Include held stock; resolve holds with the customer/client before dispatch. Flag any delivery restriction.';
 if(slot<'18:00')return 'Move station-held shipments out on road today. Track the assigned DA through delivery. For attempted shipments, contact the customer and arrange a same-day reattempt where possible. Confirm any delivery restriction.';
 return 'Close today’s pending high-value deliveries. Contact customers for a same-day reattempt where possible. Record a specific reason and owner for anything still held or undelivered.';
}

export function highValuePayment(value:string|undefined){
 const code=String(value||'').toUpperCase();return ['CASH','COD','PAY_ON_DELIVERY'].includes(code)?'COD':['PREPAY','PREPAID'].includes(code)?'Prepaid':value||'—';
}
export function highValueStatusLabel(state:string){
 const status=highValueStatus(state);if(status!=='Held at station')return status;
 if(state==='HOLD_FOR_REDELIVERY')return 'Held · HFR';
 if(state==='HOLD_FOR_CUSTOMER_REQUEST')return 'Held · HCR';
 return status;
}
