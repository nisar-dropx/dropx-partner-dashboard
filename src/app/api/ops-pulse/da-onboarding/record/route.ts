import {NextResponse} from 'next/server';
import {onboardingContext,OnboardingError} from '@/lib/da-onboarding-context';
import {isDADesignation} from '@/lib/da-onboarding-policy';
import {registrationRow} from '@/lib/registration-pendency';
import {deskUuid} from '@/lib/amazon-da-desk-policy';
export const dynamic='force-dynamic';
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'private, no-store'}});
export async function GET(request:Request){try{
 const q=new URL(request.url).searchParams,ctx=await onboardingContext(request,q.get('station')||'');
 const {db,companyId,station}=ctx,id=q.get('id')||'',guided=q.get('kind')==='managed';
 if(!deskUuid.test(id))throw new OnboardingError('Select an associate.');
 const result=guided?await db.from('workforce_amazon_email_pilot_candidates').select('id,designation_id,full_name,mobile,alias_email,biometric_id,reported_on,status,inbox_status,closed_at').eq('company_id',companyId).eq('station_id',station.id).eq('id',id).maybeSingle():await db.from('workforce').select('*').eq('company_id',companyId).eq('location_id',station.id).eq('id',id).is('deleted_at',null).maybeSingle();
 if(result.error)throw new OnboardingError('Registration is unavailable.',503);
 const person=result.data;if(!person)throw new OnboardingError('Associate outside your access.',404);
 const designation=await db.from('designations').select('name,code,profile_field_rules').eq('company_id',companyId).eq('id',person.designation_id).maybeSingle();
 if(designation.error||!isDADesignation(designation.data?.code))throw new OnboardingError('This record is not a DA onboarding designation.',403);
 const [category,registration,draft]=await Promise.all([
  db.from('workforce_categories').select('profile_field_rules').eq('company_id',companyId).eq('code','workforce').eq('is_active',true).maybeSingle(),
  guided?db.from('workforce_amazon_email_pilot_registrations').select('status,draft_data,file_paths,submitted_at,confirmed_at,return_note,updated_at').eq('company_id',companyId).eq('candidate_id',id).maybeSingle():Promise.resolve({data:null,error:null}),
  !guided?db.from('mob_app_registration_drafts').select('draft_data,file_paths,updated_at').eq('company_id',companyId).eq('account_id',id).in('profile_type',['workforce','field_executive']).order('updated_at',{ascending:false}).limit(1).maybeSingle():Promise.resolve({data:null,error:null})
 ]);
 if(category.error||!category.data||registration.error||draft.error)throw new OnboardingError('Registration details could not be checked. Please retry.',503);
 const reg=registration.data,rawStatus=guided?reg?.status||'pending':person.onboarding_status;
 const status=rawStatus==='confirmed'?'active':rawStatus==='submitted'?'under_review':rawStatus==='draft'?'pending':rawStatus;
 const profile=guided?{...reg?.draft_data,id,full_name:person.full_name,onboarding_status:status,lifecycle_status:person.closed_at?'offboarded':'onboarding',created_at:person.reported_on}:person;
 const progress=registrationRow({profile,profileType:'workforce',designation:designation.data!,categoryRules:category.data.profile_field_rules,station:{id:station.id,station_code:station.station_code||'',station_name:null},draft:guided?reg:draft.data,date:new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'})});
 let messages:unknown[]=[],invitation:unknown=null,more=false;
 if(guided){
  const offset=Math.max(0,Math.min(10000,Number(q.get('offset'))||0));
  const [mail,invite]=await Promise.all([
   db.from('workforce_amazon_email_pilot_messages').select('id,sender,subject,preview,action_url,received_at').eq('company_id',companyId).eq('candidate_id',id).order('received_at',{ascending:false}).order('id').range(offset,offset+20),
   db.from('workforce_amazon_invitation_requests').select('status,requested_at,completed_at,error_message').eq('company_id',companyId).eq('email_pilot_candidate_id',id).order('requested_at',{ascending:false}).limit(1).maybeSingle()
  ]);
  if(mail.error||invite.error)throw new OnboardingError('Mailbox or invitation status unavailable. Please retry.',503);
  messages=(mail.data||[]).slice(0,20);more=(mail.data?.length||0)>20;invitation=invite.data;
 }
 return reply({status:rawStatus,progress:progress?{status:progress.status,action:progress.action,missing:progress.missing,requiredFilled:progress.requiredFilled,requiredTotal:progress.requiredTotal}:null,returnNote:reg?.return_note||null,email:guided?person.alias_email:null,biometricId:guided?person.biometric_id:null,inboxStatus:guided?person.inbox_status:null,closed:!!person.closed_at,invitation,messages,more});
 }catch(e){return reply({error:e instanceof OnboardingError?e.message:'Could not load the associate record.'},e instanceof OnboardingError?e.status:503);}}
