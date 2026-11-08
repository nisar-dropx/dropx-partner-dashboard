import {NextResponse} from 'next/server';
import {waitUntil} from '@vercel/functions';
import {onboardingContext,onboardingRoles,OnboardingError} from '@/lib/da-onboarding-context';
import {generateConfiguredBiometricId} from '@/lib/dropx-id-generation';
import {evaluateOnboardingIdentity} from '@/lib/onboarding-identity';
import {callWorkforceAmazonWorker,workforceAmazonWorkerConfig} from '@/lib/workforce-amazon-worker';
import {deskUuid} from '@/lib/amazon-da-desk-policy';
export const dynamic='force-dynamic';
export const maxDuration=60;
const reply=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{'Cache-Control':'private, no-store'}});
function routingDomain(){
 const domain=(process.env.RESEND_INBOUND_DOMAIN||'').trim().toLowerCase();
 if(process.env.AMAZON_EMAIL_ROUTING_PROVIDER!=='resend'||!domain)throw new OnboardingError('The managed inbox is not configured. Contact your administrator.',503);
 if(!workforceAmazonWorkerConfig().configured)throw new OnboardingError('Amazon invitation service is not connected.',503);
 return domain;
}
export async function GET(request:Request){try{
 const ctx=await onboardingContext(request,new URL(request.url).searchParams.get('station')||'','add');
 const roles=await onboardingRoles(ctx,request);
 const settings=await ctx.db.from('workforce_amazon_station_settings').select('invitation_enabled,associate_email_pattern').eq('company_id',ctx.companyId).eq('station_id',ctx.station.id).maybeSingle();
 if(settings.error)throw new OnboardingError('Station configuration unavailable.',503);
 let warning='';try{const domain=routingDomain();if(!settings.data?.invitation_enabled||settings.data.associate_email_pattern?.split('@')[1]?.toLowerCase()!==domain)warning='Invitations are not configured for this station. Ask an administrator to enable its managed email.';}catch(e){warning=(e as Error).message;}
 return reply({roles:roles.map(({id,code,name})=>({id,code,name})),warning});
 }catch(e){return reply({error:(e as Error).message},e instanceof OnboardingError?e.status:503);}}
