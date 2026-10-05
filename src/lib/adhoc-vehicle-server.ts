import 'server-only';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { resolveStepApprover, type ApprovalStepRow } from '@/lib/payment-approval-steps';
import { dateKey } from '@/lib/payment-volume';
import { eligibleAdhocVehicles, requiredAdhocStatuses, type AdhocContext, type AdhocRule } from '@/lib/adhoc-vehicle-policy';

export async function loadAdhocContext(company: string, station: string, date: string): Promise<AdhocContext> {
 const db=supabaseAdmin!;
 const [rules,vehicles,sources,designations,states,days]=await Promise.all([
  db.from('fleet_adhoc_reason_rules').select('*').eq('company_id',company).eq('is_active',true).order('sort_order'),
  db.from('fleet_vehicles').select('id,vehicle_no,model,da_name,vendor_name,source_id,status,deployment_date').eq('company_id',company).eq('station_code',station).eq('deployment_status','deployed'),
  db.from('fleet_vehicle_sources').select('id,designation_id').eq('company_id',company).eq('is_active',true),
  db.from('designations').select('id,code').eq('company_id',company),
  db.from('fleet_vehicle_status_master').select('status_key').eq('company_id',company).eq('is_terminal',true),
  db.from('fleet_vehicle_day_availability').select('vehicle_id').eq('company_id',company).eq('work_date',date).is('revoked_at',null)
 ]);
 if ([rules,vehicles,sources,designations,states,days].some(r=>r.error)) throw new Error('Vehicle checks unavailable. Please retry.');
 const sourceCodes=new Map((sources.data??[]).map(s=>[s.id,s.designation_id ? designations.data?.find(d=>d.id===s.designation_id)?.code : 'OWN']));
 const terminal=new Set(states.data?.map(s=>s.status_key));
 const active=(vehicles.data??[]).filter(v=>!terminal.has(v.status)&&v.deployment_date<=date).map(v=>({id:v.id,number:v.vehicle_no,model:v.model,partner:sourceCodes.get(v.source_id)==='OWN'?'':v.da_name||v.vendor_name||'',source:sourceCodes.get(v.source_id)||'',status:v.status,deploymentDate:v.deployment_date,unavailable:Boolean(days.data?.some(d=>d.vehicle_id===v.id))}));
 const availableRules=(rules.data as AdhocRule[]).filter(r=>!r.source_code||active.some(v=>v.source===r.source_code));
 const contactRule=(rules.data as AdhocRule[]).find(r=>r.contact_role_code);
 let contact: string|null=null;
 if(contactRule?.contact_role_code){
  const role=await db.from('user_roles').select('id').eq('company_id',company).eq('code',contactRule.contact_role_code).maybeSingle();
  if(role.data){const approver=await resolveStepApprover(company,{id:'contact',step_order:1,is_required:true,candidates:[{role_id:role.data.id,scope:'company'}]},null);
   if(approver){const p=await db.from('profiles').select('full_name,mobile,phone').eq('company_id',company).eq('id',approver.userId).maybeSingle();if(p.data)contact=[p.data.full_name,p.data.mobile||p.data.phone].filter(Boolean).join(' · ');}
  }
 }
 return {rules:availableRules,vehicles:active,contact};
}
export async function prepareAdhocRequest(company:string, head:string, station:string, form:FormData, questions:Array<{id:string;question_text:string}>): Promise<{fields:Record<string,unknown>;steps:ApprovalStepRow[]|null}> {
 if(head!=='VAN_ADHOC')return {fields:{},steps:null};
 const reasonQuestion=questions.find(q=>/reason.*(?:adhoc|ad hoc).*deployment/i.test(q.question_text));
 const dateQuestion=questions.find(q=>/^deployment date$/i.test(q.question_text.trim()));
 const label=String(form.get(`answers[${reasonQuestion?.id}]`)||'');
 const date=String(form.get(`answers[${dateQuestion?.id}]`)||'');
 if(!dateKey(date))throw new Error('Select the deployment date.');
 const context=await loadAdhocContext(company,station,date);
 const rule=context.rules.find(r=>r.label===label);
 if(!rule)throw new Error('Select an available deployment reason. Refresh the form if needed.');
 const vehicle=String(form.get('adhoc_vehicle_id')||'');
 if(rule.source_code&&!eligibleAdhocVehicles(rule,context.vehicles,date).some(v=>v.id===vehicle))throw new Error(requiredAdhocStatuses(rule).length ? `No eligible vehicle in the configured statuses. Contact Fleet Manager${context.contact?' · '+context.contact:''}.`:'Select an eligible vehicle at this station.');
 if(rule.reason_key==='company_breakdown'&&!rule.approval_steps)throw new Error('Fleet approval routing is not configured. Contact the administrator.');
 return {fields:{adhoc_reason_key:rule.reason_key,adhoc_vehicle_id:rule.source_code?vehicle:null,adhoc_deployment_date:date,adhoc_approval_steps:rule.approval_steps},steps:rule.approval_steps as ApprovalStepRow[]|null};
}

export async function validateAdhocResubmission(company:string,requestId:string,form:FormData){
 const db=supabaseAdmin!;
 const request=await db.from('payment_requests').select('adhoc_reason_key,adhoc_deployment_date').eq('company_id',company).eq('id',requestId).single();
 if(request.error)throw new Error('Unable to verify replacement details.');
 if(!request.data.adhoc_reason_key)return;
 const answers=await db.from('payment_request_answers').select('question_id,answer_value,payment_head_questions(question_text)').eq('company_id',company).eq('payment_request_id',requestId);
 if(answers.error)throw new Error('Unable to verify replacement details.');
 for(const answer of answers.data??[]){const q=Array.isArray(answer.payment_head_questions)?answer.payment_head_questions[0]:answer.payment_head_questions;
 if(/reason.*(?:adhoc|ad hoc).*deployment|^deployment date$/i.test(q?.question_text??'')&&form.has(`answers[${answer.question_id}]`)&&String(form.get(`answers[${answer.question_id}]`))!==answer.answer_value)throw new Error('The vehicle replacement reason and date are fixed. Cancel and raise a corrected request to change them.');}
}
