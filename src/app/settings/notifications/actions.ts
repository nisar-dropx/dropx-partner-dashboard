"use server";
import { defaultNowControl, nowDigestEvents, buildAmazonNowDigest, type NowDigestEvent } from "@/lib/amazon-now-digest";
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {requirePagePermission,isCompanyOwner} from '@/lib/authorization';
import {requireCompanyId} from '@/lib/company-scope';
import {digestDatabase} from '@/lib/portal-digest-delivery';
import {validateDigestSettings} from '@/lib/digest-settings';
import {validatePerformanceDataUpdateSettings} from '@/lib/performance-data-update-settings';
import {sendCurrentCodStatus} from '@/lib/send-current-cod-status';
import {registrationEvents} from '@/lib/registration-pendency';
export async function saveRegistrationDigestSettings(form:FormData){
 const auth=await requirePagePermission('ops_notification_settings','edit'),company=requireCompanyId(auth),db=digestDatabase();
 const event=String(form.get('event')||''),state=String(form.get('state')||''),time=String(form.get('schedule_time')||'');
 let error='';
 try{
  if(!registrationEvents.includes(event as typeof registrationEvents[number])||!['enabled','paused','disabled'].includes(state)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))throw Error('Choose a valid registration schedule.');
  const old=await db.from('portal_notification_controls').select('config').eq('company_id',company).eq('portal','ops').eq('event_key',event).single();
  if(old.error)throw Error('Registration schedule unavailable.');
  if(state==='enabled'&&old.data.config.delivery_ready!==true)throw Error('Production verification is required before enabling this schedule.');
  if(form.has('summary_subscription_present')){
   if(!isCompanyOwner(auth)||auth.isPreview||auth.readOnly)throw Error('Only the signed-in company owner can change their consolidated subscription.');
   const existing=Array.isArray(old.data.config.consolidated_owner_user_ids)?old.data.config.consolidated_owner_user_ids:[];
   old.data.config.consolidated_owner_user_ids=[...new Set([...existing.filter((id:unknown)=>id!==auth.userId),...(form.get('consolidated_summary')==='on'?[auth.userId]:[])])];
  }
  const saved=await db.from('portal_notification_controls').update({state,paused_until:null,config:{...old.data.config,schedule_time:time,day_offset:0,timezone:'Asia/Kolkata',send_zero_cases:false},updated_by:auth.userId,updated_at:new Date().toISOString()}).eq('company_id',company).eq('portal','ops').eq('event_key',event).select('event_key').single();
  if(saved.error)throw Error('Registration schedule could not be saved.');
 }catch(e){error=e instanceof Error?e.message:'Settings unavailable.';}
 revalidatePath('/settings/notifications');redirect('/settings/notifications?'+(error?'error='+encodeURIComponent(error):'saved=1')+'#registration-pendency');
}
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
 const auth=await requirePagePermission('ops_notification_settings','edit'),company=requireCompanyId(auth);
 let notice='';
 try{
  const result=await sendCurrentCodStatus(company);
  if(result.errors.length||result.uncertain)throw new Error(`${result.accepted} accepted; ${result.uncertain} require delivery verification; ${result.skipped} skipped.`);
  notice=`Current COD status replied to ${result.accepted} existing monthly email threads.`;
 }catch(error){
  revalidatePath('/settings/notifications');
  redirect('/settings/notifications?error='+encodeURIComponent(error instanceof Error?error.message:'Current COD status could not be sent.')+'#cod-pending');
 }
 revalidatePath('/settings/notifications');
 redirect('/settings/notifications?notice='+encodeURIComponent(notice)+'#cod-pending');
}

