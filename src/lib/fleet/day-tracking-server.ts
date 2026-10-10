import 'server-only';
import {supabaseAdmin} from '@/lib/supabase-admin';
import {readAllRows} from '@/lib/supabase-pagination';
import {hasPermission,type AuthorizationContext} from '@/lib/authorization';
import {buildDailyFleetRows,istDate} from './daily-report';
import {FleetReportError,loadDailyReport,trackingScope} from './report-data';
import {assignmentPackageTotal,matchAssignmentDeliveries,trackingFuel,type DayAssignment,type AssignmentOption,type TrackingDayReport} from './day-tracking';
export const canAssignDay=(auth:AuthorizationContext)=>!auth.readOnly&&(auth.isMasterOwner||hasPermission(auth,'fleet_tracking','edit')||hasPermission(auth,'fleet_vehicle_view','edit'));
export async function loadDayTracking(auth:AuthorizationContext,from:string,to:string):Promise<TrackingDayReport>{
 const scope=await trackingScope(auth);const report=await loadDailyReport(auth,from,to);
 if(!report.vehicles.length)return {...report,rows:[],canAssign:canAssignDay(auth)};
 const plates=report.vehicles.map(v=>v.vehicle_no);
 const [gps,assignments,fuel]=await Promise.all([
  readAllRows(supabaseAdmin!.from('fleet_daily_km').select('journey_location_check,id,vehicle_no,movement_date,moving_minutes,idle_minutes,stopped_minutes,stop_unknown_minutes,unknown_minutes,first_moving_at,last_moving_at,max_speed,point_count').eq('company_id',scope.companyId).in('vehicle_no',plates).eq('source','wheelseye').gte('movement_date',from).lte('movement_date',to).order('id')),
  readAllRows(supabaseAdmin!.from('fleet_day_assignments').select('id,vehicle_no,station_code,work_date,provider_employee_id,workforce_id,name,purpose,source,remarks').eq('company_id',scope.companyId).in('vehicle_no',plates).eq('is_active',true).gte('work_date',from).lte('work_date',to).order('id')),
  readAllRows(supabaseAdmin!.from('fleet_fuel_transactions').select('id,vehicle_no,transaction_date,fuel_quantity,fuel_amount,rate').eq('company_id',scope.companyId).in('vehicle_no',plates).gte('transaction_date',from).lte('transaction_date',to).order('id'))
 ]);
 if(gps.error||assignments.error||fuel.error)throw new FleetReportError('Unable to load complete day tracking. Try again.');
 const present=new Set(report.rows.map(r=>`${r.vehicle_no}|${r.date}`));
 const missing=buildDailyFleetRows(report.vehicles.filter(v=>!['sold','disposed','returned','archived'].includes(v.status??'')).map(v=>({...v,status:'active'})),[],[],from,to).filter(r=>!present.has(`${r.vehicle_no}|${r.date}`));
 report.rows.push(...missing);
 const items=(assignments.data??[]) as DayAssignment[];
 const ids=[...new Set(items.map(a=>a.provider_employee_id).filter((v):v is string=>Boolean(v)))];
 const shipments=ids.length?await readAllRows(supabaseAdmin!.from('cps_shipment_daily').select('id,station_code,work_date,provider_employee_id,total_delivery').eq('company_id',scope.companyId).in('station_code',[...new Set(items.map(a=>a.station_code))]).in('provider_employee_id',ids).gte('work_date',from).lte('work_date',to).order('id')):{data:[],error:null};
 const matched=matchAssignmentDeliveries(items,shipments.error?[]:shipments.data??[]);
 const gpsMap=new Map((gps.data??[]).map(g=>[`${g.vehicle_no}|${g.movement_date}`,g]));
 const assignmentMap=new Map<string,DayAssignment[]>();for(const a of matched){const key=`${a.vehicle_no}|${a.work_date}`;assignmentMap.set(key,[...(assignmentMap.get(key)??[]),a]);}
 const fuelMap=new Map<string,NonNullable<typeof fuel.data>>();for(const f of fuel.data??[]){const key=`${f.vehicle_no}|${f.transaction_date}`;fuelMap.set(key,[...(fuelMap.get(key)??[]),f]);}
 return {from,to,generatedAt:report.generatedAt,canAssign:canAssignDay(auth),assignmentWarning:shipments.error?'Package feed is temporarily unavailable. Assignments remain visible.':undefined,rows:report.rows.map(r=>{
  const key=`${r.vehicle_no}|${r.date}`,g=gpsMap.get(key),a=assignmentMap.get(key)??[],f=trackingFuel(fuelMap.get(key)??[]);
  const usable=g&&(g.point_count??0)>=2;
  return {...r,locationCheck:g?.journey_location_check??null,litres:/^(diesel|petrol)$/i.test(r.fuel_type)?f.litres:null,estimatedLitres:f.estimatedLitres,fuelQuantityMissing:f.missing,movingMinutes:usable?g.moving_minutes:null,idleMinutes:usable?g.idle_minutes:null,stoppedMinutes:usable?g.stopped_minutes:null,stopUnknownMinutes:usable?g.stop_unknown_minutes:null,unknownMinutes:usable?g.unknown_minutes:null,firstMovingAt:usable?g.first_moving_at:null,lastMovingAt:usable?g.last_moving_at:null,maxSpeed:usable?g.max_speed:null,assignments:a,delivered:assignmentPackageTotal(a)};
 })};
}
export async function assignmentOptions(companyId:string,station:string,date:string):Promise<AssignmentOption[]>{
 const location=await supabaseAdmin!.from('stations').select('id').eq('company_id',companyId).eq('station_code',station).maybeSingle();
 if(location.error||!location.data)throw new FleetReportError('Station is unavailable.',400);
 const settings=await supabaseAdmin!.from('fleet_control_settings').select('assignment_recent_days').eq('company_id',companyId).maybeSingle();
 const today=istDate(),windowDays=settings.data?.assignment_recent_days??7;
 const [people,shipments]=await Promise.all([
  readAllRows(supabaseAdmin!.from('workforce').select('id,full_name,provider_employee_id,vehicle_reg_no').eq('company_id',companyId).eq('location_id',location.data.id).eq('is_active',true).is('deleted_at',null).neq('migration_state','reclassified').order('id')),
  readAllRows(supabaseAdmin!.from('cps_shipment_daily').select('id,provider_employee_id,provider_employee_name').eq('company_id',companyId).eq('station_code',station).gte('work_date',new Date(Date.parse(`${today}T12:00:00Z`)-(windowDays-1)*86400000).toISOString().slice(0,10)).lte('work_date',today).order('work_date',{ascending:false}).order('id'))
 ]);
 if(people.error||shipments.error)throw new FleetReportError('Unable to load station associates.');
 const options:AssignmentOption[]=(people.data??[]).map(p=>({key:`workforce:${p.id}`,workforceId:p.id,name:p.full_name,providerId:p.provider_employee_id||null,source:'workforce',registeredVehicle:p.vehicle_reg_no}));
 const seen=new Set(options.map(o=>o.providerId?.trim().toUpperCase()).filter(Boolean));
 for(const s of shipments.data??[]){const id=s.provider_employee_id?.trim();if(id&&!seen.has(id.toUpperCase())){options.push({key:`shipment:${id}`,providerId:id,name:s.provider_employee_name||id,workforceId:null,source:'shipment'});seen.add(id.toUpperCase());}}
 return options.sort((a,b)=>a.name.localeCompare(b.name));
}
