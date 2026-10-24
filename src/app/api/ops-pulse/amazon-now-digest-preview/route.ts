import { getAuthorization, hasPermission } from "@/lib/authorization";
import { digestDatabase } from "@/lib/portal-digest-delivery";
import { buildAmazonNowDigest, defaultNowControl, nowDigestEvents, type NowDigestEvent } from "@/lib/amazon-now-digest";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
export async function GET(request: Request) {
 const headers = { "Cache-Control":"private, no-store", Vary:"Cookie" };
 const auth = await getAuthorization();
 if (!auth?.companyId || !hasPermission(auth,'ops_notification_settings','access')) return Response.json({error:'Notification settings access required.'},{status:403,headers});
 const url = new URL(request.url), event = url.searchParams.get('event') as NowDigestEvent;
 if (!nowDigestEvents.includes(event)) return Response.json({error:'Choose a store digest.'},{status:400,headers});
 try {
  const db=digestDatabase(), company=auth.companyId;
  const [saved,base]=await Promise.all([db.from('portal_notification_controls').select('*').eq('company_id',company).eq('portal','ops').eq('event_key',event).maybeSingle(),db.from('portal_notification_controls').select('config').eq('company_id',company).eq('portal','ops').eq('event_key','review_digest').single()]);
  if(saved.error||base.error)throw Error('Schedule configuration unavailable.');
  const control=saved.data||defaultNowControl(company,event,String(base.data.config.email_domain||''));
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(new Date());
  const batch=await buildAmazonNowDigest(db,{...control,config:{...control.config,send_zero_cases:true}},date);
  const selected=batch.messages.find(m=>m.email===url.searchParams.get('recipient'))||batch.messages.find(m=>m.email===auth.email)||batch.messages[0];
  if(!selected)throw Error('No eligible recipients.');
  return new Response(selected.html,{headers:{...headers,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; frame-ancestors 'self'"}});
 }catch(e){console.error('[amazon-now-digest-preview]',e instanceof Error?e.message:'unavailable');return Response.json({error:e instanceof Error?e.message:'Preview unavailable.'},{status:503,headers});}
}
