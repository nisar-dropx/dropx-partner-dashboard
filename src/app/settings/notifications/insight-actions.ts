'use server';
import {requirePagePermission} from '@/lib/authorization';
import {requireCompanyId} from '@/lib/company-scope';
import {digestDatabase} from '@/lib/portal-digest-delivery';
import {defaultInsightControl,insightEvents,loadInsightScope} from '@/lib/ops-pulse/insight-digest';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
export async function saveInsightSettings(form:FormData){
 const auth=await requirePagePermission('ops_notification_settings','edit');let error='';
 try{
  if(auth.isPreview||auth.readOnly)throw Error('Settings cannot be changed in this session.');
  const state=String(form.get('state')),morning=String(form.get('morning')),evening=String(form.get('evening')),editorial=String(form.get('editorial')||'').trim(),accent=String(form.get('accent')||'');
  const validTime=(s:string)=>/^([01]\d|2[0-3]):[0-5]\d$/.test(s);
  if(!['enabled','disabled'].includes(state)||!validTime(morning)||!validTime(evening)||morning>=evening)throw Error('Choose valid morning and evening schedules.');
  const minute=(s:string)=>Number(s.slice(0,2))*60+Number(s.slice(3));
  if(minute(evening)-minute(morning)<=90)throw Error('Keep editions more than 90 minutes apart so their delivery windows do not overlap.');
  if(editorial.length>600||!/^#[0-9a-f]{6}$/i.test(accent))throw Error('Use a valid colour and an editorial brief below 600 characters.');
  const topics=['health','activities','attendance'].filter(t=>form.get(t)==='on');if(!topics.length)throw Error('Choose at least one insight topic.');
  if(state==='enabled'&&!process.env.OPENAI_API_KEY&&!process.env.GEMINI_API_KEY)throw Error('Configure the OpsPulse AI provider first.');
  const company=requireCompanyId(auth),db=digestDatabase();
  const base=await db.from('portal_notification_controls').select('config').eq('company_id',company).eq('portal','ops').eq('event_key','now_review_digest').single();if(base.error||!base.data.config.email_domain)throw Error('Configure existing Dark Store reports first.');
  const rows=insightEvents.map(event=>({...defaultInsightControl(company,event),state,config:{...defaultInsightControl(company,event).config,email_domain:base.data.config.email_domain,schedule_time:event==='now_insight_morning'?morning:evening,editorial_brief:editorial,accent,character_enabled:form.get('character')==='on',topics,delivery_ready:true},updated_by:auth.userId,updated_at:new Date().toISOString()}));
  const scope=await loadInsightScope(db,rows[0]);if(state==='enabled'&&!scope.recipients.length)throw Error('No eligible existing report recipients.');
  const result=await db.from('portal_notification_controls').upsert(rows,{onConflict:'company_id,portal,event_key'});if(result.error)throw Error('Insight settings could not be saved.');
 }catch(e){error=e instanceof Error?e.message:'Settings unavailable.';}
 revalidatePath('/settings/notifications');redirect('/settings/notifications?'+(error?'error='+encodeURIComponent(error):'saved=1')+'#store-insights');
}
