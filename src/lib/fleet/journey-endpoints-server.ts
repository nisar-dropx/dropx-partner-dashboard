import {supabaseAdmin} from '@/lib/supabase-admin';
import {readAllRows} from '@/lib/supabase-pagination';
import {checkJourneyLocations,stationAt,type JourneyEndpoints,type EndpointBase} from './journey-endpoints';
/** Optional enrichment: errors here must never prevent GPS distance storage. */
export async function loadJourneyLocationCheck(companyId:string,vehicleNo:string,date:string,endpoints:JourneyEndpoints|undefined){
 const missing=()=>checkJourneyLocations(date,{...endpoints,start:endpoints?.start??null,end:endpoints?.end??null,observedThrough:endpoints?.observedThrough??null}, {start:null,end:null});
 try{
  if(!supabaseAdmin)return null;
  const vehicle=await supabaseAdmin.from('fleet_vehicles').select('id,station_code,created_at,deployment_date').eq('company_id',companyId).eq('vehicle_no',vehicleNo).maybeSingle();
  if(vehicle.error)return null;
  if(!vehicle.data)return missing();
  const v=vehicle.data;
  if(v.deployment_date&&date<v.deployment_date)return missing();
  const history=await readAllRows(supabaseAdmin.from('dashboard_app_event_logs').select('id,created_at,metadata').eq('company_id',companyId).eq('module','fleet').eq('subject_id',v.id).eq('event_code','fleet_vehicle_transferred').gte('created_at',`${date}T00:00:00+05:30`).order('created_at').order('id'));
  if(history.error)return null;
  const codes={start:stationAt(v.station_code,endpoints?.start?.at||`${date}T00:00:00+05:30`,history.data??[]),end:stationAt(v.station_code,endpoints?.end?.at||`${date}T23:59:59+05:30`,history.data??[])};
  const stations=await supabaseAdmin.from('stations').select('station_code,station_name,latitude,longitude,geofence_radius_m').eq('company_id',companyId).in('station_code',[...new Set(Object.values(codes).filter((c):c is string=>!!c))]);
  if(stations.error)return null;
  const base=(kind:'start'|'end'):EndpointBase|null=>{const s=stations.data?.find(s=>s.station_code===codes[kind]);return s&&s.latitude!=null&&s.longitude!=null&&s.geofence_radius_m>0?{code:s.station_code,label:s.station_code,lat:Number(s.latitude),lng:Number(s.longitude),radiusM:Number(s.geofence_radius_m)}:null;};
  return checkJourneyLocations(date,endpoints,{start:base('start'),end:base('end')});
 }catch{return null;}
}
