import "server-only";
import {createClient, type SupabaseClient} from "@supabase/supabase-js";
import {createHash, timingSafeEqual} from "node:crypto";
import nodemailer from "nodemailer";

export type DigestControl = {company_id:string;portal:"people"|"ops";event_key:string;state:string;paused_until:string|null;subject_template:string|null;config:Record<string,unknown>};
export type DigestMessage = {email:string;name:string;subject:string;html:string;text:string;scope:Record<string,unknown>};
type DigestDelivery = {id:string;company_id:string;event_key:string;report_date:string;recipient_email:string;subject:string;html:string;body:string};
export type DigestBuilder = (db:SupabaseClient,control:DigestControl,date:string)=>Promise<{checkedAt:string;messages:DigestMessage[]}>;
export function digestDatabase() {
 const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
 if(!url||!key)throw new Error("Notification database is not configured.");
 return createClient(url,key,{auth:{autoRefreshToken:false,persistSession:false},global:{fetch:(input,init)=>fetch(input,{...init,cache:"no-store"})}});
}
export function cronAuthorized(request:Request) {
 const secret=process.env.CRON_SECRET;
 const given=Buffer.from(request.headers.get("authorization")||""),expected=Buffer.from("Bearer "+(secret||""));
 return Boolean(secret)&&given.length===expected.length&&timingSafeEqual(given,expected);
}
export function digestEnabled(control:DigestControl,now=new Date()) {
 return control.config.delivery_ready===true&&(control.state==="enabled"||(control.state==="paused"&&Boolean(control.paused_until)&&Date.parse(control.paused_until!)<=now.getTime()));
}
export function dueReportDate(control:DigestControl,now=new Date()) {
 if(!digestEnabled(control,now))return null;
 const timezone=String(control.config.timezone||"Asia/Kolkata");
 const parts=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(now).map(p=>[p.type,p.value]));
 if(!/^\d{2}:\d{2}$/.test(String(control.config.schedule_time))||parts.hour+":"+parts.minute<String(control.config.schedule_time))return null;
 const offset=Number(control.config.day_offset);
 if(!Number.isInteger(offset)||offset>0||offset < -7)throw new Error("Invalid report-day offset");
 const date=new Date(parts.year+"-"+parts.month+"-"+parts.day+"T12:00:00Z");
 date.setUTCDate(date.getUTCDate()+offset);
 const result=date.toISOString().slice(0,10);
 return result<String(control.config.first_report_date||"")?null:result;
}
export function digestThreadKey(company:string,portal:string,event:string,email:string,month:string) {
 return createHash("sha256").update(JSON.stringify([company,portal,event,[email.toLowerCase()],[],month])).digest("hex");
}

