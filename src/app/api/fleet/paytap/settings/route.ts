import {getAuthorization,hasPermission} from '@/lib/authorization';
import {hasActiveFleetMembership} from '@/lib/fleet-control';
import {supabaseAdmin} from '@/lib/supabase-admin';
import {withFleetSystemLog} from '@/lib/fleet/system-log';
import {validateMapping,parsePaytap} from '@/lib/fleet/paytap';
export const dynamic='force-dynamic';
async function access(edit=false){
 const a=await getAuthorization();if(!a?.companyId)return {error:Response.json({error:'Sign in to Fleet.'},{status:401})};
 if(!supabaseAdmin)return {error:Response.json({error:'Database unavailable.'},{status:503})};
 if(!(a.isMasterOwner||await hasActiveFleetMembership(a.companyId,a.userId))||!(a.isMasterOwner||a.hasAllLocationAccess&&hasPermission(a,'fleet_settings',edit?'edit':'access'))||edit&&a.readOnly)return {error:Response.json({error:'Company-wide Fleet Settings permission is required.'},{status:403})};
 return {auth:a};
}
export async function GET(request:Request){
 const a=await access();if('error'in a)return a.error;
 const page=Math.max(1,Math.min(10000,Number(new URL(request.url).searchParams.get('page'))||1));
 const [c,e]=await Promise.all([
  supabaseAdmin!.from('fleet_paytap_connections').select('endpoint_id,enabled,mapping,secret_id,verified_at,last_event_at').eq('company_id',a.auth.companyId!).maybeSingle(),
  supabaseAdmin!.from('fleet_paytap_events').select('id,event_id,received_at,state,reason,payload,fuel_id',{count:'exact'}).eq('company_id',a.auth.companyId!).order('received_at',{ascending:false}).order('id').range((page-1)*20,page*20-1)
 ]);
 if(c.error||e.error)return Response.json({error:'PayTap setup is unavailable. Check the integration migration.'},{status:503});
 return Response.json({connection:c.data?{...c.data,secret_id:undefined,hasSecret:Boolean(c.data.secret_id)}:null,events:e.data,total:e.count,page,canEdit:!a.auth.readOnly&&(a.auth.isMasterOwner||hasPermission(a.auth,'fleet_settings','edit'))},{headers:{'Cache-Control':'private, no-store'}});
}
async function save(request:Request){
 const a=await access(true);if('error'in a)return a.error;
 try{
  const body=await request.json();
  if(body.action==='reprocess'){
   const c=await supabaseAdmin!.from('fleet_paytap_connections').select('mapping').eq('company_id',a.auth.companyId!).single();
   const e=await supabaseAdmin!.from('fleet_paytap_events').select('*').eq('company_id',a.auth.companyId!).eq('id',body.id).single();
   if(c.error||e.error)return Response.json({error:'Event not available.'},{status:404});
   const parsed=parsePaytap(e.data.payload,validateMapping(c.data.mapping));
   const result=await supabaseAdmin!.rpc('fleet_paytap_ingest',{p_company:a.auth.companyId,p_event:e.data.event_id,p_hash:e.data.body_hash,p_payload:e.data.payload,p_state:parsed.state,p_reason:parsed.reason,p_fuel:parsed.fuel??null,p_reprocess:true});
   if(result.error)throw Error('Unable to process the event.');
   return Response.json({message:`Event status: ${result.data}`});
  }
  if(body.action!=='save')return Response.json({error:'Unknown action.'},{status:400});
  const mapping=validateMapping(body.mapping);
  if(typeof body.enabled!=='boolean'||body.secret&&typeof body.secret!=='string')throw Error('Invalid settings.');
  const result=await supabaseAdmin!.rpc('fleet_paytap_save_connection',{p_company:a.auth.companyId,p_actor:a.auth.viewerUserId??a.auth.userId,p_enabled:body.enabled,p_mapping:mapping,p_secret:body.secret||null});
  if(result.error)throw Error(result.error.message.includes('Save the PayTap')?'Save the PayTap signing secret before enabling reception.':'Could not save PayTap settings.');
  return Response.json({message:'PayTap settings saved.'});
 }catch(e){return Response.json({error:e instanceof Error?e.message:'Unable to save settings.'},{status:400});}
}
export const POST=withFleetSystemLog(save);