export async function saveLossRecoveryDigestSettings(form: FormData) {
  const auth = await requirePagePermission("ops_notification_settings", "edit");
  const company = requireCompanyId(auth);
  const db = digestDatabase();
  let error = "";
  try {
    const state = String(form.get("state") || "");
    const time = String(form.get("schedule_time") || "");
    const subject = String(form.get("subject") || "").trim();
    if (!["enabled", "paused", "disabled"].includes(state)) throw new Error("Choose a valid delivery state.");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Choose a valid daily time (IST).");
    if (!subject || subject.length > 250 || /[\r\n]/.test(subject) || !subject.includes("{{date}}")) {
      throw new Error("Subject must include {{date}} on one line.");
    }
    const old = await db
      .from("portal_notification_controls")
      .select("config")
      .eq("company_id", company)
      .eq("portal", "ops")
      .eq("event_key", "loss_recovery_action_digest")
      .single();
    if (old.error) throw new Error("Loss recovery digest control is not configured yet.");
    if (state === "enabled" && old.data.config.delivery_ready !== true) {
      throw new Error(
        "Mark delivery_ready after recipient verification (SQL or support) before enabling. Keep disabled for the dry-run day.",
      );
    }
    const saved = await db
      .from("portal_notification_controls")
      .update({
        state,
        paused_until: null,
        subject_template: subject,
        config: {
          ...old.data.config,
          schedule_time: time,
          timezone: "Asia/Kolkata",
          day_offset: 0,
          delivery_window_minutes: Number(old.data.config.delivery_window_minutes) || 90,
        },
        updated_by: auth.userId,
        updated_at: new Date().toISOString(),
      })
      .eq("company_id", company)
      .eq("portal", "ops")
      .eq("event_key", "loss_recovery_action_digest")
      .select("event_key")
      .single();
    if (saved.error) throw new Error("Loss recovery digest settings could not be saved.");
  } catch (e) {
    error = e instanceof Error ? e.message : "Settings unavailable.";
  }
  revalidatePath("/settings/notifications");
  redirect(
    "/settings/notifications?" +
      (error ? "error=" + encodeURIComponent(error) : "saved=1") +
      "#loss-recovery-digest",
  );
}

export async function saveAdHocDigestSettings(form:FormData){
 const auth=await requirePagePermission('ops_notification_settings','edit'),company=requireCompanyId(auth),db=digestDatabase();
 let error='';
 try{
  const old=await db.from('portal_notification_controls').select('config').eq('company_id',company).eq('portal','ops').eq('event_key','adhoc_usage_digest').single();
  if(old.error)throw new Error('Schedule unavailable.');
  const update=validateDigestSettings(form,old.data.config);
  const emails=[...new Set(String(form.get('additional_recipient_emails')||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean))];
  if(emails.some(e=>!/^[^\s@<>]+@[^\s@<>]+$/.test(e)||!e.endsWith('@'+old.data.config.email_domain)))throw new Error('Use company email addresses only.');
  const result=await db.from('portal_notification_controls').update({...update,config:{...update.config,additional_recipient_emails:emails},updated_by:auth.userId,updated_at:new Date().toISOString()}).eq('company_id',company).eq('portal','ops').eq('event_key','adhoc_usage_digest');
  if(result.error)throw new Error('Settings could not be saved.');
 }catch(e){error=e instanceof Error?e.message:'Settings unavailable.';}
 revalidatePath('/settings/notifications');redirect('/settings/notifications?'+(error?'error='+encodeURIComponent(error):'saved=1')+'#adhoc-report');
}

export async function saveAmazonNowDigestSettings(event: NowDigestEvent, form: FormData) {
 const auth = await requirePagePermission('ops_notification_settings','edit'), company = requireCompanyId(auth), db = digestDatabase();
 let error = '';
 try {
  if (!nowDigestEvents.includes(event) || auth.isPreview || auth.readOnly) throw Error('Notification settings cannot be changed in this session.');
  const [old, base] = await Promise.all([
   db.from('portal_notification_controls').select('*').eq('company_id',company).eq('portal','ops').eq('event_key',event).maybeSingle(),
   db.from('portal_notification_controls').select('config').eq('company_id',company).eq('portal','ops').eq('event_key','review_digest').single()
  ]);
  if (old.error || base.error) throw Error('Schedule configuration is unavailable.');
  const control = old.data || defaultNowControl(company,event,String(base.data.config.email_domain || ''));
  const update = validateDigestSettings(form,control.config);
  const next = {...control,...update,config:{...update.config,day_offset:0,delivery_ready:true}};
  if (next.state === 'enabled') {
   const date = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(new Date());
   const sample = await buildAmazonNowDigest(db,next,date);
   if (!sample.messages.length) throw Error('No eligible recipients or store rows. Preview the scope before enabling.');
  }
  const result = await db.from('portal_notification_controls').upsert({...next,updated_by:auth.userId,updated_at:new Date().toISOString()},{onConflict:'company_id,portal,event_key'});
  if (result.error) throw Error('Amazon Now schedule could not be saved.');
 } catch (e) { error = e instanceof Error ? e.message : 'Settings unavailable.'; }
 revalidatePath('/settings/notifications');
 redirect('/settings/notifications?'+(error?'error='+encodeURIComponent(error):'saved=1')+'#amazon-now');
}
