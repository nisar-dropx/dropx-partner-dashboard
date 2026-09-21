import {supabaseAdmin} from '@/lib/supabase-admin';
export async function processPayoutReviewNotifications(){
 const errors:string[]=[],db=supabaseAdmin;if(!db)return {sent:0,errors:['Database unavailable']};
 // Never automatically retry a request that may have reached Meta.
 await db.from('workforce_payout_publications').update({notification_status:'uncertain',notification_error:'Delivery outcome needs operator verification.'}).eq('notification_status','sending').lt('notification_attempted_at',new Date(Date.now()-10*60*1000).toISOString());
 const queue=await db.from('workforce_payout_publications').select('id,company_id,workforce_id,payroll_run_id,source_calculated_at,snapshot,review_until').eq('notification_status','pending').lte('notify_at',new Date().toISOString()).order('notify_at').limit(10);
 if(queue.error)return {sent:0,errors:['Payout notification queue unavailable']};
 let sent=0;
 for(const p of queue.data??[]){
  const claim=await db.from('workforce_payout_publications').update({notification_status:'sending',notification_attempted_at:new Date().toISOString()}).eq('id',p.id).eq('notification_status','pending').select('id').maybeSingle();
  if(claim.error||!claim.data)continue;
  let attempted=false;
  try{
   const run=await db.from('workforce_payroll_runs').select('status,calculated_at').eq('id',p.payroll_run_id).eq('company_id',p.company_id).single();
   if(run.error)throw new Error('Payout state unavailable.');
   if(run.data.status!=='review'||run.data.calculated_at!==p.source_calculated_at){await db.from('workforce_payout_publications').update({notification_status:'superseded'}).eq('id',p.id);continue;}
   if(new Date(p.review_until).getTime()<=Date.now())throw new Error('The review window has ended. Publish a revised review window before notifying.');
   const [settings,templates,person]=await Promise.all([
    db.from('whatsapp_settings').select('is_enabled').eq('company_id',p.company_id).maybeSingle(),
    db.from('whatsapp_template_cache').select('name,language,whatsapp_profile_id,components').eq('company_id',p.company_id).eq('name','payment_details_available').eq('status','APPROVED').order('language'),
    db.from('workforce').select('mobile,mobile_country_code,full_name').eq('company_id',p.company_id).eq('id',p.workforce_id).single()]);
   if(settings.error||!settings.data?.is_enabled||templates.error||person.error)throw new Error('WhatsApp or recipient configuration unavailable.');
   const template=templates.data?.find(t=>t.language==='en')??templates.data?.[0];
   if(!template)throw new Error('Approved payment_details_available template is required.');
   const [profile,token]=await Promise.all([db.from('whatsapp_profiles').select('phone_number_id,graph_api_version,is_active').eq('company_id',p.company_id).eq('id',template.whatsapp_profile_id).single(),db.rpc('get_whatsapp_profile_access_token',{profile_id:template.whatsapp_profile_id})]);
   if(profile.error||token.error||!profile.data?.is_active||!token.data)throw new Error('WhatsApp sending profile is not ready.');
   let recipient=String(person.data?.mobile||'').replace(/\D/g,'');if(recipient.length===10)recipient=String(person.data?.mobile_country_code||'91').replace(/\D/g,'')+recipient;
   if(!/^\d{11,15}$/.test(recipient))throw new Error('Associate mobile number is invalid.');
   const parameters=[person.data?.full_name||'Associate','Payout - review in DropX One > Payments > Payouts',p.snapshot.run.period_start+' to '+p.snapshot.run.period_end];
   attempted=true;
   const response=await fetch('https://graph.facebook.com/'+profile.data.graph_api_version+'/'+profile.data.phone_number_id+'/messages',{method:'POST',headers:{Authorization:'Bearer '+token.data,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to:recipient,type:'template',template:{name:template.name,language:{code:template.language},components:[{type:'body',parameters:parameters.map(text=>({type:'text',text}))}]}}),signal:AbortSignal.timeout(20000)});
   const result=await response.json();
   if(!response.ok){attempted=false;throw new Error('WhatsApp rejected this notification. Check the approved sending configuration.');}
   const reference=result.messages?.[0]?.id;if(!reference)throw new Error('WhatsApp did not return a message receipt.');
   const saved=await db.from('workforce_payout_publications').update({notification_status:'sent',notification_reference:reference,notification_error:null}).eq('id',p.id);
   if(saved.error)throw new Error('Message receipt could not be saved.');
   await db.from('whatsapp_message_logs').insert({company_id:p.company_id,event_code:'workforce_payout_review',recipient,template_name:template.name,status:'sent',provider_message_id:reference,request_payload:{publication_id:p.id}});
   sent++;
  }catch(e){
   const message=e instanceof Error?e.message:'Notification failed';
   await db.from('workforce_payout_publications').update({notification_status:attempted?'uncertain':'failed',notification_error:message}).eq('id',p.id).eq('notification_status','sending');
   errors.push('Payout notification '+p.id+': '+message);
  }
 }
 return {sent,errors};
}
