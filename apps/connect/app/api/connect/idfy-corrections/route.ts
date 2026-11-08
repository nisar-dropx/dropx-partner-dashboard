import {NextResponse} from 'next/server';
import {ownIdfyContext,idfyWorker} from '@/lib/connect-idfy';
export const dynamic='force-dynamic';
export const maxDuration=120;
const reply=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{'Cache-Control':'private, no-store',Vary:'Cookie'}});
type Source={idfy:{profileId:string};forms:Array<{blockId:string;version:string;unsupported:boolean}>};
export async function GET(request:Request){
 try{
  const {account,owner,snapshot,db}=await ownIdfyContext(request);
  if(!owner||!snapshot)return reply({pending:0,linked:false,history:[]});
  const history=await db.from('amazon_da_idfy_actions').select('id,block_id,status,actor_name,actor_role,changes,result_message,created_at,updated_at,events:amazon_da_idfy_events(status,message,created_at)').eq('company_id',account.companyId).eq('provider_id',owner.provider_id).eq('action','response').order('created_at',{ascending:false}).limit(20);
  if(history.error)throw new Error('Verification history could not load.');
  const base={linked:true,pending:snapshot.request_block_ids?.length||0,checkedAt:snapshot.requests_checked_at,history:history.data};
  if(new URL(request.url).searchParams.get('details')!=='1')return reply(base);
  const source=await idfyWorker<Source>('idfy',{companyId:account.companyId,stationId:snapshot.station_id,providerId:owner.provider_id,expectedEmail:owner.identity_email});
  return reply({...base,...source,pending:source.forms.length});
 }catch(error){return reply({error:error instanceof Error?error.message:'Verification could not load.'},403);}
}
export async function POST(request:Request){
 try{
  if(request.headers.get('origin')!==new URL(request.url).origin)return reply({error:'Reload before submitting.'},403);
  const {account,owner,snapshot,db}=await ownIdfyContext(request);
  if(!owner||!snapshot)return reply({error:'Your verified Amazon profile is not linked. Contact your station.'},409);
  const text=await request.text();if(text.length>55000)return reply({error:'Response too large.'},400);
  const body=JSON.parse(text),id=String(body.id||'');
  if(!/^[0-9a-f-]{36}$/i.test(id))return reply({error:'Reload the response form.'},400);
  const prior=await db.from('amazon_da_idfy_actions').select('id,company_id,provider_id,actor_id,actor_profile_type,status,result_message').eq('id',id).maybeSingle();
  if(prior.error)throw new Error('Response history is unavailable.');
  if(prior.data){
   if(prior.data.company_id!==account.companyId||prior.data.provider_id!==owner.provider_id||prior.data.actor_id!==account.id||prior.data.actor_profile_type!==account.profileType)return reply({error:'Response is outside your account.'},403);
   if(body.operation==='reconcile')return reply(await idfyWorker('idfy-reconcile',{id}));
   return reply({status:prior.data.status,message:prior.data.result_message});
  }
  if(body.operation==='reconcile')return reply({error:'Response not found.'},404);
  const blockId=String(body.blockId||''),version=String(body.version||'');
  if(!/^\d+$/.test(blockId)||!/^[a-f0-9]{64}$/.test(version)||!body.values||typeof body.values!=='object'||Array.isArray(body.values))return reply({error:'Reload the response form.'},400);
  const source=await idfyWorker<Source>('idfy',{companyId:account.companyId,stationId:snapshot.station_id,providerId:owner.provider_id,expectedEmail:owner.identity_email});
  if(!source.forms.some(f=>f.blockId===blockId&&f.version===version&&!f.unsupported))return reply({error:'This request changed or was already answered. Refresh to check.'},409);
  const saved=await db.from('amazon_da_idfy_actions').insert({id,company_id:account.companyId,station_id:snapshot.station_id,provider_id:owner.provider_id,idfy_profile_id:source.idfy.profileId,block_id:blockId,action:'response',actor_id:account.id,actor_profile_type:account.profileType,actor_name:account.name||'Associate',actor_role:'Associate · DropX One',form_version:version,values_submitted:body.values,status:'queued'});
  if(saved.error)return reply({error:saved.error.code==='23505'?'A response is already processing. Refresh its status.':'Could not record your response. Nothing was sent.'},409);
  try{return reply(await idfyWorker('idfy-submit',{id}));}catch{return reply({status:'unconfirmed',message:'Response recorded. Check its status before trying again.'},202);}
 }catch(error){return reply({error:error instanceof Error?error.message:'Could not submit your response.'},403);}
}
