/** Shared payout/associate policy. A missing route is not a zero-km day. */
export type RouteDistanceRow = {
  id:string; workforce_id:string;station_id:string;mapping_id:string;work_date:string;
  status:'ready'|'pending';reason:string|null;distance_km:number|string|null;
  departure_km:number|string|null;delivery_km:number|string|null;return_km:number|string|null;calculated_at:string;
};
export type RouteDistanceContext = {enabledFrom:string|null;rows:RouteDistanceRow[];manual:any[];rateOverrides:any[]};
export type DailyRouteFuel = {date:string;stationId:string;mappingId:string;status:'ready'|'pending';reason:string|null;km:number|null;rate:number;amount:number|null;departureKm:number|null;deliveryKm:number|null;returnKm:number|null;updatedAt:string|null;source:'calculated'|'manual';routeId:string|null};
/** Anomalous / unusable days pay no fuel — same as absent for salary (do not block payroll as pending). */
export const distanceNoPayoutReasons = new Set([
  'route_excluded','route_needs_review','scan_excluded','scan_location_missing','scan_date_mismatch',
]);
export const isKilometreField = (code:unknown) => String(code??'').trim().toUpperCase()==='KM_RUN';
export function kilometreRate(mapping:any):number|null {
  const entry=Object.entries(mapping.payment_values??{}).find(([code])=>isKilometreField(code));
  if(!entry || entry[1]===null || entry[1]==='')return null;
  const n=Number(entry[1]);return Number.isFinite(n)&&n>0?n:null;
}
// Distance is synced only after the day closes; today has no stored row yet.
const kolkataToday=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(new Date());
export function routeFuelForDay(context:RouteDistanceContext,input:{workforceId:string;stationId:string;mappingId:string;date:string;rate:number;hasActivity:boolean}):DailyRouteFuel|null {
  if(!context.enabledFrom || input.date<context.enabledFrom)return null;
  const rows=context.rows.filter(r=>r.workforce_id===input.workforceId&&r.station_id===input.stationId&&r.work_date===input.date);
  const manual=context.manual.filter(r=>r.workforce_id===input.workforceId&&r.station_id===input.stationId&&r.work_date===input.date&&isKilometreField(r.field_code_snapshot));
  if(!manual.length&&!input.hasActivity&&!rows.some(r=>r.status==='ready'))return null;
  const overrides=context.rateOverrides.filter(r=>r.workforce_id===input.workforceId&&r.station_id===input.stationId&&isKilometreField(r.field_code_snapshot)&&r.effective_from<=input.date&&r.effective_to>=input.date);
  if(overrides.length>1||manual.length>1||rows.length>1)throw new Error('Conflicting kilometre inputs. Contact Workforce.');
  const rate=overrides.length?Number(overrides[0].input_value):input.rate;
  if(!Number.isFinite(rate)||rate<0)throw new Error('Invalid kilometre rate. Contact Workforce.');
  const row=rows[0], imported=manual[0];
  // Excluded / scan-mismatch days are no-payout (like absent), not open pending fuel.
  if(!imported&&row&&distanceNoPayoutReasons.has(row.reason||''))return null;
  const ready=Boolean(imported || row?.status==='ready'&&row.mapping_id===input.mappingId);
  const value=imported?Number(imported.units):ready?Number(row.distance_km):null;
  if(value!==null&&(!Number.isFinite(value)||value<0))throw new Error('Invalid kilometre units. Contact Workforce.');
  const number=(v:unknown)=>v===null||v===undefined?null:Number(v);
  return {date:input.date,stationId:input.stationId,mappingId:input.mappingId,status:ready?'ready':'pending',reason:ready?null:row?.mapping_id&&row.mapping_id!==input.mappingId?'mapping_changed':row?.reason??(input.date>=kolkataToday()?'day_in_progress':'route_not_received'),km:value,rate,amount:value===null?null:Math.round(value*rate*100)/100,departureKm:imported?null:number(row?.departure_km),deliveryKm:imported?null:number(row?.delivery_km),returnKm:imported?null:number(row?.return_km),updatedAt:row?.calculated_at??null,source:imported?'manual':'calculated',routeId:!imported&&ready?row.id:null};
}
export function routePendingLabel(reason:string|null) {
  const labels:Record<string,string>={
    amazon_identity_missing:'Complete Amazon onboarding: link this associate to an SCC / Flex transporter ID in the workforce portal',
    station_location_missing:'Station location needed',
    service_area_missing:'Amazon service area needed',
    source_unavailable:'Waiting for Amazon route sync',
    road_routing_unavailable:'Road calculation is retrying',
    road_routing_misconfigured:'Road routing credentials need updating',
    gps_trail_unavailable:'Waiting for Amazon GPS trail',
    route_in_progress:'Route is still in progress',
    day_in_progress:'Distance settles after the work day closes',
    route_not_received:'Waiting for delivery route',
    route_needs_review:'Route excluded from distance (anomalous)',
    route_excluded:'Route excluded from distance (anomalous — not pending)',
    mapping_changed:'Refreshing after a mapping change',
    itinerary_incomplete:'Waiting for the complete route',
    scan_location_missing:'Day excluded — too many deliveries without GPS',
    scan_excluded:'Day excluded — packages completed without usable GPS (not pending)',
    scan_date_mismatch:'Delivery scan dates need checking',
    identity_mismatch:'Amazon driver identity needs checking',
    conflicting_scan:'Conflicting delivery scans',
  };
  return labels[reason??'']??'Distance is pending';
}
export function rateCardUnit(field:any,code:string,schedule?:string|null) {
  if(isKilometreField(code))return 'per km';
  const type=String(field?.calculation_type??'');const pay=String(schedule||field?.pay_schedule||'');
  if(type==='fixed_monthly'||/month/i.test(pay))return 'per month';
  if(type==='fixed_daily'||/day/i.test(pay))return 'per day';
  if(/hour/i.test(type+pay))return 'per hour';
  return field?.field_type==='production'||type==='count_x_rate'?'per unit':'fixed amount';
}
