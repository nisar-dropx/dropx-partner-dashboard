"use server";
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {requirePagePermission} from '@/lib/authorization';
import {requireCompanyId} from '@/lib/company-scope';
import {digestDatabase} from '@/lib/portal-digest-delivery';
import {validateDigestSettings} from '@/lib/digest-settings';
import {validatePerformanceDataUpdateSettings} from '@/lib/performance-data-update-settings';
import {buildCodPendingDigest} from '@/lib/cod-pending-digest';
import {deliverPortalDigestQueue} from '@/lib/portal-digest-delivery';
export async function savePerformanceDataUpdateSettings(form:FormData){
 const auth=await requirePagePermission('ops_notification_settings','edit');const company=requireCompanyId(auth);const db=digestDatabase();
 let errorMessage='';
 try{
  const old=await db.from('portal_notification_controls').select('config').eq('company_id',company).eq('portal','ops').eq('event_key','performance_data_updated').single();
  if(old.error)throw new Error(old.error.message);
  const update=validatePerformanceDataUpdateSettings(form,old.data.config);
  const result=await db.from('portal_notification_controls').update({...update,updated_by:auth.userId,updated_at:new Date().toISOString()}).eq('company_id',company).eq('portal','ops').eq('event_key','performance_data_updated').select('company_id').single();
  if(result.error)throw new Error(result.error.message);
 }catch(error){errorMessage=error instanceof Error?error.message:'Settings could not be saved.';}
 revalidatePath('/settings/notifications');redirect('/settings/notifications?'+(errorMessage?'error='+encodeURIComponent(errorMessage):'saved=1')+'#performance-data-updated');
}
export async function saveDigestSettings(form:FormData){
 const auth=await requirePagePermission('ops_notification_settings','edit');const company=requireCompanyId(auth);const db=digestDatabase();
 let errorMessage='';
 try{
 const old=await db.from('portal_notification_controls').select('config').eq('company_id',company).eq('portal','ops').eq('event_key','review_digest').single();
 if(old.error)throw new Error(old.error.message);
 const update=validateDigestSettings(form,old.data.config);
 const result=await db.from('portal_notification_controls').update({...update,updated_by:auth.userId,updated_at:new Date().toISOString()}).eq('company_id',company).eq('portal','ops').eq('event_key','review_digest');
 if(result.error)throw new Error(result.error.message);
 }catch(error){errorMessage=error instanceof Error?error.message:'Settings could not be saved.';}
 revalidatePath('/settings/notifications');redirect('/settings/notifications?'+(errorMessage?'error='+encodeURIComponent(errorMessage):'saved=1'));
}

export async function saveCodPendingSettings(form:FormData){
 const auth=await requirePagePermission('ops_notification_settings','edit'),company=requireCompanyId(auth),state=String(form.get('state')||'');
 if(!['enabled','disabled','paused'].includes(state))redirect('/settings/notifications?error=Invalid+delivery+state#cod-pending');
 const result=await digestDatabase().from('portal_notification_controls').update({state,paused_until:null,updated_by:auth.userId,updated_at:new Date().toISOString()}).eq('company_id',company).eq('portal','ops').in('event_key',['cod_pending_evening','cod_pending_morning']).select('event_key');
 revalidatePath('/settings/notifications');
 redirect('/settings/notifications?'+(result.error||result.data?.length!==2?'error=COD+schedule+could+not+be+saved':'saved=1')+'#cod-pending');
}

export async function sendCodPendingCurrentStatus(){
 const auth=await requirePagePermission('ops_notification_settings','edit'),company=requireCompanyId(auth),db=digestDatabase();
 let notice='';
 try{
  const date=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(part=>[part.type,part.value]));
  const reportDate=`${date.year}-${date.month}-${date.day}`;
  const control=await db.from('portal_notification_controls').select('*').eq('company_id',company).eq('portal','ops').eq('event_key','cod_pending_evening').single();
  if(control.error)throw new Error(control.error.message);
  if(control.data.state!=='enabled'||control.data.config?.delivery_ready!==true)throw new Error('COD delivery is not enabled.');
  const batch=await buildCodPendingDigest(db,control.data,reportDate);
  if(!batch.messages.length)throw new Error('No eligible COD recipients were found.');
  if(new Set(batch.messages.map(message=>message.email)).size!==batch.messages.length)throw new Error('Conflicting recipient scopes; no email queued.');
  const queued=await db.rpc('portal_enqueue_digest',{p_company_id:company,p_portal:'ops',p_event_key:'cod_pending_current',p_report_date:reportDate,p_snapshot_at:batch.checkedAt,p_messages:batch.messages});
  if(queued.error)throw new Error(queued.error.message);
  if(queued.data!==true)throw new Error('Today’s current-status reply has already been queued or sent.');
  const result=await deliverPortalDigestQueue(db,'ops',{queued:batch.messages.length,accepted:0,uncertain:0,skipped:0,errors:[]});
  if(result.errors.length||result.uncertain)throw new Error(`${result.accepted} accepted; ${result.uncertain} require delivery verification; ${result.skipped} skipped.`);
  notice=`Current COD status replied to ${result.accepted} existing monthly email threads.`;
 }catch(error){
  revalidatePath('/settings/notifications');
  redirect('/settings/notifications?error='+encodeURIComponent(error instanceof Error?error.message:'Current COD status could not be sent.')+'#cod-pending');
 }
 revalidatePath('/settings/notifications');
 redirect('/settings/notifications?notice='+encodeURIComponent(notice)+'#cod-pending');
}