export async function POST(request:Request){try{
 const b=await request.json();
 const ctx=await onboardingContext(request,String(b.stationId||''),b.operation==='retry'?'edit':'add');
 const {db,auth,companyId,station,scope}=ctx;
 const id=String(b.id||'');if(!deskUuid.test(id))throw new OnboardingError('Reload the invitation form.');
 const domain=routingDomain();
 const existing=await db.from('workforce_amazon_email_pilot_candidates').select('id,full_name,mobile,designation_id,reported_on,alias_email,inbox_status,routing_rule_id,created_by,closed_at').eq('company_id',companyId).eq('station_id',station.id).eq('id',id).maybeSingle();
 if(existing.error)throw new OnboardingError('Unable to check this invitation.',503);
 let candidate=existing.data;
 if(b.operation==='retry'){
  if(!candidate||candidate.closed_at)throw new OnboardingError('This invitation is unavailable.',404);
 }else{
  const name=String(b.name||'').trim().replace(/\s+/g,' '),mobile=String(b.mobile||'').trim(),reported=String(b.reportedOn||'');
  const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'}),age=(Date.parse(today)-Date.parse(reported))/86400000;
  if(name.length<2||name.length>120||!/^\d{10}$/.test(mobile)||!/^\d{4}-\d{2}-\d{2}$/.test(reported)||!Number.isFinite(age)||age<0||age>7)throw new OnboardingError('Enter a name, 10-digit mobile and reporting date within the last seven days.');
  const role=(await onboardingRoles(ctx,request)).find(r=>r.id===b.designationId);
  if(!role)throw new OnboardingError('Select an allowed DA, PTDA, DCD or ODCD designation.',403);
  if(candidate){
   if(candidate.created_by!==auth.userId||candidate.full_name!==name||candidate.mobile!==mobile||candidate.designation_id!==role.id||candidate.reported_on!==reported||candidate.closed_at)throw new OnboardingError('This request already belongs to another invitation. Reload the form.',409);
  }else{
   const settings=await db.from('workforce_amazon_station_settings').select('invitation_enabled,associate_email_pattern').eq('company_id',companyId).eq('station_id',station.id).maybeSingle();
   if(settings.error||!settings.data?.invitation_enabled||settings.data.associate_email_pattern?.split('@')[1]?.toLowerCase()!==domain)throw new OnboardingError('Configure the station’s managed email before inviting an associate.');
   const identity=await evaluateOnboardingIdentity({client:db,companyId,mobile,designationId:role.id,designationName:role.name});
   if((identity.exactMatches.length||identity.otherMatches.length)&&b.identityConfirmed!==true)return reply({needsIdentityConfirmation:true,message:'This mobile already appears on an existing profile. Review it for rejoining before creating another associate.',matches:[...identity.exactMatches,...identity.otherMatches].map(m=>({name:m.display_name,designation:m.designation_name,status:m.profile_status}))},409);
   // A stable request UUID makes network retries resume the same invitation.
   const biometric=await generateConfiguredBiometricId({companyId,category:'workforce',designationId:role.id,designationName:role.name,locationId:station.id,fallback:()=>{throw new OnboardingError('Configure the designation’s biometric ID series before inviting.');}});
   const saved=await db.rpc('workforce_create_isolated_amazon_email_pilot',{p_company:companyId,p_actor:auth.userId,p_locations:scope,p_data:{id,full_name:name,mobile,station_id:station.id,designation_id:role.id,reported_on:reported,biometric_id:biometric}});
   if(saved.error&&saved.error.code!=='23505')throw new OnboardingError('The invitation could not be saved. Check the station and ID-series setup, then retry.',503);
   const loaded=await db.from('workforce_amazon_email_pilot_candidates').select('id,full_name,mobile,designation_id,reported_on,alias_email,inbox_status,routing_rule_id,created_by,closed_at').eq('company_id',companyId).eq('station_id',station.id).eq('id',id).maybeSingle();
   if(loaded.error||!loaded.data||loaded.data.created_by!==auth.userId||loaded.data.mobile!==mobile||loaded.data.full_name!==name||loaded.data.designation_id!==role.id||loaded.data.reported_on!==reported)throw new OnboardingError('Unable to confirm the saved invitation. Refresh before retrying.',503);
   candidate=loaded.data;
  }
 }
 try{
  if(!candidate.alias_email.toLowerCase().endsWith('@'+domain))throw new Error('Managed email domain mismatch');
  if(!['routed','receiving'].includes(candidate.inbox_status)){
   const routed=await db.from('workforce_amazon_email_pilot_candidates').update({inbox_status:'routed',routing_rule_id:'resend:'+domain,routing_error:null,routed_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('company_id',companyId).eq('station_id',station.id).eq('id',id);
   if(routed.error)throw Error('Inbox setup failed');
  }
  const queue=await db.rpc('workforce_queue_isolated_amazon_email_pilot',{p_company:companyId,p_actor:auth.userId,p_candidate:id,p_locations:scope});
  if(queue.error)throw Error('Invitation queue unavailable');
  waitUntil(callWorkforceAmazonWorker('/api/admin/amazon/invitation/tick',{method:'POST',body:'{}'}).catch(()=>undefined));
  return reply({id,email:candidate.alias_email,message:'Associate saved. Amazon invitation queued; follow progress here.'});
 }catch{return reply({id,email:candidate.alias_email,saved:true,warning:'Associate saved; invitation delivery is not confirmed. Open the record and retry the invitation.'},202);}
 }catch(e){return reply({error:e instanceof OnboardingError?e.message:'Unable to invite the associate. Retry with the same form.'},e instanceof OnboardingError?e.status:503);}}
