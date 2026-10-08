import {getAuthorization} from '@/lib/authorization';
import {mappingAdmin as supabaseAdmin} from '@/lib/fleet/da-mapping-client';
import {requireCompanyId} from '@/lib/company-scope';
import {FleetReportError} from '@/lib/fleet/report-data';
import {loadMapping,mappingScope,mappingStationScope} from '@/lib/fleet/da-mapping-server';
import {riderKey,riderAvailableAt} from '@/lib/fleet/da-mapping';
import {istDate,validDate} from '@/lib/fleet/daily-report';
import {withFleetSystemLog} from '@/lib/fleet/system-log';
export const dynamic='force-dynamic';
async function hasPendingMapping(auth:NonNullable<Awaited<ReturnType<typeof getAuthorization>>>){const scope=await mappingStationScope(auth);if(!scope.stations.length)return false;const r=await supabaseAdmin!.rpc('fleet_pending_da_days',{p_company:scope.companyId,p_stations:scope.stations.map(s=>s.code),p_limit:1});return !r.error&&Number(r.data?.totalPending)>0;}
function fail(e:unknown){return Response.json({error:e instanceof FleetReportError?e.message:'Mapping could not be saved. Retry; your selection is still on screen.'},{status:e instanceof FleetReportError?e.status:500});}
export async function GET(request:Request){
 try{const auth=await getAuthorization();if(!auth)return Response.json({error:'Login required.'},{status:401});const p=new URL(request.url).searchParams;if(p.get('eligibility')==='1'){const scope=await mappingScope(auth);return Response.json({available:scope.stations.length>0||await hasPendingMapping(auth)},{headers:{'Cache-Control':'private, no-store'}});}const date=p.get('date')||istDate();if(!validDate(date)||date>istDate())throw new FleetReportError('Choose today or a past date.',400);return Response.json(await loadMapping(auth,date,p.get('station')||'',p.get('registry')==='1'),{headers:{'Cache-Control':'private, no-store'}});}catch(e){return fail(e);}
}
export const POST=withFleetSystemLog(async(request:Request)=>{
 try{
 const auth=await getAuthorization();if(!auth)return Response.json({error:'Login required.'},{status:401});
 if(request.headers.get('origin')&&request.headers.get('origin')!==new URL(request.url).origin)throw new FleetReportError('Invalid request origin.',403);
 const b=await request.json().catch(()=>null);if(!b||typeof b.station!=='string'||!validDate(b.date)||b.date>istDate())throw new FleetReportError('Choose a station and a valid date.',400);
 const d=await loadMapping(auth,b.date,b.station,b.action==='mapping.default',false),company=requireCompanyId(auth);
 if(auth.readOnly)throw new FleetReportError('Daily mapping edit permission is required.',403);
 if(b.action==='mapping.alert-policy'){
  if(!d.canPolicy)throw new FleetReportError('Pending alert settings are managed in Fleet Masters.',403);
  const first=await supabaseAdmin!.from('fleet_da_mapping_periods').select('effective_from').eq('company_id',company).order('effective_from').limit(1).maybeSingle();
  if(first.error)throw new FleetReportError('Unable to verify tracking history. Retry.');
  if(!validDate(b.alertFrom)||b.alertFrom>istDate()||!first.data||b.alertFrom<first.data.effective_from)throw new FleetReportError('Choose a date within recorded mapping history and today.',400);
  const result=await supabaseAdmin!.from('fleet_control_settings').update({assignment_alert_from:b.alertFrom}).eq('company_id',company).select('company_id');
  if(result.error||!result.data?.length)throw new FleetReportError('Could not save pending alert settings.');return Response.json({ok:true});
 }
 if(b.action==='mapping.policy'){
  if(!d.canPolicy)throw new FleetReportError('Default DA settings are managed in Fleet Masters.',403);
  if(!Number.isInteger(b.recentDays)||b.recentDays<3||b.recentDays>30)throw new FleetReportError('Fleet master permission and a window of 3–30 days are required.',400);
  const r=await supabaseAdmin!.from('fleet_control_settings').update({assignment_recent_days:b.recentDays}).eq('company_id',company).select('company_id');if(r.error||!r.data?.length)throw new FleetReportError('Could not save the rider window.');return Response.json({ok:true});
 }
 if(b.action==='mapping.default'){
  if(!d.canDefaults)throw new FleetReportError('Default DA setup is managed with Fleet Masters edit permission.',403);
  const v=d.vehicles.find(v=>v.id===b.vehicleId);if(!v)throw new FleetReportError('Vehicle is outside this station.',403);
  const existing=d.defaults.find(x=>x.vehicle_id===v.id);
  if((existing?.updated_at??null)!==(b.expectedUpdatedAt??null))throw new FleetReportError('Default changed. Refresh before saving.',409);
  if(!b.providerId){let q=supabaseAdmin!.from('fleet_vehicle_da_defaults').delete().eq('company_id',company).eq('vehicle_id',v.id);if(existing)q=q.eq('updated_at',existing.updated_at);const r=await q.select('id');if(r.error||(existing&&!r.data?.length))throw new FleetReportError('Default changed. Refresh before saving.',409);return Response.json({ok:true});}
  const o=d.options.find(o=>o.id===riderKey(String(b.providerId))&&riderAvailableAt(o,v.station_code));if(!o)throw new FleetReportError('Choose a recent station rider ID.',400);
  const value={company_id:company,vehicle_id:v.id,vehicle_no:v.vehicle_no,station_code:v.station_code,provider_employee_id:o.id,name:o.name,updated_by:auth.userId,updated_at:new Date().toISOString()};
  const r=existing?await supabaseAdmin!.from('fleet_vehicle_da_defaults').update(value).eq('company_id',company).eq('id',existing.id).eq('updated_at',existing.updated_at).select('id'):await supabaseAdmin!.from('fleet_vehicle_da_defaults').insert({...value,created_by:auth.userId}).select('id');
  if(r.error||!r.data?.length)throw new FleetReportError('Default changed or could not be saved. Refresh and retry.',409);return Response.json({ok:true});
 }
 if(!d.canEdit)throw new FleetReportError('Daily mapping edit permission is required.',403);
 if(b.action!=='mapping.confirm'||!Array.isArray(b.rows)||!b.rows.length||b.rows.length>200)throw new FleetReportError('Select between 1 and 200 vehicles to confirm together.',400);
 const seen=new Set<string>(),seenVehicles=new Set<string>();
 const rows=b.rows.map((r:Record<string,unknown>)=>{
  const v=d.vehicles.find(v=>v.id===r.vehicleId);if(!v)throw new FleetReportError('Vehicle is outside this station.',403);
  if(seenVehicles.has(v.id))throw new FleetReportError('A vehicle was selected twice.',400);seenVehicles.add(v.id);
  if(!Array.isArray(r.ids)||r.ids.length>10||!Array.isArray(r.expectedIds))throw new FleetReportError('Invalid rider selection.',400);
  const existing=d.assignments.filter(a=>a.vehicle_id===v.id);
  const remarks=typeof r.remarks==='string'?r.remarks.trim():'';
  const dayStatus=typeof r.dayStatus==='string'?r.dayStatus:'';
  if(dayStatus&&(!d.dayStatuses?.some(s=>s.key===dayStatus)||r.ids.length>0||remarks.length<3))throw new FleetReportError('Choose an unavailable status, remove rider assignments and add a reason for this date.',400);
  const unchanged=[...r.ids].map(String).map(riderKey).sort().join('|')===existing.map(a=>riderKey(a.provider_employee_id)).sort().join('|');
  if((!r.ids.length||(!unchanged&&existing.length))&&remarks.length<3)throw new FleetReportError('Add a short reason when clearing or correcting an assignment.',400);
  const associates=r.ids.map((id:unknown)=>{if(typeof id!=='string')throw new FleetReportError('Invalid rider ID.',400);const o=d.options.find(o=>o.id===riderKey(id)&&riderAvailableAt(o,v.station_code));if(!o)throw new FleetReportError('Rider is no longer available. Refresh the list.',409);if(seen.has(o.id))throw new FleetReportError('The same rider cannot be assigned to two vans on one day.',409);seen.add(o.id);return{provider_id:o.id,name:o.name};});
  return{vehicle_id:v.id,station_code:v.station_code,expected_ids:[...r.expectedIds].sort(),expected_revision:r.expectedRevision??null,associates,remarks,day_status:dayStatus||null};
 });
 const result=await supabaseAdmin!.rpc('fleet_confirm_da_day',{p_company:company,p_actor:auth.userId,p_date:b.date,p_rows:rows});
 if(result.error){if(result.error.code==='23505')throw new FleetReportError('A selected rider already belongs to another vehicle on this date. Select both vehicles to move the mapping, or correct the existing mapping first.',409);if(result.error.message.includes('changed'))throw new FleetReportError('Assignments or vehicle placement changed. Refresh before saving.',409);throw new FleetReportError('Could not confirm mappings. Nothing in this batch was saved.');}
 return Response.json({ok:true,saved:result.data});
 }catch(e){return fail(e);}
});
