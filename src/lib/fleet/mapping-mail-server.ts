import 'server-only';
import {randomUUID} from 'node:crypto';
import {supabaseAdmin as db} from '@/lib/supabase-admin';
import {readAllRows} from '@/lib/supabase-pagination';
import {sendEmail} from '@/lib/email';
import {deliverFleetStatusBatch} from './daily-status-delivery';
import {buildMappingMail,scopePendingRows,validateMappingMailConfig,mappingMailClock,type MappingMailConfig,type PendingMailRow} from './mapping-mail';
const check=(r:any)=>{if(r.error)throw Error(r.error.message);return r.data??[];};
export async function loadMappingMailConfig(company:string){
 if(!db)throw Error('Mail database unavailable.');
 const r=await db.from('fleet_mapping_mail_settings').select('config,updated_at').eq('company_id',company).maybeSingle();if(r.error)throw Error(r.error.message);
 return r.data?{config:validateMappingMailConfig(r.data.config),updatedAt:r.data.updated_at}:null;
}
export async function mappingMailSnapshot(company:string,c:MappingMailConfig,date:string){
 if(!db)throw Error('Mail database unavailable.');
 const [ps,cs,ms,fs,ss,vs]=await Promise.all([
  readAllRows(db.from('profiles').select('id,email,full_name,is_active').eq('company_id',company).eq('is_active',true).order('id')),
  readAllRows(db.from('people_portal_access_candidates').select('user_id,location_scope_ids,has_all_location_access').eq('company_id',company).order('user_id')),
  readAllRows(db.from('company_product_memberships').select('id,user_id,product_code,location_scope_ids,has_all_location_access').eq('company_id',company).eq('is_active',true).order('id')),
  readAllRows(db.from('fleet_portal_memberships').select('user_id').eq('company_id',company).eq('is_active',true).order('user_id')),
  readAllRows(db.from('stations').select('id,station_code,station_email,station_manager_email').eq('company_id',company).eq('is_active',true).order('id')),
  readAllRows(db.from('fleet_da_mapping_periods').select('vehicle_id,station_code,effective_from,effective_to').eq('company_id',company).eq('eligible',true).lte('effective_from',date).or(`effective_to.is.null,effective_to.gt.${date.slice(0,7)}-01`).order('vehicle_id').order('effective_from'))
 ]);
 const profiles=check(ps),candidates=check(cs),memberships=check(ms),fleet=check(fs),stations=check(ss),periods=check(vs);
 const eligible=new Set(periods.map((v:any)=>v.station_code));
 const codes=stations.filter((s:any)=>eligible.has(s.station_code)).map((s:any)=>s.station_code);
 const rows:PendingMailRow[]=[];let expected:number|null=null;let expectedPending:number|null=null;
 if(codes.length)for(let offset=0;offset<100000;offset+=50){
  const r=await db.rpc('fleet_pending_da_days',{p_company:company,p_stations:codes,p_from:`${date.slice(0,7)}-01`,p_to:date,p_offset:offset,p_limit:50});
  if(r.error)throw Error('Pending data unavailable; nothing sent.');
  if(expected!==null&&expected!==r.data.totalGroups)throw Error('Pending mappings changed while loading. Retry for a consistent snapshot.');
  if(expectedPending!==null&&expectedPending!==r.data.totalPending)throw Error('Pending counts changed while loading. Retry.');
  expected=r.data.totalGroups;expectedPending=r.data.totalPending;rows.push(...r.data.rows);
  if(rows.length>=expected!)break;
  if(!r.data.rows.length||offset>=99950)throw Error('Pending report incomplete; nothing sent.');
 }
 if(new Set(rows.map(r=>`${r.station_code}|${r.work_date}`)).size!==rows.length||(expectedPending!==null&&rows.reduce((s,r)=>s+r.pending_count,0)!==expectedPending))throw Error('Pending report incomplete; nothing sent.');
 const recipients=c.recipients.map(r=>{
  const p=profiles.find((p:any)=>p.email?.toLowerCase()===r.email);
  const member=memberships.filter((m:any)=>m.user_id===p?.id);
  const candidate=candidates.find((x:any)=>x.user_id===p?.id);
  // Managers always follow current People scopes; never revive a wider legacy membership.
  const direct=stations.filter((s:any)=>[s.station_email,s.station_manager_email].some(e=>e?.toLowerCase()===r.email));
  const ops=member.filter((m:any)=>m.product_code==='operations');
  const ids=r.kind==='manager'?new Set(candidate?.location_scope_ids||[]):new Set([...direct.map((s:any)=>s.id),...ops.flatMap((m:any)=>m.location_scope_ids||[])]);
  const authorized=r.kind==='manager'?Boolean(p&&candidate&&ops.length):Boolean(direct.length||(p&&ops.length));
  const scope=authorized?stations.filter((s:any)=>eligible.has(s.station_code)&&((r.kind==='manager'&&candidate?.has_all_location_access)||ids.has(s.id))).map((s:any)=>s.station_code):[];
  const fleetAccess=member.some((m:any)=>m.product_code==='fleet')||fleet.some((f:any)=>f.user_id===p?.id);
  return{...r,name:p?.full_name||r.name,fleetLink:r.kind==='manager'&&r.fleetLink&&fleetAccess,stationCodes:scope.sort(),rows:scopePendingRows(rows,scope,date),skipReason:!authorized?'No current active access identity':!scope.length?'No eligible vehicle locations':null};
 });
 return{date,recipients,rows};
}
export async function dispatchMappingMail(company:string,slot:'introduction'|'daily'|'reminder',deadline=Date.now()+40000){
 const setting=await loadMappingMailConfig(company);if(!setting)throw Error('Configure mapping mail first.');
 const c=setting.config,{date}=mappingMailClock();
 const snapshot=await mappingMailSnapshot(company,c,date);
 const deliverable=snapshot.recipients.filter(r=>!r.skipReason&&(slot!=='reminder'||r.rows.length));
 const logs=check(await db!.from('fleet_mapping_mail_logs').select('recipient_email,status').eq('company_id',company).eq('report_date',date).eq('slot',slot));
 const claimed=new Set(logs.map((r:any)=>r.recipient_email));
 const batch=await deliverFleetStatusBatch(deliverable.filter(r=>!claimed.has(r.email)),async r=>{
  const prior=await db!.from('fleet_mapping_mail_logs').select('message_id,root_message_id,subject,status').eq('company_id',company).eq('recipient_email',r.email).order('created_at',{ascending:false}).limit(1).maybeSingle();
  if(prior.error)throw Error(prior.error.message);
  // Unknown SMTP outcome requires investigation; never auto-resend or split its thread.
  if(prior.data&&['sending','uncertain'].includes(prior.data.status))return{email:r.email,status:'blocked_uncertain'};
  const messageId=`<dropx.vehicle-da.${randomUUID()}@dropxlogistics.com>`;
  const root=prior.data?.root_message_id||messageId,subject=prior.data?.subject||c.subject;
  const mail=buildMappingMail(c,r,r.rows,date,slot==='reminder');
  const claim=await db!.from('fleet_mapping_mail_logs').insert({company_id:company,report_date:date,slot,recipient_email:r.email,station_codes:r.stationCodes,pending_vehicle_days:mail.total,status:'sending',message_id:messageId,root_message_id:root,subject}).select('id').single();
  if(claim.error?.code==='23505')return{email:r.email,status:'already_claimed'};
  if(claim.error)throw Error(claim.error.message);
  let accepted=false;
  try{
   await sendEmail({companyId:company,to:[r.email],subject,body:mail.text,html:mail.html,messageId,inReplyTo:prior.data?.message_id,references:prior.data?[...new Set([root,prior.data.message_id])]:undefined,timeoutMs:10000});accepted=true;
   const result=await db!.from('fleet_mapping_mail_logs').update({status:'sent',sent_at:new Date().toISOString()}).eq('id',claim.data.id);if(result.error)throw Error(result.error.message);
   return{email:r.email,status:'sent'};
  }catch(e){
   const error=e as {code?:string;message?:string};const definitive=!accepted&&['EAUTH','EENVELOPE','ECONNECTION','EDNS'].includes(error.code||'');
   const status=definitive?'failed':'uncertain';
   await db!.from('fleet_mapping_mail_logs').update({status,error_message:accepted?'SMTP accepted; log finalization failed. Do not resend.':(error.message||'Send failed').slice(0,700)}).eq('id',claim.data.id);
   return{email:r.email,status};
  }
 },{deadline});
 const final=check(await db!.from('fleet_mapping_mail_logs').select('recipient_email,status,station_codes,pending_vehicle_days').eq('company_id',company).eq('report_date',date).eq('slot',slot));
 return{date,slot,deferred:batch.deferred,results:final,skipped:snapshot.recipients.filter(r=>r.skipReason||(slot==='reminder'&&!r.rows.length)).map(r=>({email:r.email,reason:r.skipReason||'No pending dates this month'}))};
}
