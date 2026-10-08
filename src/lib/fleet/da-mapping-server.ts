import 'server-only';
import {mappingAdmin as supabaseAdmin} from '@/lib/fleet/da-mapping-client';
import {readAllRows} from '@/lib/supabase-pagination';
import {hasPermission,type AuthorizationContext} from '@/lib/authorization';
import {requireCompanyId} from '@/lib/company-scope';
import {currentAdminAccessSurface} from '@/lib/access-surface';
import {FleetReportError} from './report-data';
import {loadVehicleSources} from './vehicle-sources-server';
import {loadPeopleOperationalHierarchy} from '@/lib/people-operational-hierarchy';
import {istDate} from './daily-report';
import {recentRiders,riderKey,isMappingVehicleActive,type MappingData,type VehicleDA,type DefaultDA,type ConfirmedDA} from './da-mapping';
const isFleetSurface=()=>String(currentAdminAccessSurface())==='fleet';
export const mappingCanView=(a:AuthorizationContext)=>a.isMasterOwner||hasPermission(a,'fleet_da_mapping','access')||(isFleetSurface()&&['fleet_vehicle_view','fleet_station_view','fleet_tracking','fleet_masters'].some(p=>hasPermission(a,p,'access')));
export const mappingCanEdit=(a:AuthorizationContext)=>!a.readOnly&&(a.isMasterOwner||hasPermission(a,'fleet_da_mapping','edit')||(isFleetSurface()&&['fleet_vehicle_view','fleet_station_view','fleet_tracking'].some(p=>hasPermission(a,p,'edit'))));
export const mappingCanDefaults=(a:AuthorizationContext)=>isFleetSurface()&&!a.readOnly&&(a.isMasterOwner||hasPermission(a,'fleet_masters','edit'));
export async function mappingStationScope(auth:AuthorizationContext){
 if(!supabaseAdmin)throw new FleetReportError('Mapping is temporarily unavailable.',503);
 if(!mappingCanView(auth))throw new FleetReportError('Vehicle or station request access is required.',403);
 const companyId=requireCompanyId(auth),surface=String(currentAdminAccessSurface());
 if(!['fleet','ops'].includes(surface))throw new FleetReportError('Open vehicle DA mapping in Fleet or OpsPulse.',403);
 if(!auth.isMasterOwner){const member=await supabaseAdmin.from('company_product_memberships').select('id,role_id').eq('company_id',companyId).eq('user_id',auth.userId).eq('product_code',surface==='fleet'?'fleet':'operations').eq('is_active',true).maybeSingle();if(member.error||!member.data?.role_id)throw new FleetReportError('Product access is required.',403);}
 let q=supabaseAdmin.from('stations').select('id,station_code,station_name,region').eq('company_id',companyId).eq('is_active',true).order('station_code');
 if(!auth.isMasterOwner&&!auth.hasAllLocationAccess){if(!auth.locationScopeIds.length)return{companyId,stations:[],vehicles:[]};q=q.in('id',auth.locationScopeIds);}
 const r=await readAllRows(q);if(r.error)throw new FleetReportError('Unable to check station access.');
 const stations=(r.data??[]).map(s=>({id:s.id,code:s.station_code,name:s.station_name||s.station_code,region:s.region?.trim()||''}));
 return{companyId,stations};
}
export async function mappingScope(auth:AuthorizationContext,date?:string){
 const {companyId,stations}=await mappingStationScope(auth);
 if(!stations.length)return{companyId,stations,vehicles:[]};
 const [vr,sr]=await Promise.all([
 readAllRows(supabaseAdmin!.from('fleet_vehicles').select('id,vehicle_no,model,da_name,vendor_name,station_code,ownership_type,status,source_id,deployment_status').eq('company_id',companyId).in('station_code',stations.map(s=>s.code)).order('vehicle_no').order('id')),
 supabaseAdmin!.from('fleet_vehicle_status_master').select('status_key,label,is_operational,is_active').eq('company_id',companyId)
 ]);
 if(vr.error||sr.error)throw new FleetReportError('Unable to check active vehicles. Retry.');
 let vehicles=(vr.data??[]).filter(v=>isMappingVehicleActive(v,sr.data??[]));
 const unavailable=(v:typeof vehicles[number])=>(v.deployment_status==null||v.deployment_status==='deployed')&&!isMappingVehicleActive(v,sr.data??[])&&!['sold','disposed','returned'].includes(v.status);
 let unavailableVehicles=(vr.data??[]).filter(unavailable),placementRecorded=true;
 if(date&&date<istDate()){
  const history=await readAllRows(supabaseAdmin!.from('fleet_da_mapping_periods').select('snapshot,eligible').eq('company_id',companyId).in('station_code',stations.map(s=>s.code)).lte('effective_from',date).or(`effective_to.is.null,effective_to.gt.${date}`).order('vehicle_id'));
  const first=await supabaseAdmin!.from('fleet_da_mapping_periods').select('effective_from').eq('company_id',companyId).order('effective_from').limit(1).maybeSingle();
  if(history.error||first.error)throw new FleetReportError('Unable to load recorded mapping dates. Retry.');
  placementRecorded=Boolean(first.data&&date>=first.data.effective_from);
  if(!placementRecorded)unavailableVehicles=[];
  if(placementRecorded){vehicles=(history.data??[]).filter(p=>p.eligible).map(p=>p.snapshot as typeof vehicles[number]);unavailableVehicles=(history.data??[]).filter(p=>!p.eligible).map(p=>p.snapshot as typeof vehicles[number]).filter(unavailable);}
 }
 const codes=new Set([...vehicles,...unavailableVehicles].map(v=>v.station_code));
 return{companyId,stations:stations.filter(s=>codes.has(s.code)),vehicles,unavailableVehicles,placementRecorded,dayStatuses:(sr.data??[]).filter(s=>s.is_active&&!s.is_operational&&!['sold','disposed','returned'].includes(s.status_key)).map(s=>({key:s.status_key,label:s.status_key==='on_leave'?'Absent / On leave':s.label}))};
}
export async function loadMapping(auth:AuthorizationContext,date:string,requestedStation:string,registry=false,includeHierarchy=true):Promise<MappingData>{
 const scope=await mappingScope(auth,date),today=istDate();
 const station=requestedStation||'*';
 if(station!=='*'&&!scope.stations.some(s=>s.code===station))throw new FleetReportError('Station is outside your scope.',403);
 const empty:MappingData={date,today,station,stations:scope.stations,vehicles:[],options:[],assignments:[],confirmations:[],defaults:[],recentDays:7,latestFeed:null,canEdit:mappingCanEdit(auth),canDefaults:mappingCanDefaults(auth),canPolicy:mappingCanDefaults(auth)};
 const stationCodes=scope.stations.filter(s=>station==='*'||s.code===station).map(s=>s.code);
 if(!stationCodes.length)return empty;
 const vehicles=[...scope.vehicles,...(registry?(scope.unavailableVehicles??[]):[])].filter(v=>stationCodes.includes(v.station_code));
 const unavailableVehicles=(scope.unavailableVehicles??[]).filter(v=>stationCodes.includes(v.station_code));
 const [defaults,assignments,settings,confirmations]=await Promise.all([
 readAllRows(supabaseAdmin!.from('fleet_vehicle_da_defaults').select('id,vehicle_id,station_code,provider_employee_id,name,updated_at').eq('company_id',scope.companyId).in('station_code',stationCodes).order('id')),
 readAllRows(supabaseAdmin!.from('fleet_day_assignments').select('id,vehicle_id,station_code,provider_employee_id,name,remarks,updated_at').eq('company_id',scope.companyId).in('station_code',stationCodes).eq('work_date',date).eq('purpose','delivery').eq('is_active',true).order('id')),
 supabaseAdmin!.from('fleet_control_settings').select('assignment_recent_days,assignment_alert_from').eq('company_id',scope.companyId).maybeSingle(),
 readAllRows(supabaseAdmin!.from('fleet_vehicle_day_confirmations').select('id,vehicle_id,updated_at,remarks,day_status,day_status_label').eq('company_id',scope.companyId).in('station_code',stationCodes).eq('work_date',date).order('id'))
 ]);
 if(defaults.error||assignments.error||settings.error||confirmations.error)throw new FleetReportError('Unable to load vehicle mappings. Retry; nothing has been changed.');
 const recentDays=settings.data?.assignment_recent_days??7;
 const from=new Date(Date.parse(`${date}T12:00:00Z`)-(recentDays-1)*86400000).toISOString().slice(0,10);
 const [recent,sources,hierarchy]=await Promise.all([
 readAllRows(supabaseAdmin!.from('cps_shipment_daily').select('id,provider_employee_id,provider_employee_name,station_code,work_date').eq('company_id',scope.companyId).eq('client','Amazon').in('station_code',stationCodes).gte('work_date',from).lte('work_date',date).gt('total_activity',0).order('id')),
 loadVehicleSources(scope.companyId).catch(()=>({sources:[],designations:[]})),
 includeHierarchy?mappingPeopleClusters(scope.companyId,scope.stations.map(s=>s.id)):Promise.resolve(null)
 ]);
 const options=recentRiders(recent.error?[]:recent.data??[]);
 // Saved identities remain usable during a late feed or outage. No name-only matching.
 for(const r of [...defaults.data??[],...assignments.data??[]]){let o=options.find(o=>o.id===riderKey(r.provider_employee_id));if(!o){o={id:riderKey(r.provider_employee_id),name:r.name,lastSeen:null,stationCodes:[]};options.push(o);}if(!o.stationCodes?.includes(r.station_code))(o.stationCodes??=[]).push(r.station_code);}
 const sourceMap=new Map(sources.sources.map(s=>[s.id,s]));
 const decorate=(v:typeof vehicles[number])=>({...v,sourceCode:(v as unknown as VehicleDA).sourceCode||sourceMap.get(v.source_id)?.code||v.ownership_type,sourceName:(v as unknown as VehicleDA).sourceName||sourceMap.get(v.source_id)?.name||v.ownership_type}) as VehicleDA;
 return{...empty,stations:scope.stations.map(s=>({...s,clusters:hierarchy?.error||!hierarchy?null:(hierarchy.byLocation.get(s.id)?.clusterManagers??[]).map(p=>({id:p.personId,name:p.name}))})),clusterWarning:hierarchy?.error?'People cluster mapping is temporarily unavailable. Refresh to retry; assignments can still be saved.':undefined,placementRecorded:scope.placementRecorded??false,unavailableVehicles:unavailableVehicles.map(decorate).filter(v=>!['VNV','VAN_VENDOR','VENDOR'].includes(v.sourceCode.toUpperCase())),dayStatuses:scope.dayStatuses??[],alertFrom:settings.data?.assignment_alert_from,recentDays,options,confirmations:confirmations.data??[],vehicles:vehicles.map(v=>({...v,sourceCode:(v as unknown as VehicleDA).sourceCode||sourceMap.get(v.source_id)?.code||v.ownership_type,sourceName:(v as unknown as VehicleDA).sourceName||sourceMap.get(v.source_id)?.name||v.ownership_type})) as VehicleDA[],defaults:defaults.data as DefaultDA[],assignments:(assignments.data??[]).map(a=>({...a,delivered:null,cReturn:null,swa:null})) as ConfirmedDA[],latestFeed:null,warning:recent.error?'Recent rider list unavailable. Saved rider IDs remain usable; refresh to load new associates.':undefined};
}

// Optional display metadata must never become a dependency of a mapping write.
async function mappingPeopleClusters(companyId:string,stationIds:string[]):Promise<Awaited<ReturnType<typeof loadPeopleOperationalHierarchy>>>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([
  loadPeopleOperationalHierarchy(companyId,stationIds),
  new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('People hierarchy timed out')),8000);})
 ]);}catch{return{byLocation:new Map(),error:'People hierarchy unavailable'};}finally{if(timer)clearTimeout(timer);}
}
