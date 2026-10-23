import { getAuthorization, hasPermission } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { digestDatabase } from '@/lib/portal-digest-delivery';
import { digestMailAttachments, type DigestAttachment } from '@/lib/portal-digest-attachments';
import { loadLossDailySnapshot } from '@/lib/loss-daily-data';
import { buildLossDailyMail, lossEscape as e } from '@/lib/loss-daily-mail';
import { sendEmail } from '@/lib/email';

export const dynamic='force-dynamic';
export const maxDuration=120;
const contentType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const headers={'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'self'; base-uri 'none'"};
async function access(){
  const auth=await getAuthorization();
  if(!auth||auth.readOnly||!hasPermission(auth,'ops_notification_settings','edit')||!hasPermission(auth,'ops_losses','access'))throw new Error('Access denied. Open this report with your own Losses and Notification Settings access.');
  const email=auth.email?.trim().toLowerCase();
  if(!email||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Your verified account email is unavailable.');
  return {auth,email,company:requireCompanyId(auth),db:digestDatabase(),event:`loss_recovery_manual_${auth.userId}`};
}
function receipt(email:string,date:string,status:string,messageId?:string){
  return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Loss report delivery</title></head><body style="margin:0;background:#f3f5f8;font:15px/1.6 Arial;color:#172236"><main style="max-width:650px;margin:50px auto;background:white;border:1px solid #e2e7ef;border-top:4px solid #ed5924;border-radius:12px;padding:28px"><b style="color:#ed5924">OpsPulse · Team Ops</b><h1 style="font-size:25px">Loss report delivery</h1><p><b>${e(status)}</b></p><p>To: <b>${e(email)}</b><br>Report date: ${e(date)}<br>Excel: OpsPulse-Loss-Actions-${e(date)}.xlsx</p><p>Station Summary · Case Actions · Person Recoveries</p>${messageId?`<p style="font-size:11px;color:#66758b;overflow-wrap:anywhere">Receipt: ${e(messageId)}</p>`:''}<p>This was a manual send. It does not enable recurring delivery.</p><a href="/api/ops-pulse/loss-recovery-digest-preview">View current report</a> · <a href="/settings/notifications#loss-recovery-digest">Notification settings</a></main></body></html>`,{headers});
}
export async function GET(request:Request){
  try{
    const {auth,email,db,company,event}=await access();
    const snapshot=await loadLossDailySnapshot(auth),mail=buildLossDailyMail(snapshot);
    if(new URL(request.url).searchParams.get('format')==='xlsx')return new Response(new Uint8Array(mail.workbook),{headers:{'Content-Type':contentType,'Content-Disposition':`attachment; filename="${mail.filename}"`,'Cache-Control':'no-store'}});
    const existing=await db.from('portal_digest_deliveries').select('status').eq('company_id',company).eq('portal','ops').eq('event_key',event).eq('report_date',snapshot.date).eq('recipient_email',email).maybeSingle();
    if(existing.error)throw new Error('Delivery status unavailable; please retry before sending.');
    const toolbar=`<div style="padding:12px 20px;background:white;font:13px Arial;display:flex;gap:16px;align-items:center;flex-wrap:wrap"><b>Current data · Your permitted stations</b><span>To: ${e(email)}</span><a href="?format=xlsx">Download Excel</a>${existing.data?`<b>Today’s send: ${e(existing.data.status)} · no duplicate will be sent</b>`:`<form method="post"><button style="padding:10px 15px;background:#e9501c;color:white;border:0;border-radius:6px">Send current report to my inbox</button></form>`}<span>Manual send only · recurring settings stay unchanged</span></div>`;
    return new Response(mail.html.replace(/(<body[^>]*>)/i,'$1'+toolbar),{headers});
  }catch(error){return Response.json({error:error instanceof Error?error.message:'Report unavailable'},{status:400,headers:{'Cache-Control':'no-store'}});}
}
export async function POST(request:Request){
  if(request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'Invalid origin'},{status:403});
  let deliveryId:string|null=null,db:ReturnType<typeof digestDatabase>|null=null;
  try{
    const input=await access();db=input.db;
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(new Date());
    const existing=await db.from('portal_digest_deliveries').select('status,message_id').eq('company_id',input.company).eq('portal','ops').eq('event_key',input.event).eq('report_date',today).eq('recipient_email',input.email).maybeSingle();
    if(existing.error)throw new Error('Unable to check for an existing send. No email was sent.');
    if(existing.data)return receipt(input.email,today,existing.data.status==='accepted'?'Mail server already accepted this report. No duplicate sent.':`Existing send is ${existing.data.status}; check delivery before retrying.`,existing.data.message_id);
    const snapshot=await loadLossDailySnapshot(input.auth),mail=buildLossDailyMail(snapshot);
    const attachments:DigestAttachment[]=[{filename:mail.filename,contentType,encoding:'base64',content:mail.workbook.toString('base64')}];
    const files=digestMailAttachments(attachments);
    const smtp=await db.from('email_notification_settings').select('is_enabled,smtp_host').eq('company_id',input.company).eq('id',true).maybeSingle();
    if(smtp.error||!smtp.data?.is_enabled||!smtp.data.smtp_host)throw new Error('Company email delivery is not enabled. No email was sent.');
    const previous=await db.from('portal_digest_deliveries').select('message_id').eq('company_id',input.company).eq('portal','ops').eq('event_key',input.event).eq('recipient_email',input.email).eq('status','accepted').gte('report_date',snapshot.date.slice(0,7)+'-01').order('report_date',{ascending:false}).limit(1).maybeSingle();
    if(previous.error)throw new Error('Unable to verify the email thread. No email was sent.');
    // Unique company / event / report_date reservation prevents double clicks and repeat POSTs.
    const run=await db.from('portal_digest_runs').insert({company_id:input.company,portal:'ops',event_key:input.event,report_date:snapshot.date,snapshot_at:snapshot.checkedAt,recipient_count:1}).select('id').single();
    if(run.error)throw new Error('Today’s report is reserved or already sent. Check the delivery receipt; do not resend.');
    const delivery=await db.from('portal_digest_deliveries').insert({run_id:run.data.id,company_id:input.company,portal:'ops',event_key:input.event,report_date:snapshot.date,recipient_email:input.email,recipient_name:input.auth.fullName,subject:mail.subject,html:mail.html,body:mail.text,scope_summary:{stations:snapshot.stations.map(s=>s.station_code),scopeCount:snapshot.scopeCount,actions:snapshot.actions.length,manual:true},attachments,status:'sending',started_at:new Date().toISOString()}).select('id').single();
    if(delivery.error)throw new Error('Delivery receipt could not be reserved. No email was sent.');
    deliveryId=delivery.data.id;
    const reply=previous.data?.message_id||undefined;
    const result=await sendEmail({companyId:input.company,to:[input.email],subject:mail.subject,body:mail.text,html:mail.html,attachments:files,timeoutMs:20000,messageId:`<loss-report-${deliveryId}@dropxlogistics.com>`,inReplyTo:reply,references:reply?[reply]:undefined});
    if(!result.accepted.some(address=>String(address).toLowerCase()===input.email))throw new Error('Mail server did not confirm the recipient. Verify the receipt before another send.');
    const saved=await db.from('portal_digest_deliveries').update({status:'accepted',message_id:result.messageId,smtp_response:result.response,completed_at:new Date().toISOString()}).eq('id',deliveryId);
    if(saved.error)throw new Error('Mail accepted; delivery receipt needs verification. Do not resend.');
    return receipt(input.email,snapshot.date,'Mail server accepted the report with the Excel attachment.',result.messageId);
  }catch(error){
    if(deliveryId&&db)await db.from('portal_digest_deliveries').update({status:'uncertain',error:'Manual delivery needs verification; no automatic retry.',completed_at:new Date().toISOString()}).eq('id',deliveryId);
    return Response.json({error:error instanceof Error?error.message:'Delivery unavailable'},{status:400,headers:{'Cache-Control':'no-store'}});
  }
}
