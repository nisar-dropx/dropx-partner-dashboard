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

export type ConnectLeaveNotificationEvent = "APPROVAL_REQUIRED" | "STEP_APPROVED" | "REQUEST_APPROVED" | "REQUEST_REJECTED";

export async function firstPendingConnectLeaveStep(companyId: string, requestId: string) {
  const result = await db().from("hr_leave_approval_steps").select("id")
    .eq("company_id", companyId).eq("request_id", requestId).eq("status", "pending")
    .order("step_order").limit(1).maybeSingle();
  if (result.error) throw new Error(result.error.message);
  return result.data?.id ?? null;
}

export async function notifyConnectLeaveWorkflow(input: { companyId: string; requestId: string; event: ConnectLeaveNotificationEvent; approvalStepId?: string | null }) {
  const database = db();
  const [templateResult, requestResult, stepsResult] = await Promise.all([
    database.from("hr_leave_notification_templates").select("subject_template,body_template,is_enabled").eq("company_id", input.companyId).eq("event_code", input.event).maybeSingle(),
    database.from("hr_leave_requests").select("id,start_date,end_date,days,reason,reviewer_note,requested_by,reviewed_by,employees(full_name,employee_code,email),contractors(full_name,dropx_id,email),hr_leave_types(name,code)").eq("company_id", input.companyId).eq("id", input.requestId).maybeSingle(),
    database.from("hr_leave_approval_steps").select("id,step_order,step_name,status,approver_user_id").eq("company_id", input.companyId).eq("request_id", input.requestId).order("step_order")
  ]);
  if (templateResult.error || requestResult.error || stepsResult.error) throw new Error(templateResult.error?.message ?? requestResult.error?.message ?? stepsResult.error?.message ?? "Leave notification could not be loaded.");
  const template = templateResult.data;
  const request = requestResult.data;
  if (!template?.is_enabled || !request) return { status: "skipped" as const };
  const steps = stepsResult.data ?? [];
  const eventStep = input.approvalStepId ? steps.find((step) => step.id === input.approvalStepId) : null;
  const nextStep = steps.find((step) => step.status === "pending") ?? null;
  const currentStep = eventStep ?? (input.event === "APPROVAL_REQUIRED" ? nextStep : [...steps].reverse().find((step) => ["approved", "rejected"].includes(step.status)) ?? null);
  const profileIds = emails([currentStep?.approver_user_id, nextStep?.approver_user_id, request.reviewed_by, request.requested_by]);
  const profilesResult = profileIds.length ? await database.from("profiles").select("id,full_name,email").eq("company_id", input.companyId).in("id", profileIds) : { data: [], error: null };
  if (profilesResult.error) throw new Error(profilesResult.error.message);
  const profiles = profilesResult.data ?? [];
  const profileFor = (id: string | null | undefined) => profiles.find((profile) => profile.id === id) ?? null;
  const employee = one(request.employees);
  const contractor = one(request.contractors);
  const leaveType = one(request.hr_leave_types);
  const requesterEmails = emails([employee?.email, contractor?.email, profileFor(request.requested_by)?.email]);
  const approvalOwner = profileFor((input.event === "APPROVAL_REQUIRED" ? currentStep : nextStep)?.approver_user_id);
  const approver = profileFor(currentStep?.approver_user_id ?? request.reviewed_by);
  const to = input.event === "APPROVAL_REQUIRED" ? emails([approvalOwner?.email]) : requesterEmails;
  const values = {
    employee_name: employee?.full_name ?? contractor?.full_name ?? "Team member",
    worker_code: employee?.employee_code ?? contractor?.dropx_id ?? "",
    leave_name: leaveType?.name ?? "time off",
    leave_code: leaveType?.code ?? "",
    start_date: request.start_date,
    end_date: request.end_date,
    days: String(request.days),
    reason: request.reason,
    reviewer_note: request.reviewer_note ?? "No reviewer note",
    approver_name: approver?.full_name ?? "Your manager",
    next_approver_name: approvalOwner?.full_name ?? "the next manager",
    approval_url: `${process.env.ONE_APP_URL?.replace(/\/$/, "") || "https://one.dropxlogistics.com"}/approvals`
  };
  const subject = fill(template.subject_template, values);
  const body = fill(template.body_template, values);
  const notificationKey = `${input.event}:${input.approvalStepId ?? input.requestId}`;
  const claim = await database.from("hr_leave_notification_log").insert({ company_id: input.companyId, request_id: input.requestId, approval_step_id: input.approvalStepId ?? null, notification_key: notificationKey, event_code: input.event, to_emails: to, subject, status: "sending" }).select("id").single();
  if (claim.error?.code === "23505") return { status: "skipped" as const };
  if (claim.error) throw new Error(claim.error.message);
  let status: "sent" | "failed" | "skipped" = "sent";
  let errorMessage: string | null = null;
  try {
    if (!to.length) { status = "skipped"; errorMessage = input.event === "APPROVAL_REQUIRED" ? "The assigned manager has no active email address." : "The requester has no email address."; }
    else await sendConnectEmail({ companyId: input.companyId, to, subject, body });
  } catch (error) {
    status = "failed";
    errorMessage = error instanceof Error ? error.message : "Email delivery failed.";
  }
  await database.from("hr_leave_notification_log").update({ status, error_message: errorMessage, sent_at: status === "sent" ? new Date().toISOString() : null, updated_at: new Date().toISOString() }).eq("id", claim.data.id);
  return { status, error: errorMessage };
}
