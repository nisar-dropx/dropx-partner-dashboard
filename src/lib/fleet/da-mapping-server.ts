import 'server-only';
import {mappingAdmin as supabaseAdmin} from '@/lib/fleet/da-mapping-client';
import {readAllRows} from '@/lib/supabase-pagination';
import {hasPermission,type AuthorizationContext} from '@/lib/authorization';
import {requireCompanyId} from '@/lib/company-scope';
import {currentAdminAccessSurface} from '@/lib/access-surface';
import {FleetReportError} from './report-data';
import {loadVehicleSources} from './vehicle-sources-server';
import {istDate} from './daily-report';
import {recentRiders,riderKey,isMappingVehicleActive,type MappingData,type VehicleDA,type DefaultDA,type ConfirmedDA} from './da-mapping';
const isFleetSurface=()=>String(currentAdminAccessSurface())==='fleet';
export const mappingCanView=(a:AuthorizationContext)=>a.isMasterOwner||hasPermission(a,'fleet_da_mapping','access')||(isFleetSurface()&&['fleet_vehicle_view','fleet_station_view','fleet_tracking','fleet_masters'].some(p=>hasPermission(a,p,'access')));
export const mappingCanEdit=(a:AuthorizationContext)=>!a.readOnly&&(a.isMasterOwner||hasPermission(a,'fleet_da_mapping','edit')||(isFleetSurface()&&['fleet_vehicle_view','fleet_station_view','fleet_tracking'].some(p=>hasPermission(a,p,'edit'))));
export const mappingCanDefaults=(a:AuthorizationContext)=>isFleetSurface()&&!a.readOnly&&(a.isMasterOwner||hasPermission(a,'fleet_masters','edit'));
export async function mappingScope(auth:AuthorizationContext){
 if(!supabaseAdmin)throw new FleetReportError('Mapping is temporarily unavailable.',503);
 if(!mappingCanView(auth))throw new FleetReportError('Vehicle or station request access is required.',403);
 const companyId=requireCompanyId(auth),surface=String(currentAdminAccessSurface());
 if(!['fleet','ops'].includes(surface))throw new FleetReportError('Open vehicle DA mapping in Fleet or OpsPulse.',403);
 if(!auth.isMasterOwner){const member=await supabaseAdmin.from('company_product_memberships').select('id,role_id').eq('company_id',companyId).eq('user_id',auth.userId).eq('product_code',surface==='fleet'?'fleet':'operations').eq('is_active',true).maybeSingle();if(member.error||!member.data?.role_id)throw new FleetReportError('Product access is required.',403);}
 let q=supabaseAdmin.from('stations').select('station_code,station_name').eq('company_id',companyId).eq('is_active',true).order('station_code');
 if(!auth.isMasterOwner&&!auth.hasAllLocationAccess){if(!auth.locationScopeIds.length)return{companyId,stations:[],vehicles:[]};q=q.in('id',auth.locationScopeIds);}
 const r=await readAllRows(q);if(r.error)throw new FleetReportError('Unable to check station access.');
 const stations=(r.data??[]).map(s=>({code:s.station_code,name:s.station_name||s.station_code}));
 if(!stations.length)return{companyId,stations,vehicles:[]};
 const [vr,sr]=await Promise.all([
 readAllRows(supabaseAdmin.from('fleet_vehicles').select('id,vehicle_no,model,da_name,vendor_name,station_code,ownership_type,status,source_id,deployment_status').eq('company_id',companyId).in('station_code',stations.map(s=>s.code)).order('vehicle_no').order('id')),
 supabaseAdmin.from('fleet_vehicle_status_master').select('status_key,is_operational,is_active').eq('company_id',companyId)
 ]);
 if(vr.error||sr.error)throw new FleetReportError('Unable to check active vehicles. Retry.');
 const vehicles=(vr.data??[]).filter(v=>isMappingVehicleActive(v,sr.data??[]));
 const codes=new Set(vehicles.map(v=>v.station_code));
 return{companyId,stations:stations.filter(s=>codes.has(s.code)),vehicles};
}
export async function loadMapping(auth:AuthorizationContext,date:string,requestedStation:string):Promise<MappingData>{
 const scope=await mappingScope(auth),today=istDate();
 const station=requestedStation||scope.stations[0]?.code||'';
 if(station&&!scope.stations.some(s=>s.code===station))throw new FleetReportError('Station is outside your scope.',403);
 const empty:MappingData={date,today,station,stations:scope.stations,vehicles:[],options:[],assignments:[],confirmations:[],defaults:[],recentDays:7,latestFeed:null,canEdit:mappingCanEdit(auth),canDefaults:mappingCanDefaults(auth),canPolicy:mappingCanDefaults(auth)};
 if(!station)return empty;
 const vehicles=scope.vehicles.filter(v=>v.station_code===station);
 const [defaults,assignments,settings,confirmations]=await Promise.all([
 readAllRows(supabaseAdmin!.from('fleet_vehicle_da_defaults').select('id,vehicle_id,station_code,provider_employee_id,name,updated_at').eq('company_id',scope.companyId).eq('station_code',station).order('id')),
 readAllRows(supabaseAdmin!.from('fleet_day_assignments').select('id,vehicle_id,provider_employee_id,name,remarks,updated_at').eq('company_id',scope.companyId).eq('station_code',station).eq('work_date',date).eq('purpose','delivery').eq('is_active',true).order('id')),
 supabaseAdmin!.from('fleet_control_settings').select('assignment_recent_days').eq('company_id',scope.companyId).maybeSingle(),
 readAllRows(supabaseAdmin!.from('fleet_vehicle_day_confirmations').select('id,vehicle_id,updated_at,remarks').eq('company_id',scope.companyId).eq('station_code',station).eq('work_date',date).order('id'))
 ]);
 if(defaults.error||assignments.error||settings.error||confirmations.error)throw new FleetReportError('Unable to load vehicle mappings. Retry; nothing has been changed.');
 const recentDays=settings.data?.assignment_recent_days??7;
 const from=new Date(Date.parse(`${today}T12:00:00Z`)-(recentDays-1)*86400000).toISOString().slice(0,10);
 const [recent,sources]=await Promise.all([
 readAllRows(supabaseAdmin!.from('cps_shipment_daily').select('id,provider_employee_id,provider_employee_name,work_date').eq('company_id',scope.companyId).eq('client','Amazon').eq('station_code',station).gte('work_date',from).lte('work_date',today).gt('total_activity',0).order('id')),
 loadVehicleSources(scope.companyId).catch(()=>({sources:[],designations:[]}))
 ]);
 const options=recentRiders(recent.error?[]:recent.data??[]);
 // Saved identities remain usable during a late feed or outage. No name-only matching.
 for(const r of [...defaults.data??[],...assignments.data??[]])if(!options.some(o=>o.id===riderKey(r.provider_employee_id)))options.push({id:riderKey(r.provider_employee_id),name:r.name,lastSeen:null});
 const sourceMap=new Map(sources.sources.map(s=>[s.id,s]));
 return{...empty,recentDays,options,confirmations:confirmations.data??[],vehicles:vehicles.map(v=>({...v,sourceCode:sourceMap.get(v.source_id)?.code||v.ownership_type,sourceName:sourceMap.get(v.source_id)?.name||v.ownership_type})) as VehicleDA[],defaults:defaults.data as DefaultDA[],assignments:(assignments.data??[]).map(a=>({...a,delivered:null,cReturn:null,swa:null})) as ConfirmedDA[],latestFeed:null,warning:recent.error?'Recent rider list unavailable. Saved rider IDs remain usable; refresh to load new associates.':undefined};
}
