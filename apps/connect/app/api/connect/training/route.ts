import { requireConnectAccount,type ConnectAccount } from '../../../../src/lib/connect-auth';
import { supabaseAdmin } from '../../../../src/lib/supabase-admin';
import { isPeopleTrainingAccount,publicTrainingQuestions } from '../../../../src/lib/connect-training-policy';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
function db(){if(!supabaseAdmin)throw new Error('Training is temporarily unavailable.');return supabaseAdmin;}
async function context(url:URL,body?:Record<string,unknown>){
 const profileType=String(body?.profileType??url.searchParams.get('profileType')??'');const accountId=String(body?.accountId??url.searchParams.get('accountId')??'');
 if(!['employee','contractor'].includes(profileType))throw new Error('Training is currently available for People profiles only.');
 const account=await requireConnectAccount(profileType as ConnectAccount['profileType'],accountId);
 if(!isPeopleTrainingAccount(account))throw new Error('Workforce training is not enabled.');
 return account;
}
async function ownMilestone(account:ConnectAccount,id:string){
 const milestone=await db().from('hr_training_milestones').select('id,enrolment_id,material_ids').eq('company_id',account.companyId).eq('id',id).maybeSingle();
 if(milestone.error||!milestone.data)throw new Error('Training milestone is unavailable.');
 const enrolment=await db().from('hr_training_enrolments').select('id,status').eq('company_id',account.companyId).eq('id',milestone.data.enrolment_id).eq('worker_type',account.profileType).eq('worker_id',account.id).maybeSingle();
 if(enrolment.error||!enrolment.data)throw new Error('This training is not assigned to your profile.');
 return {...milestone.data,enrolmentStatus:enrolment.data.status};
}
export async function GET(request:Request){try{
 const url=new URL(request.url);const account=await context(url);
 const materialId=url.searchParams.get('materialId');
 if(materialId){
  const milestone=await ownMilestone(account,url.searchParams.get('milestoneId')??'');
  if(!milestone.material_ids.includes(materialId))throw new Error('This material is not assigned to you.');
  const material=await db().from('hr_training_materials').select('storage_path,external_url').eq('company_id',account.companyId).eq('id',materialId).single();
  if(material.error)throw new Error('Material is unavailable.');
  let href=material.data.external_url;
  if(material.data.storage_path){const signed=await db().storage.from('people-training').createSignedUrl(material.data.storage_path,120);if(signed.error)throw new Error('Unable to open this PDF.');href=signed.data.signedUrl;}
  const target=new URL(href);if(target.protocol!=='https:')throw new Error('Invalid material link.');
  return new Response(null,{status:303,headers:{...headers,Location:target.toString()}});
 }
 const enrolments=await db().from('hr_training_enrolments').select('id,programme_name,starts_on,target_completion_on,status,completed_at').eq('company_id',account.companyId).eq('worker_type',account.profileType).eq('worker_id',account.id).order('created_at',{ascending:false}).limit(200);
 if(enrolments.error)throw new Error('Unable to load your training.');
 const ids=(enrolments.data??[]).map(e=>e.id);
 if(!ids.length)return Response.json({enrolments:[],milestones:[],materials:[],attempts:[],reviews:[]},{headers});
 const [milestones,attempts,reviews]=await Promise.all([
  db().from('hr_training_milestones').select('id,enrolment_id,title,description,milestone_kind,owner_type,required,due_on,status,scheduled_start,scheduled_end,meeting_mode,meeting_reference,trainer_name,completed_at,completion_rule,pass_percent,max_attempts,questions_snapshot,material_ids,effectiveness_rating,result,sort_order').eq('company_id',account.companyId).in('enrolment_id',ids).order('sort_order'),
  db().from('hr_training_assessment_attempts').select('id,milestone_id,attempt_number,percent,passed,assessed_at').eq('company_id',account.companyId).in('enrolment_id',ids).order('assessed_at',{ascending:false}),
  db().from('hr_training_probation_reviews').select('id,enrolment_id,due_on,status,overall_rating,recommendation,decision_note,reviewed_at').eq('company_id',account.companyId).in('enrolment_id',ids)
 ]);
 if(milestones.error||attempts.error||reviews.error)throw new Error('Unable to load your training details.');
 const materialIds=[...new Set((milestones.data??[]).flatMap(m=>m.material_ids as string[]))];
 const materials=materialIds.length?await db().from('hr_training_materials').select('id,title,kind').eq('company_id',account.companyId).in('id',materialIds):{data:[],error:null};
 if(materials.error)throw new Error('Unable to load materials.');
 return Response.json({enrolments:enrolments.data,milestones:(milestones.data??[]).map(({questions_snapshot,...m})=>({...m,questions:publicTrainingQuestions(questions_snapshot)})),materials:materials.data,attempts:attempts.data,reviews:reviews.data},{headers});
}catch(e){return Response.json({error:e instanceof Error?e.message:'Unable to load training.'},{status:403,headers});}}
export async function POST(request:Request){try{
 const origin=request.headers.get('origin');if(origin&&origin!==new URL(request.url).origin)return Response.json({error:'Invalid request origin.'},{status:403,headers});
 const body=await request.json();const account=await context(new URL(request.url),body);const milestone=await ownMilestone(account,String(body.milestoneId??''));
 if(milestone.enrolmentStatus==='cancelled')throw new Error('This assignment is closed.');
 if(body.action==='acknowledge'){
  const result=await db().rpc('hr_training_acknowledge',{p_company_id:account.companyId,p_milestone_id:milestone.id});if(result.error)throw new Error(result.error.message);
  return Response.json({notice:'Learning acknowledged.'},{headers});
 }
 if(body.action==='assessment'){
  if(!body.answers||typeof body.answers!=='object'||Array.isArray(body.answers)||JSON.stringify(body.answers).length>50000)throw new Error('Answer the test questions.');
  const result=await db().rpc('hr_training_record_assessment',{p_company_id:account.companyId,p_milestone_id:milestone.id,p_answers:body.answers});if(result.error)throw new Error(result.error.message);
  return Response.json({notice:`${result.data.percent}% · ${result.data.passed?'Passed':'Please review the material and retry if attempts remain.'}`},{headers});
 }
 throw new Error('Choose a valid training action.');
}catch(e){return Response.json({error:e instanceof Error?e.message:'Unable to update training.'},{status:400,headers});}}
