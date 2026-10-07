import type { DailyFleetRow } from './daily-report';
export type DayAssignment = {id:string;vehicle_no:string;station_code:string;work_date:string;provider_employee_id:string|null;workforce_id:string|null;name:string;purpose:'delivery'|'shipment_drop'|'other';source:string;remarks:string;delivered?:number|null};
export type AssignmentOption = {key:string;providerId:string|null;workforceId:string|null;name:string;source:'workforce'|'shipment';registeredVehicle?:string|null};
export type TrackingDay = DailyFleetRow & {locationCheck?:import("./journey-endpoints").JourneyLocationCheck|null;movingMinutes:number|null;idleMinutes:number|null;stoppedMinutes:number|null;stopUnknownMinutes:number|null;unknownMinutes:number|null;firstMovingAt:string|null;lastMovingAt:string|null;maxSpeed:number|null;assignments:DayAssignment[];delivered:number|null;estimatedLitres:number;fuelQuantityMissing:boolean};
export type TrackingDayReport = {from:string;to:string;generatedAt:string;rows:TrackingDay[];canAssign:boolean;assignmentWarning?:string};
export type ShipmentDaily = {station_code:string;work_date:string;provider_employee_id:string;total_delivery:number|string|null};
export function matchAssignmentDeliveries(assignments:DayAssignment[], shipments:ShipmentDaily[]):DayAssignment[] {
 const totals=new Map<string,number>();
 for(const s of shipments){if(s.total_delivery==null)continue;const key=[s.station_code,s.work_date,s.provider_employee_id.trim().toUpperCase()].join('|');totals.set(key,(totals.get(key)??0)+Number(s.total_delivery));}
 return assignments.map(a=>({...a,delivered:a.purpose==='delivery'&&a.provider_employee_id?totals.get([a.station_code,a.work_date,a.provider_employee_id.trim().toUpperCase()].join('|'))??null:null}));
}
export function assignmentPackageTotal(assignments:DayAssignment[]) {
 const delivery=assignments.filter(a=>a.purpose==='delivery');
 return !delivery.length||delivery.some(a=>a.delivered==null)?null:delivery.reduce((sum,a)=>sum+a.delivered!,0);
}
export function trackingFuel(rows:Array<{fuel_quantity:number|string|null;fuel_amount:number|string|null;rate:number|string|null}>) {
 let litres=0,estimatedLitres=0,missing=false;
 for(const r of rows){const quantity=Number(r.fuel_quantity),amount=Number(r.fuel_amount),rate=Number(r.rate);
  if(quantity>0)litres+=quantity;else if(amount>0&&rate>0){litres+=amount/rate;estimatedLitres+=amount/rate;}else if(amount>0)missing=true;
 }
 return {litres:rows.length&&!missing?Math.round(litres*100)/100:null,estimatedLitres:Math.round(estimatedLitres*100)/100,missing};
}
export const dayTime=(value:string|null)=>value?new Date(value).toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit'}):'—';
// Keep stored GPS precision in minutes; convert only for display and exports.
export const dayHours=(minutes:number|null)=>minutes==null?null:Number((minutes/60).toFixed(2));
export const dayDuration=(minutes:number|null)=>minutes==null?'—':`${(minutes/60).toFixed(2)} hr`;
