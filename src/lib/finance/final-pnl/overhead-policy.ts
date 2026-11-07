import type {Dimension,DeliveryVolume,OverheadRule,Sources} from './model';
type Row=Record<string,any>;
const stateRegions:Record<string,string>={'Andhra Pradesh':'AP',Kerala:'KL',Odisha:'ODCG',Chhattisgarh:'ODCG','Tamil Nadu':'TN',Telangana:'TS','Uttar Pradesh':'UP'};
export function pnlRegion(state:string,fallback:string){return stateRegions[state]??fallback;}
/** The approved policy is separate from legacy provisional-P&L master rules. */
export function defaultOverheadRules(month:string,dimensions:Dimension[],topology:Sources['stations']):OverheadRule[]{
 const active=dimensions.filter(d=>!d.isHo&&topology.some(s=>s.code===d.code&&s.active!==false&&!s.hidden));
 const regional:Record<string,string>={HO_KL:'Kerala',HO_AP:'Andhra Pradesh',HO_OD:'Odisha',HO_CG:'Chhattisgarh',HO_TN:'Tamil Nadu',HO_TS:'Telangana',HO_UP:'Uttar Pradesh'};
 return topology.filter(s=>s.isHo&&s.active!==false&&!s.hidden).map(s=>({station_code:s.code,mode:['HO_CLT','HO_MJR'].includes(s.code)?'corporate':'regional',allocation:['HO_CLT','HO_MJR','HO_TN','HO_TS','HO_UP'].includes(s.code)?'revenue':regional[s.code]?'volume':'unallocated',recipient_codes:active.filter(d=>d.state===regional[s.code]).map(d=>d.code).sort(),recipient_models:[...new Set(active.map(d=>d.model))].sort(),effective_from:`${month}-01`}));
}
export function deliveryVolumes(month:string,daily:Row[],now:Row[],topology:Sources['stations'],dimensions:Dimension[],billingPeriodRecords:Row[]=[]):DeliveryVolume[]{
 const active=topology.filter(s=>s.active!==false&&!s.hidden&&!s.isHo&&topology.some(b=>b.code===s.base&&b.active!==false&&!b.hidden&&!b.isHo));
 // Reporting dates are explicit master data. A later-added XPT must not require
 // its own shipment feed before that date; its earlier shipments remain in the
 // parent's actual rows. Never infer reporting dates from creation or first import.
 const reportingFrom=new Map(billingPeriodRecords.filter(r=>r.kind==='billing_period').flatMap(r=>{
  const d=r.data,from=d?.reporting_from;
  return typeof d?.station_code==='string'&&typeof from==='string'&&/^20\d\d-\d\d-\d\d$/.test(from)&&Number.isFinite(Date.parse(from))&&new Date(from).toISOString().slice(0,10)===from?[[d.station_code,from] as const]:[];
 }));
 const parentReported=new Set(billingPeriodRecords.filter(r=>r.kind==='shipment_reporting'&&r.data?.mode==='parent').flatMap(r=>{
  const child=active.find(s=>s.code===r.data.station_code),parent=active.find(s=>s.code===r.data.parent_station_code);
  return child&&parent&&child.code!==parent.code&&child.base===parent.base?[child.code]:[];
 }));
 return [...new Set(active.map(s=>s.base))].sort().map(station=>{
  const validVolume=(value:unknown)=>value!==null&&value!==undefined&&String(value).trim()!==''&&Number.isFinite(Number(value))&&Number(value)>=0;
  // Parent-reported child counts are already in the parent's feed. Do not add
  // a second count even if child rows arrive; switch its master to separate first.
  const members=active.filter(s=>s.base===station&&!parentReported.has(s.code)),reported=daily.filter(d=>String(d.work_date).slice(0,7)===month&&members.some(s=>s.code===d.station_code)&&d.shipment_present),rows=reported.filter(d=>validVolume(d.deliveries)),dates=[...new Set(rows.map(d=>String(d.work_date)))].sort();
  const missingSources=members.filter(s=>{
   const from=reportingFrom.get(s.code);
   const expected=!from||from.slice(0,7)<=month;
   return (expected&&!rows.some(r=>r.station_code===s.code&&(!from||String(r.work_date)>=from)))||reported.some(r=>r.station_code===s.code&&!validVolume(r.deliveries));
  }).map(s=>s.code);
  // Amazon Now's separately maintained units are comparable within a regional Now pool.
  // Never substitute a minimum guarantee for actual handled volume.
  const v=dimensions.find(d=>d.code===station)?.model==='NOW'?now.find(v=>v.station_code===station&&String(v.month).slice(0,7)===month):undefined;
  if(!rows.length&&v&&validVolume(v.units))return {station,delivered:Number(v.units),reportedDays:Number(String(v.through_date).slice(8,10)),through:v.through_date,missingSources:[],unit:'units' as const};
  return {station,delivered:rows.length?rows.reduce((n,d)=>n+Number(d.deliveries),0):null,reportedDays:dates.length,through:dates.at(-1)??null,missingSources,unit:'deliveries' as const};
 });
}
