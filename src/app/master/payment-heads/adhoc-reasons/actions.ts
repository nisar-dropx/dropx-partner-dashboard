"use server";
import {roleIdsWithPageEditAccess} from "@/lib/position-access";
import {requirePagePermission} from '@/lib/authorization';
import {requireCompanyId} from '@/lib/company-scope';
import {supabaseAdmin} from '@/lib/supabase-admin';
import {revalidatePath} from 'next/cache';
import {redirect} from 'next/navigation';
export async function saveAdhocReason(form:FormData){
 const auth=await requirePagePermission('master_payment_heads','edit'),company=requireCompanyId(auth),db=supabaseAdmin!;
 const key=String(form.get('reason_key')||''),label=String(form.get('label')||'').trim(),sort=Number(form.get('sort_order'));
 if(!/^[a-z][a-z0-9_]{1,60}$/.test(key)||!label||label.length>100||!Number.isInteger(sort)||sort<0)throw new Error('Enter a valid reason name and order.');
 const existing=await db.from('fleet_adhoc_reason_rules').select('*').eq('company_id',company).eq('reason_key',key).single();if(existing.error)throw new Error('Reason not found.');
 const source=String(form.get('source_code')||'')||null,statuses=[...new Set(form.getAll('required_statuses').map(String).filter(Boolean))],effect=String(form.get('effect_status')||'')||null;
 if(source&&source!=='OWN'){const code=await db.from('designations').select('id').eq('company_id',company).eq('code',source).maybeSingle();if(!code.data)throw new Error('Invalid source.');}
 for(const value of [...statuses,effect].filter(Boolean)){const check=await db.from('fleet_vehicle_status_master').select('id').eq('company_id',company).eq('status_key',value).maybeSingle();if(!check.data)throw new Error('Invalid vehicle status.');}
 let steps=null;
 if(form.get('special_route')==='on'){
  const roleIds=['first_role','final_role','fallback_role'].map(k=>String(form.get(k)||''));
  const roles=await db.from('user_roles').select('id').eq('company_id',company).in('id',roleIds);if(roles.error||roleIds.some(id=>!roles.data?.some(r=>r.id===id)))throw new Error('Select valid approval roles.');
  const allowed=await roleIdsWithPageEditAccess(company,roleIds,'payment_approvals');if(roleIds.some(id=>!allowed.has(id)))throw new Error('Approval roles must have Payment Approvals edit access.');
  steps=[{id:'first',step_order:1,is_required:true,candidates:[{role_id:roleIds[0],scope:'company'}]},{id:'final',step_order:2,is_required:true,candidates:[{role_id:roleIds[1],scope:'company'},{role_id:roleIds[2],scope:'company'}]}];
 }
 const result=await db.from('fleet_adhoc_reason_rules').update({label,source_code:source,required_status:statuses[0]||null,required_statuses:statuses,effect_status:effect,block_rent:!!effect&&form.get('block_rent')==='on',sort_order:sort,is_active:form.get('is_active')==='on',approval_steps:steps}).eq('company_id',company).eq('reason_key',key);
 if(result.error)throw new Error(result.error.message);
 const rules=await db.from('fleet_adhoc_reason_rules').select('label').eq('company_id',company).eq('is_active',true).order('sort_order');
 const head=await db.from('payment_heads').select('id').eq('company_id',company).eq('code','VAN_ADHOC').single();
 if(rules.error||head.error)throw new Error('Saved rule, but dropdown refresh failed. Please save again.');
 const questions=await db.from('payment_head_questions').select('id,question_text').eq('payment_head_id',head.data.id);
 if(questions.error)throw new Error('Saved rule, but dropdown refresh failed. Please save again.');
 for(const q of questions.data??[])if(/reason.*(?:adhoc|ad hoc).*deployment/i.test(q.question_text)){const update=await db.from('payment_head_questions').update({dropdown_options:rules.data.map(r=>r.label).join(', ')}).eq('id',q.id).eq('payment_head_id',head.data.id);if(update.error)throw new Error('Saved rule, but dropdown refresh failed. Please save again.');}
 revalidatePath('/master/payment-heads/adhoc-reasons');redirect('/master/payment-heads/adhoc-reasons?saved=1');
}
