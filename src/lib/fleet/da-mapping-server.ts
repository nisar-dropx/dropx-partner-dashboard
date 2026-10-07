import 'server-only';
import {mappingAdmin as supabaseAdmin} from '@/lib/fleet/da-mapping-client';
import {readAllRows} from '@/lib/supabase-pagination';
import {hasPermission,type AuthorizationContext} from '@/lib/authorization';
import {requireCompanyId} from '@/lib/company-scope';
import {currentAdminAccessSurface} from '@/lib/access-surface';
import {FleetReportError} from './report-data';
import {loadVehicleSources} from './vehicle-sources-server';
import {istDate} from './daily-report';
import {recentRiders,assignmentCounts,riderKey,type MappingData,type VehicleDA,type DefaultDA,type ConfirmedDA} from './da-mapping';
export const mappingCanView=(a:AuthorizationContext)=>a.isMasterOwner||['fleet_vehicle_view','fleet_station_view','fleet_tracking','expense_requests'].some(p=>hasPermission(a,p,'access'));
export const mappingCanEdit=(a:AuthorizationContext)=>!a.readOnly&&(a.isMasterOwner||['fleet_vehicle_view','fleet_station_view','fleet_tracking'].some(p=>hasPermission(a,p,'edit'))||hasPermission(a,'expense_requests','add'));
export const mappingCanDefaults=(a:AuthorizationContext)=>!a.readOnly&&(a.isMasterOwner||hasPermission(a,'fleet_masters','edit')||hasPermission(a,'fleet_vehicle_view','edit'));
export async function mappingScope(auth:AuthorizationContext){
 if(!supabaseAdmin)throw new FleetReportError('Mapping is temporarily unavailable.',503);
 if(!mappingCanView(auth))throw new FleetReportError('Vehicle or station request access is required.',403);
 const companyId=requireCompanyId(auth),surface=currentAdminAccessSurface();
 if(!['fleet','ops'].includes(surface))throw new FleetReportError('Open vehicle DA mapping in Fleet or OpsPulse.',403);
 if(!auth.isMasterOwner){const member=await supabaseAdmin.from('company_product_memberships').select('id,role_id').eq('company_id',companyId).eq('user_id',auth.userId).eq('product_code',surface==='fleet'?'fleet':'operations').eq('is_active',true).maybeSingle();if(member.error||!member.data?.role_id)throw new FleetReportError('Product access is required.',403);}
 let q=supabaseAdmin.from('stations').select('station_code,station_name').eq('company_id',companyId).eq('is_active',true).order('station_code');
 if(!auth.isMasterOwner&&!auth.hasAllLocationAccess){if(!auth.locationScopeIds.length)return{companyId,stations:[]};q=q.in('id',auth.locationScopeIds);}
 const r=await readAllRows(q);if(r.error)throw new FleetReportError('Unable to check station access.');
 return{companyId,stations:(r.data??[]).map(s=>({code:s.station_code,name:s.station_name||s.station_code}))};
}
export async function loadMapping(auth:AuthorizationContext,date:string,requestedStation:string):Promise<MappingData>{
 const scope=await mappingScope(auth),today=istDate();
 const station=requestedStation||scope.stations[0]?.code||'';
 if(station&&!scope.stations.some(s=>s.code===station))throw new FleetReportError('Station is outside your scope.',403);
 const empty:MappingData={date,today,station,stations:scope.stations,vehicles:[],options:[],assignments:[],confirmations:[],defaults:[],recentDays:7,latestFeed:null,canEdit:mappingCanEdit(auth),canDefaults:mappingCanDefaults(auth),canPolicy:!auth.readOnly&&(auth.isMasterOwner||hasPermission(auth,'fleet_masters','edit')||hasPermission(auth,'fleet_settings','edit'))};
 if(!station)return empty;
 const [vehicles,defaults,assignments,settings,confirmations]=await Promise.all([
 readAllRows(supabaseAdmin!.from('fleet_vehicles').select('id,vehicle_no,model,da_name,vendor_name,station_code,ownership_type,status,source_id').eq('company_id',scope.companyId).eq('station_code',station).not('status','in','(sold,disposed,returned)').order('vehicle_no').order('id')),
 readAllRows(supabaseAdmin!.from('fleet_vehicle_da_defaults').select('id,vehicle_id,station_code,provider_employee_id,name,updated_at').eq('company_id',scope.companyId).eq('station_code',station).order('id')),
 readAllRows(supabaseAdmin!.from('fleet_day_assignments').select('id,vehicle_id,provider_employee_id,name,remarks,updated_at').eq('company_id',scope.companyId).eq('station_code',station).eq('work_date',date).eq('purpose','delivery').eq('is_active',true).order('id')),
 supabaseAdmin!.from('fleet_control_settings').select('assignment_recent_days').eq('company_id',scope.companyId).maybeSingle(),
 readAllRows(supabaseAdmin!.from('fleet_vehicle_day_confirmations').select('id,vehicle_id,updated_at,remarks').eq('company_id',scope.companyId).eq('station_code',station).eq('work_date',date).order('id'))
 ]);
 if(vehicles.error||defaults.error||assignments.error||settings.error||confirmations.error)throw new FleetReportError('Unable to load vehicle mappings. Retry; nothing has been changed.');
 const recentDays=settings.data?.assignment_recent_days??7;
 const from=new Date(Date.parse(`${today}T12:00:00Z`)-(recentDays-1)*86400000).toISOString().slice(0,10);
 const [recent,counts,sources]=await Promise.all([
 readAllRows(supabaseAdmin!.from('cps_shipment_daily').select('id,provider_employee_id,provider_employee_name,work_date').eq('company_id',scope.companyId).eq('client','Amazon').eq('station_code',station).gte('work_date',from).lte('work_date',today).gt('total_activity',0).order('id')),
 readAllRows(supabaseAdmin!.from('cps_shipment_daily').select('id,provider_employee_id,total_delivery,c_return,swa_delivery,updated_at').eq('company_id',scope.companyId).eq('client','Amazon').eq('station_code',station).eq('work_date',date).order('id')),
 loadVehicleSources(scope.companyId).catch(()=>({sources:[],designations:[]}))
 ]);
 const totals=assignmentCounts(counts.error?[]:counts.data??[]),options=recentRiders(recent.error?[]:recent.data??[]);
 // Saved identities remain usable during a late feed or outage. No name-only matching.
 for(const r of [...defaults.data??[],...assignments.data??[]])if(!options.some(o=>o.id===riderKey(r.provider_employee_id)))options.push({id:riderKey(r.provider_employee_id),name:r.name,lastSeen:null});
 const sourceMap=new Map(sources.sources.map(s=>[s.id,s]));
 return{...empty,recentDays,options,confirmations:confirmations.data??[],vehicles:(vehicles.data??[]).map(v=>({...v,sourceCode:sourceMap.get(v.source_id)?.code||v.ownership_type,sourceName:sourceMap.get(v.source_id)?.name||v.ownership_type})) as VehicleDA[],defaults:defaults.data as DefaultDA[],assignments:(assignments.data??[]).map(a=>({...a,...totals.get(riderKey(a.provider_employee_id))??{delivered:null,cReturn:null,swa:null}})) as ConfirmedDA[],latestFeed:(counts.data??[]).map(r=>r.updated_at).sort().at(-1)??null,warning:recent.error||counts.error?'Shipment feed unavailable. Saved mappings remain usable; counts will refresh when the feed recovers.':undefined};
}
