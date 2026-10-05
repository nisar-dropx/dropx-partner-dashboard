import {getServiceAuthorization} from '@/lib/service-auth';
import {requireCompanyId} from '@/lib/company-scope';
import {hasPermission} from '@/lib/authorization';
import {supabaseAdmin} from '@/lib/supabase-admin';
export const dynamic='force-dynamic';
// The existing report-worker identity can read only its tenant's routing metadata.
export async function GET(request:Request){
 try{
  const auth=await getServiceAuthorization(request);
  if(!auth||!hasPermission(auth,'imports','access'))return Response.json({error:'Report service authentication required.'},{status:401});
  const company=requireCompanyId(auth);
  if(!supabaseAdmin)return Response.json({error:'Routing unavailable.'},{status:503});
  const result=await supabaseAdmin.from('stations').select('id,station_code,parent_station_id,is_active,lifecycle_status,location_models(code)').eq('company_id',company);
  if(result.error)return Response.json({error:'Routing unavailable.'},{status:503});
  return Response.json({companyId:company,stations:result.data},{headers:{'Cache-Control':'private, no-store'}});
 }catch{return Response.json({error:'Report service authentication failed.'},{status:401});}
}
