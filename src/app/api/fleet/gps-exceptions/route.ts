import { withFleetSystemLog } from "@/lib/fleet/system-log";
import {getAuthorization,hasPermission} from '@/lib/authorization';
import {requireCompanyId} from '@/lib/company-scope';
import {hasActiveFleetMembership} from '@/lib/fleet-control';
import {supabaseAdmin} from '@/lib/supabase-admin';
import {gpsReviewReasons} from '@/lib/fleet/gps-exceptions';
import {getWheelseyeAccessToken} from '@/lib/wheelseye';
import {loadWheelseyeMovement} from '@/lib/wheelseye-history';
export const dynamic='force-dynamic';
async function access(vehicleNo:string,date:string,edit=false){
 const auth=await getAuthorization();
 if(!auth)throw Object.assign(new Error('Login required.'),{status:401});
 if(!supabaseAdmin)throw new Error('Database unavailable.');
 const company=requireCompanyId(auth);
 if(!auth.isMasterOwner&&(!(await hasActiveFleetMembership(company,auth.userId))||!hasPermission(auth,'fleet_tracking','access')||(edit&&!hasPermission(auth,'fleet_tracking','edit')&&!hasPermission(auth,'fleet_action_center','edit'))))throw Object.assign(new Error('Fleet tracking permission denied.'),{status:403});
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw new Error('Choose a valid movement date.');
 const vehicle=await supabaseAdmin.from('fleet_vehicles').select('id,vehicle_no,station_code').eq('company_id',company).eq('vehicle_no',vehicleNo).single();
 if(vehicle.error)throw new Error('Vehicle not found.');
 if(!auth.isMasterOwner&&!auth.hasAllLocationAccess){const stations=await supabaseAdmin.from('stations').select('station_code').eq('company_id',company).in('id',auth.locationScopeIds.length?auth.locationScopeIds:['00000000-0000-0000-0000-000000000000']);if(stations.error||!stations.data?.some(s=>s.station_code===vehicle.data.station_code))throw Object.assign(new Error('Vehicle is outside your assigned locations.'),{status:403});}
 const movement=await supabaseAdmin.from('fleet_daily_km').select('id').eq('company_id',company).eq('vehicle_no',vehicleNo).eq('movement_date',date).eq('late_night',true).limit(1);
 if(movement.error||!movement.data?.length)throw new Error('No recorded after-hours exception for this vehicle and date.');
 return {auth,company,vehicle:vehicle.data};
}
const failure=(error:unknown)=>Response.json({error:error instanceof Error?error.message:'Unable to process exception.'},{status:Number((error as {status?:number})?.status)||400});
export async function GET(request:Request){try{
 const url=new URL(request.url),vehicle=(url.searchParams.get('vehicle')||'').trim().toUpperCase(),date=url.searchParams.get('date')||'';
 const {company}=await access(vehicle,date);
 const token=await getWheelseyeAccessToken(company);if(!token)throw new Error('GPS history is currently unavailable. The saved daily summary is shown below.');
 return Response.json(await loadWheelseyeMovement(token,vehicle,date),{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){return failure(error);}}
async function handlePOST(request: Request){try{
 const body=await request.json(),vehicleNo=String(body.vehicleNo||'').trim().toUpperCase(),date=String(body.date||'');
 const {auth,company,vehicle}=await access(vehicleNo,date,true);
 const reason=String(body.reason||''),remarks=String(body.remarks||'').trim();
 if(!Object.hasOwn(gpsReviewReasons,reason)||!remarks||remarks.length>2000)throw new Error('Choose a reason and enter remarks (up to 2,000 characters).');
 const review={company_id:company,vehicle_id:vehicle.id,vehicle_no:vehicleNo,movement_date:date,exception_type:'after_hours',reason,remarks,reviewed_by:auth.userId,reviewed_by_name:auth.fullName||auth.email||'Fleet user',reviewed_at:new Date().toISOString()};
 const result=await supabaseAdmin!.from('fleet_gps_exception_reviews').upsert(review,{onConflict:'company_id,vehicle_no,movement_date,exception_type'});
 if(result.error)throw new Error(result.error.message);
 return Response.json({ok:true,review:{vehicleNo,date,reason,remarks,reviewedBy:review.reviewed_by_name,reviewedAt:review.reviewed_at}});
 }catch(error){return failure(error);}}

export const POST = withFleetSystemLog(handlePOST);