export async function processPortalDigests(portal:"people"|"ops",eventKey:string,builder:DigestBuilder) {
 const db=digestDatabase(), summary={queued:0,accepted:0,uncertain:0,skipped:0,errors:[] as string[]};
 const controls=await db.from("portal_notification_controls").select("*").eq("portal",portal).eq("event_key",eventKey);
 if(controls.error)throw new Error(controls.error.message);
 for(const control of (controls.data||[]) as DigestControl[]) {
  const date=dueReportDate(control); if(!date)continue;
  const run=await db.from("portal_digest_runs").select("id").eq("company_id",control.company_id).eq("portal",portal).eq("event_key",eventKey).eq("report_date",date).maybeSingle();
  if(run.error)throw new Error(run.error.message);
  if(run.data)continue;
  const batch=await builder(db,control,date);
  if(new Set(batch.messages.map(m=>m.email)).size!==batch.messages.length)throw new Error("Conflicting recipient scopes; no email queued.");
  const queued=await db.rpc("portal_enqueue_digest",{p_company_id:control.company_id,p_portal:portal,p_event_key:eventKey,p_report_date:date,p_snapshot_at:batch.checkedAt,p_messages:batch.messages});
  if(queued.error)throw new Error(queued.error.message);
  if(queued.data)summary.queued+=batch.messages.length;
 }
 const claimed=await db.rpc("portal_claim_digest",{p_portal:portal,p_limit:80});
 if(claimed.error)throw new Error(claimed.error.message);
 for(let offset=0;offset<(claimed.data||[]).length;offset+=4) {
  await Promise.all(claimed.data.slice(offset,offset+4).map(async (delivery:DigestDelivery)=>{
   let sending=false;
   let transport:ReturnType<typeof nodemailer.createTransport>|undefined;
   try {
    const [controlResult,smtpResult,profileResult,threadResult]=await Promise.all([
     db.from("portal_notification_controls").select("*").eq("company_id",delivery.company_id).eq("portal",portal).eq("event_key",delivery.event_key).single(),
     db.from("email_notification_settings").select("is_enabled,smtp_host,smtp_port,smtp_secure,smtp_user,smtp_pass,smtp_from,from_name").eq("company_id",delivery.company_id).eq("id",true).single(),
     db.from("profiles").select("id").eq("company_id",delivery.company_id).eq("is_active",true).ilike("email",delivery.recipient_email).limit(1),
     db.from("portal_digest_threads").select("*").eq("company_id",delivery.company_id).eq("portal",portal).eq("event_key",delivery.event_key).eq("recipient_email",delivery.recipient_email).eq("report_month",delivery.report_date.slice(0,7)).maybeSingle()
    ]);
    const error=controlResult.error||smtpResult.error||profileResult.error||threadResult.error;
    if(error)throw new Error(error.message);
    if(!digestEnabled(controlResult.data as DigestControl)||!smtpResult.data.is_enabled||!profileResult.data?.length) {
     const skipped=await db.from("portal_digest_deliveries").update({status:"skipped",error:"Notification disabled or recipient no longer active.",completed_at:new Date().toISOString()}).eq("id",delivery.id).eq("status","sending");
     if(skipped.error)throw new Error(skipped.error.message);summary.skipped++;return;
    }
    const smtp=smtpResult.data,thread=threadResult.data,month=delivery.report_date.slice(0,7);
    if(!smtp.smtp_host||!smtp.smtp_from||!smtp.smtp_pass)throw new Error("Company SMTP is incomplete");
    const domain=String((controlResult.data as DigestControl).config.email_domain||"");
    if(!domain||!delivery.recipient_email.endsWith("@"+domain)||/[\r\n<>]/.test(delivery.recipient_email))throw new Error("Recipient is outside configured company email domain");
    const key=digestThreadKey(delivery.company_id,portal,delivery.event_key,delivery.recipient_email,month);
    const messageId="<portal-digest-"+key.slice(0,32)+"-"+delivery.report_date+"@"+domain+">";
    const root=thread?.root_message_id||messageId,subject=thread?.subject||delivery.subject;
    const prepared=await db.from("portal_digest_deliveries").update({thread_key:key,message_id:messageId,root_message_id:root,in_reply_to:thread?.last_message_id||null,subject}).eq("id",delivery.id).eq("status","sending");
    if(prepared.error)throw new Error(prepared.error.message);
    const port=Number(smtp.smtp_port);
    transport=nodemailer.createTransport({host:smtp.smtp_host,port,secure:port===465||(Boolean(smtp.smtp_secure)&&port!==587),auth:{user:smtp.smtp_user,pass:smtp.smtp_pass},connectionTimeout:10000,greetingTimeout:10000,socketTimeout:25000,disableFileAccess:true,disableUrlAccess:true});
    sending=true;
    const receipt=await transport.sendMail({from:'"'+String(smtp.from_name||"DropX Logistics").replace(/["\r\n]/g,"")+'" <'+smtp.smtp_from+">",to:[delivery.recipient_email],subject,html:delivery.html,text:delivery.body,messageId,inReplyTo:thread?.last_message_id,references:thread?[...new Set([thread.root_message_id,thread.last_message_id])]:undefined});
    if(!receipt.accepted?.includes(delivery.recipient_email))throw new Error("SMTP did not accept the recipient");
    const finished=await db.rpc("portal_finish_digest",{p_id:delivery.id,p_message_id:receipt.messageId,p_root_id:root,p_response:receipt.response});
    if(finished.error||finished.data!==true)throw new Error("SMTP accepted but receipt persistence needs verification");
    summary.accepted++;
   }catch(error) {
    const message=error instanceof Error?error.message:"Delivery requires verification";
    // Never requeue SMTP uncertainty automatically. Keep the exact payload and ID for audit.
    const result=await db.from("portal_digest_deliveries").update({status:sending?"uncertain":"skipped",error:message.slice(0,400),completed_at:new Date().toISOString()}).eq("id",delivery.id).eq("status","sending");
    summary[sending?"uncertain":"skipped"]++;summary.errors.push(delivery.id+": "+(result.error?"Receipt write failed":message));
   }finally{transport?.close();}
  }));
 }
 return summary;
}
