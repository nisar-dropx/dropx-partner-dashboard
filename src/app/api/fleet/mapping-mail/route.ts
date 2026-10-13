import {getAuthorization,hasPermission} from '@/lib/authorization';
import {requireCompanyId} from '@/lib/company-scope';
import {currentAdminAccessSurface} from '@/lib/access-surface';
import {supabaseAdmin} from '@/lib/supabase-admin';
import {defaultMappingMailConfig,validateMappingMailConfig,mappingMailClock,buildMappingMail} from '@/lib/fleet/mapping-mail';
import {loadMappingMailConfig,mappingMailSnapshot,dispatchMappingMail} from '@/lib/fleet/mapping-mail-server';
export const dynamic='force-dynamic';export const maxDuration=60;
async function access(){const a=await getAuthorization();if(!a||a.readOnly||String(currentAdminAccessSurface())!=='fleet'||(!a.isMasterOwner&&!hasPermission(a,'fleet_settings','edit')))throw Error('Fleet settings edit access required.');return{a,company:requireCompanyId(a)};}
export async function GET(request:Request){try{
 const {company}=await access(),s=await loadMappingMailConfig(company);
 const p=new URL(request.url).searchParams;
 if(p.get('preview')==='1'&&s){const snap=await mappingMailSnapshot(company,s.config,mappingMailClock().date);return Response.json(snap,{headers:{'Cache-Control':'private, no-store'}});}
 if(p.get('email')&&s){const snap=await mappingMailSnapshot(company,s.config,mappingMailClock().date),r=snap.recipients.find(r=>r.email===p.get('email'));if(!r||r.skipReason)throw Error('Recipient is not currently eligible.');return new Response(buildMappingMail(s.config,r,r.rows,snap.date).html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store'}});}
 const logs=await supabaseAdmin!.from('fleet_mapping_mail_logs').select('created_at,report_date,slot,recipient_email,status,station_codes,error_message,pending_vehicle_days').eq('company_id',company).order('created_at',{ascending:false}).limit(250);if(logs.error)throw Error(logs.error.message);
 const history=await supabaseAdmin!.from('fleet_mapping_mail_settings_history').select('created_at,actor_id,before_config,after_config').eq('company_id',company).order('created_at',{ascending:false}).limit(20);if(history.error)throw Error(history.error.message);
 return Response.json({config:s?.config||defaultMappingMailConfig,updatedAt:s?.updatedAt||null,logs:logs.data,history:history.data},{headers:{'Cache-Control':'private, no-store'}});
 }catch(e){return Response.json({error:e instanceof Error?e.message:'Unable to load mapping mail.'},{status:400});}}
export async function POST(request:Request){try{
 const origin=request.headers.get('origin');if(origin!==new URL(request.url).origin)return Response.json({error:'Same-origin request required.'},{status:403});
 const {a,company}=await access(),body=await request.json();
 if(body.action==='save'){
  const c=validateMappingMailConfig(body.config);const prior=await loadMappingMailConfig(company);
  if(prior&&prior.updatedAt!==body.updatedAt)throw Error('Settings changed. Refresh before saving.');
  const q=prior?supabaseAdmin!.from('fleet_mapping_mail_settings').update({config:c,updated_by:a.userId,updated_at:new Date().toISOString()}).eq('company_id',company).eq('updated_at',prior.updatedAt):supabaseAdmin!.from('fleet_mapping_mail_settings').insert({company_id:company,config:c,updated_by:a.userId});
  const result=await q.select('company_id');if(result.error||!result.data?.length)throw Error(result.error?.message||'Settings changed. Refresh.');return Response.json({saved:true});
 }
 if(body.action==='send')return Response.json(await dispatchMappingMail(company,'introduction'));
 throw Error('Unknown action.');
 }catch(e){return Response.json({error:e instanceof Error?e.message:'Mapping mail failed.'},{status:400});}}
