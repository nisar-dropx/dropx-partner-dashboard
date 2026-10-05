import {getAuthorization} from '@/lib/authorization';
import {supabaseAdmin} from '@/lib/supabase-admin';
import {trackingScope,FleetReportError} from '@/lib/fleet/report-data';
import {validDate,istDate} from '@/lib/fleet/daily-report';
import {assignmentOptions,canAssignDay} from '@/lib/fleet/day-tracking-server';
import {withFleetSystemLog} from '@/lib/fleet/system-log';
export const dynamic='force-dynamic';
const fail=(e:unknown)=>Response.json({error:e instanceof FleetReportError?e.message:'Unable to update daily assignment.'},{status:e instanceof FleetReportError?e.status:500});
export async function GET(request:Request){
 const auth=await getAuthorization();if(!auth)return Response.json({error:'Login required.'},{status:401});
 try{
  const scope=await trackingScope(auth);if(!canAssignDay(auth))throw new FleetReportError('Vehicle assignment permission is required.',403);
  const p=new URL(request.url).searchParams,vehicle=scope.vehicles.find(v=>v.vehicle_no===p.get('vehicle')),date=p.get('date')??'';
  if(!vehicle)throw new FleetReportError('Vehicle is outside your permitted locations.',403);
  if(!validDate(date)||date>istDate())throw new FleetReportError('Choose today or a past date.',400);
  return Response.json({options:await assignmentOptions(scope.companyId,vehicle.station_code,date)},{headers:{'Cache-Control':'private, no-store'}});
 }catch(e){return fail(e);}
}
async function handlePOST(request:Request){
 const auth=await getAuthorization();if(!auth)return Response.json({error:'Login required.'},{status:401});
 try{
  if(request.headers.get('origin')&&request.headers.get('origin')!==new URL(request.url).origin)throw new FleetReportError('Invalid origin.',403);
  const scope=await trackingScope(auth);if(!canAssignDay(auth))throw new FleetReportError('Vehicle assignment permission is required.',403);
  const b=await request.json().catch(()=>null);if(!b||typeof b!=='object')throw new FleetReportError('Invalid request.',400);
  const v=scope.vehicles.find(v=>v.vehicle_no===b.vehicle_no);if(!v)throw new FleetReportError('Vehicle is outside your permitted locations.',403);
  if(!validDate(b.date)||b.date>istDate())throw new FleetReportError('Choose today or a past date.',400);
  if(b.action==='assignment.remove'){
   const r=await supabaseAdmin!.from('fleet_day_assignments').update({is_active:false,updated_by:auth.userId,updated_at:new Date().toISOString()}).eq('company_id',scope.companyId).eq('id',b.id).eq('vehicle_no',v.vehicle_no).eq('work_date',b.date).eq('is_active',true).select('id');
   if(r.error)throw new FleetReportError('Unable to remove assignment.');if(!r.data?.length)throw new FleetReportError('Assignment no longer exists.',409);
   return Response.json({ok:true});
  }
  if(b.action!=='assignment.add'||!['delivery','shipment_drop','other'].includes(b.purpose))throw new FleetReportError('Choose a valid trip purpose.',400);
  const options=await assignmentOptions(scope.companyId,v.station_code,b.date),selected=options.find(o=>o.key===b.associate);
  const name=selected?.name??(typeof b.name==='string'?b.name.trim():'');
  if(!name||name.length>160||(!selected&&b.purpose==='delivery')||(b.purpose==='delivery'&&!selected?.providerId))throw new FleetReportError('Delivery work requires a station associate with a provider ID. Register or map the DA in Workforce first.',400);
  const vehicle=await supabaseAdmin!.from('fleet_vehicles').select('id').eq('company_id',scope.companyId).eq('vehicle_no',v.vehicle_no).single();
  if(vehicle.error)throw new FleetReportError('Vehicle unavailable.');
  const r=await supabaseAdmin!.from('fleet_day_assignments').insert({company_id:scope.companyId,vehicle_id:vehicle.data.id,vehicle_no:v.vehicle_no,station_code:v.station_code,work_date:b.date,provider_employee_id:selected?.providerId??null,workforce_id:selected?.workforceId??null,name,source:selected?.source??'manual',purpose:b.purpose,remarks:typeof b.remarks==='string'?b.remarks.slice(0,1000):'',created_by:auth.userId,updated_by:auth.userId});
  if(r.error)throw new FleetReportError(r.error.code==='23505'?'This DA already has a vehicle assigned for this day. Remove the incorrect assignment first; daily packages cannot be counted twice.':'Unable to save assignment.',r.error.code==='23505'?409:500);
  return Response.json({ok:true});
 }catch(e){return fail(e);}
}
export const POST=withFleetSystemLog(handlePOST);
