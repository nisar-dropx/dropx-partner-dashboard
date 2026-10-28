import {getAuthorization,hasPermission} from '@/lib/authorization';
import {requireCompanyId} from '@/lib/company-scope';
import {digestDatabase} from '@/lib/portal-digest-delivery';
import {loadLossReminderScope,loadLossReminderData} from '@/lib/loss-reminder-digest';
import {LOSS_REMINDER_STAGES,selectLossReminderRows,type LossReminderStage} from '@/lib/loss-reminder-policy';
import {renderLossReminder} from '@/lib/loss-reminder-render';
export const dynamic='force-dynamic';
export const maxDuration=120;
export async function GET(request:Request){
 const auth=await getAuthorization();
 if(!auth||auth.readOnly||!hasPermission(auth,'ops_notification_settings','edit')||!hasPermission(auth,'ops_losses','access'))return Response.json({error:'Losses and Notification Settings access required.'},{status:403});
 try{
  const db=digestDatabase(),company=requireCompanyId(auth),url=new URL(request.url),stage=(url.searchParams.get('stage')||'recovery') as LossReminderStage;
  if(!LOSS_REMINDER_STAGES.includes(stage))return Response.json({error:'Unknown stage'},{status:400});
  const event=`loss_reminder_${stage}_morning`,control=await db.from('portal_notification_controls').select('config').eq('company_id',company).eq('portal','ops').eq('event_key',event).single();
  if(control.error)throw Error('Reminder settings unavailable.');
  const scope=await loadLossReminderScope(db,company,control.data.config);
  const stations=scope.stations.filter(s=>auth.hasAllLocationAccess||auth.locationScopeIds.includes(s.id));
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(new Date());
  const data=await loadLossReminderData(db,company,stations,date);
  const rows=selectLossReminderRows(stage,data.input);
  const mail=renderLossReminder({stage,event,date,rows,checkedAt:data.checkedAt,warnings:data.warnings});
  if(url.searchParams.get('format')==='xlsx')return new Response(new Uint8Array(Buffer.from(mail.attachment.content,'base64')),{headers:{'Content-Type':mail.attachment.contentType,'Content-Disposition':`attachment; filename="${mail.attachment.filename}"`,'Cache-Control':'no-store'}});
  const toolbar=`<nav style="padding:12px;background:white;font:13px Arial">Live preview · not sent &nbsp; <a href="?stage=recovery">Recovery</a> · <a href="?stage=dispute">Disputes</a> · <a href="?stage=response">Station responses</a> · <a href="?stage=${stage}&format=xlsx">Download Excel</a></nav>`;
  return new Response(mail.html.replace(/(<body[^>]*>)/i,'$1'+toolbar),{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'"}});
 }catch(error){console.error('Loss reminder preview failed',error);return Response.json({error:'Current reminder could not be loaded. No email sent.'},{status:500});}
}
