import { sendConnectEmail } from "./connect-email";
import { supabaseAdmin } from "./supabase-admin";

function db() { if (!supabaseAdmin) throw new Error("Database is unavailable."); return supabaseAdmin; }
function one<T>(value: T | T[] | null | undefined): T | null { return Array.isArray(value) ? value[0] ?? null : value ?? null; }
function fill(template: string, values: Record<string,string>) { return template.replace(/{{\s*([a-z0-9_]+)\s*}}/gi,(_,key:string)=>values[key]??""); }
function emails(values:Array<string|null|undefined>){return [...new Set(values.map((value)=>String(value??"").trim().toLowerCase()).filter(Boolean))];}

export async function notifyConnectLeaveSubmitted(input:{companyId:string;requestId:string}) {
  const database=db();
  const [templateResult,requestResult,stepResult]=await Promise.all([
    database.from("hr_leave_notification_templates").select("subject_template,body_template,is_enabled").eq("company_id",input.companyId).eq("event_code","APPROVAL_REQUIRED").maybeSingle(),
    database.from("hr_leave_requests").select("id,start_date,end_date,days,reason,employees(full_name,employee_code,email),contractors(full_name,dropx_id,email),hr_leave_types(name,code)").eq("company_id",input.companyId).eq("id",input.requestId).maybeSingle(),
    database.from("hr_leave_approval_steps").select("id,step_name,approver_user_id").eq("company_id",input.companyId).eq("request_id",input.requestId).eq("status","pending").order("step_order").limit(1).maybeSingle()
  ]);
  if(templateResult.error||requestResult.error||stepResult.error)throw new Error(templateResult.error?.message??requestResult.error?.message??stepResult.error?.message??"Leave notification could not be loaded.");
  const template=templateResult.data;const request=requestResult.data;const step=stepResult.data;
  if(!template?.is_enabled||!request||!step)return {status:"skipped" as const};
  const profile=await database.from("profiles").select("full_name,email").eq("company_id",input.companyId).eq("id",step.approver_user_id).eq("is_active",true).maybeSingle();
  if(profile.error)throw new Error(profile.error.message);
  const employee=one(request.employees);const contractor=one(request.contractors);const leaveType=one(request.hr_leave_types);
  const to=emails([profile.data?.email]);
  const values={employee_name:employee?.full_name??contractor?.full_name??"Team member",worker_code:employee?.employee_code??contractor?.dropx_id??"",leave_name:leaveType?.name??"time off",leave_code:leaveType?.code??"",start_date:request.start_date,end_date:request.end_date,days:String(request.days),reason:request.reason,approver_name:profile.data?.full_name??"Manager",next_approver_name:"",reviewer_note:"",approval_url:`${process.env.PEOPLE_APP_URL?.replace(/\/$/,"")||"https://people.dropxlogistics.com"}/approvals`};
  const subject=fill(template.subject_template,values);const body=fill(template.body_template,values);
  const key=`APPROVAL_REQUIRED:${step.id}`;
  const claim=await database.from("hr_leave_notification_log").insert({company_id:input.companyId,request_id:input.requestId,approval_step_id:step.id,notification_key:key,event_code:"APPROVAL_REQUIRED",to_emails:to,subject,status:"sending"}).select("id").single();
  if(claim.error?.code==="23505")return {status:"skipped" as const};
  if(claim.error)throw new Error(claim.error.message);
  let status:"sent"|"failed"|"skipped"="sent";let errorMessage:string|null=null;
  try{if(!to.length){status="skipped";errorMessage="The assigned manager has no active email address.";}else await sendConnectEmail({companyId:input.companyId,to,subject,body});}
  catch(error){status="failed";errorMessage=error instanceof Error?error.message:"Email delivery failed.";}
  await database.from("hr_leave_notification_log").update({status,error_message:errorMessage,sent_at:status==="sent"?new Date().toISOString():null,updated_at:new Date().toISOString()}).eq("id",claim.data.id);
  return {status,error:errorMessage};
}
