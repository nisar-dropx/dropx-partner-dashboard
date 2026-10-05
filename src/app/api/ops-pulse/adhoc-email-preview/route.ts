import { getAuthorization, hasPermission } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { digestDatabase } from '@/lib/portal-digest-delivery';
import { digestMailAttachments } from '@/lib/portal-digest-attachments';
import { buildAdHocDigest } from '@/lib/adhoc-digest';
import { shiftDay, dateKey } from '@/lib/payment-volume';
import { sendEmail } from '@/lib/email';
export const dynamic='force-dynamic';
export const maxDuration=60;
async function sample(request:Request){
 const auth=await getAuthorization();
 if(!auth||!hasPermission(auth,'ops_notification_settings','edit'))throw new Error('Access denied');
 const company=requireCompanyId(auth),db=digestDatabase();
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(new Date());
 const date=new URL(request.url).searchParams.get('date')||shiftDay(today,-1);
 if(!dateKey(date)||date>today||date<shiftDay(today,-366))throw new Error('Invalid date');
 const control=await db.from('portal_notification_controls').select('*').eq('company_id',company).eq('portal','ops').eq('event_key','adhoc_usage_digest').single();
 if(control.error)throw new Error('Schedule unavailable');
 const result=await buildAdHocDigest(db,control.data,date);
 const mail=result.messages.find(m=>m.email===auth.email?.trim().toLowerCase());
 if(!mail)throw new Error('No report activity in your configured email scope for this day');
 return {db,company,date,mail};
}
export async function GET(request:Request){
 try{
 const {mail,date}=await sample(request);
 if(new URL(request.url).searchParams.get('format')==='xlsx'){
  const attachment=digestMailAttachments(mail.attachments)[0];
  return new Response(attachment.content,{headers:{'Content-Type':attachment.contentType,'Content-Disposition':`attachment; filename="${attachment.filename}"`,'Cache-Control':'no-store'}});
 }
 const tools=`<div style="padding:12px 20px;background:#fff;font:13px Arial;display:flex;gap:15px;align-items:center;flex-wrap:wrap"><b>Sample · ${date} · Your permitted stations</b><a href="?date=${date}&format=xlsx">Download Excel</a><form method="post"><button style="padding:9px 14px;background:#0f766e;color:white;border:0;border-radius:6px">Send sample to my inbox</button></form></div>`;
 return new Response(mail.html.replace('<body ', '<body ').replace(/(<body[^>]*>)/, '$1'+tools),{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'self'"}});
 }catch(e){return Response.json({error:e instanceof Error?e.message:'Preview unavailable'},{status:400});}
}
export async function POST(request:Request){
 if(request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'Invalid origin'},{status:403});
 let deliveryId:string|null=null,db:ReturnType<typeof digestDatabase>|null=null;
 try{
  const input=await sample(request);db=input.db;
  const event='adhoc_usage_digest_test';
  const run=await db.from('portal_digest_runs').insert({company_id:input.company,portal:'ops',event_key:event,report_date:input.date,snapshot_at:new Date().toISOString(),recipient_count:1}).select('id').single();
  if(run.error)throw new Error('A sample for this report date already exists or is being sent. Check delivery logs before retrying.');
  const subject='[SAMPLE] '+input.mail.subject;
  const delivery=await db.from('portal_digest_deliveries').insert({run_id:run.data.id,company_id:input.company,portal:'ops',event_key:event,report_date:input.date,recipient_email:input.mail.email,recipient_name:input.mail.name,subject,html:input.mail.html,body:input.mail.text,scope_summary:input.mail.scope,attachments:input.mail.attachments,status:'sending',started_at:new Date().toISOString()}).select('id').single();
  if(delivery.error)throw new Error('Sample receipt could not be reserved.');
  deliveryId=delivery.data.id;
  const receipt=await sendEmail({companyId:input.company,to:[input.mail.email],subject,body:input.mail.text,html:input.mail.html,attachments:digestMailAttachments(input.mail.attachments),timeoutMs:20000,messageId:`<adhoc-sample-${deliveryId}@dropxlogistics.com>`});
  const saved=await db.from('portal_digest_deliveries').update({status:'accepted',message_id:receipt.messageId,smtp_response:receipt.response,completed_at:new Date().toISOString()}).eq('id',deliveryId);
  if(saved.error)throw new Error('Mail accepted; receipt needs verification. Do not resend.');
  return Response.json({sentTo:input.mail.email,reportDate:input.date,status:'Mail server accepted the sample',messageId:receipt.messageId});
 }catch(e){
  if(deliveryId&&db)await db.from('portal_digest_deliveries').update({status:'uncertain',error:'Sample needs delivery verification; no automatic retry.',completed_at:new Date().toISOString()}).eq('id',deliveryId);
  return Response.json({error:e instanceof Error?e.message:'Sample could not be sent'},{status:400});
 }
}
