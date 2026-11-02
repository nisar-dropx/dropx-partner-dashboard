import {supabaseAdmin} from "@/lib/supabase-admin";
import {sendEmail} from "@/lib/email";
import {deliverInitialAdvanceMail,type AdvanceMailThread} from "./advance-approval-mail-delivery";

export async function sendInitialAdvanceApproval(companyId:string,requestId:string) {
 if(!supabaseAdmin)throw Error("Notification database is unavailable");
 const db=supabaseAdmin;
 const claimed=await db.rpc("hr_claim_initial_advance_email",{p_company:companyId,p_request:requestId});
 if(claimed.error)throw Error(claimed.error.message);
 const sent:string[]=[];
 for(const thread of (claimed.data??[]) as AdvanceMailThread[]) {
  const delivered=await deliverInitialAdvanceMail(thread,{
   async current(){
    const [source,lease,settings,smtp]=await Promise.all([
     db.from("hr_pending_manager_approval_emails").select("request_id").eq("company_id",companyId).eq("workflow","pay_advance")
      .eq("request_id",requestId).eq("step_key",thread.step_key).eq("approver_user_id",thread.recipient_user_id).eq("recipient_email",thread.recipient_email).eq("recipient_active",true).maybeSingle(),
     db.from("hr_approval_email_threads").select("id").eq("id",thread.id).eq("lease_token",thread.lease_token).eq("status","active").gt("lease_until",new Date().toISOString()).maybeSingle(),
     db.from("hr_approval_email_settings").select("is_enabled,workflows").eq("company_id",companyId).single(),
     db.from("email_notification_settings").select("is_enabled").eq("company_id",companyId).single()
    ]);
    const error=source.error||lease.error||settings.error||smtp.error;if(error)throw Error(error.message);
    return Boolean(source.data&&lease.data&&settings.data.is_enabled&&settings.data.workflows.includes("pay_advance")&&smtp.data.is_enabled);
   },
   async prepare(subject){
    const result=await db.from("hr_approval_email_threads").update({subject}).eq("id",thread.id).eq("lease_token",thread.lease_token).eq("status","active").select("id").maybeSingle();
    if(result.error||!result.data)throw Error(result.error?.message||"Approval lease changed before delivery");
   },
   send:message=>sendEmail({...message,companyId,to:[thread.recipient_email],timeoutMs:12000}),
   async finish(result){
    const saved=await db.rpc("hr_finish_approval_email",{p_thread_id:thread.id,p_lease_token:thread.lease_token,p_status:result.status,p_message_id:result.messageId,p_subject:result.subject,p_smtp_response:result.response??null,p_error:result.error??null});
    if(saved.error||saved.data!==true)throw Error(saved.error?.message||"Approval email receipt could not be saved");
   }
  });
  if(delivered)sent.push(thread.recipient_email);
 }
 return sent;
}
