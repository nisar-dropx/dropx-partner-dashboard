export type AdvanceMailThread = {
 id:string;company_id:string;request_id:string;step_key:string;recipient_user_id:string;
 recipient_email:string;request_label:string;request_summary:string;subject:string|null;
 root_message_id:string|null;last_message_id:string|null;send_count:number;lease_token:string;
};
export type AdvanceMailOutcome = {status:"sent"|"failed"|"skipped";messageId:string;subject:string;response?:string;error?:string};
export async function deliverInitialAdvanceMail(thread:AdvanceMailThread,deps:{
 current:()=>Promise<boolean>;prepare:(subject:string)=>Promise<void>;
 send:(message:{subject:string;body:string;messageId:string;inReplyTo?:string;references?:string[]})=>Promise<{messageId:string;response:string;accepted:unknown[]}>;
 finish:(outcome:AdvanceMailOutcome)=>Promise<void>;
}) {
 const subject=thread.subject??`Approval required: Pay advance — ${thread.request_label}`.replace(/[\r\n]+/g," ");
 const messageId=`<dropx.approval.${thread.id}.${thread.send_count+1}@people.dropxlogistics.com>`;
 if(!await deps.current()) {await deps.finish({status:"skipped",messageId,subject,error:"Approval assignment changed or notifications disabled."});return false;}
 await deps.prepare(subject);
 let receipt;
 try {
  receipt=await deps.send({subject,messageId,body:["This advance request is waiting for your review.",thread.request_label,thread.request_summary,
   "Review the amount and recovery terms, then Approve, Return or Reject in DropX One:","https://one.dropxlogistics.com/approvals?section=pay-advances",
   "Further reminders remain in this email conversation. Replying to this email does not record a decision."].join("\n\n"),
   inReplyTo:thread.last_message_id??undefined,references:[...new Set([thread.root_message_id,thread.last_message_id].filter((id):id is string=>Boolean(id)))]});
  if(!receipt.accepted.some(address=>typeof address==="string"&&address.toLowerCase()===thread.recipient_email.toLowerCase()))throw Error("SMTP did not accept the assigned approver");
 }catch(error){await deps.finish({status:"failed",messageId,subject,error:error instanceof Error?error.message:"SMTP failed"});return false;}
 // A failed receipt write after SMTP acceptance must retain the lease, not
 // create a second failed attempt or immediately send the message again.
 await deps.finish({status:"sent",messageId:receipt.messageId,subject,response:receipt.response});
 return true;
}
