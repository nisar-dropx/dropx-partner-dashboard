"use server";
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {requirePagePermission} from '@/lib/authorization';
import {requireCompanyId} from '@/lib/company-scope';
import {digestDatabase} from '@/lib/portal-digest-delivery';
import {validateDigestSettings} from '@/lib/digest-settings';
import {validatePerformanceDataUpdateSettings} from '@/lib/performance-data-update-settings';
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
