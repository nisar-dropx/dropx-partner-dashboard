import {getAuthorization,isCompanyOwner,hasPermission} from "@/lib/authorization";
import {requireCompanyId} from "@/lib/company-scope";
import {digestDatabase} from "@/lib/portal-digest-delivery";
import {loadRegistrationPendency} from "@/lib/registration-pendency-data";
import {buildRegistrationMessages} from "@/lib/registration-pendency-digest";
import {digestMailAttachments} from "@/lib/portal-digest-attachments";
export const dynamic="force-dynamic";
export const maxDuration=120;
const esc=(value:unknown)=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
export async function GET(request:Request){
 try{
  const auth=await getAuthorization();
  if(!auth||!isCompanyOwner(auth)||!hasPermission(auth,"ops_notification_settings","edit"))return Response.json({error:"Owner notification-settings access required."},{status:403});
  const db=digestDatabase(),company=requireCompanyId(auth),url=new URL(request.url);
  const date=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  const snapshot=await loadRegistrationPendency(db,company,date,"dropxlogistics.com");
  const slot=url.searchParams.get("slot")==="afternoon"?"afternoon":"morning";
  const messages=await buildRegistrationMessages(snapshot,`registration_pendency_${slot}`,"DropX | Registration pendency | "+(slot==="morning"?"Morning":"Follow-up")+" | {{month}} {{year}}");
  const smtp=await db.from("email_notification_settings").select("is_enabled,smtp_host,smtp_from").eq("company_id",company).eq("id",true).single();
  if(smtp.error)throw Error("SMTP readiness check unavailable.");
  const selected=messages.find(m=>m.email===url.searchParams.get("recipient"));
  const counts={people:snapshot.rows.filter(r=>r.workspace==="People").length,workforce:snapshot.rows.filter(r=>r.workspace==="Workforce").length,recipients:messages.length,unrouted:snapshot.unrouted.length};
  if(url.searchParams.get("format")==="json")return Response.json({date,checkedAt:snapshot.checkedAt,counts,smtpReady:Boolean(smtp.data.is_enabled&&smtp.data.smtp_host&&smtp.data.smtp_from),recipients:messages.map(m=>({email:m.email,name:m.name,...m.scope})),unrouted:snapshot.unrouted.map(r=>({reference:r.reference,workspace:r.workspace,name:r.name,station:r.stationCode,status:r.status}))},{headers:{"Cache-Control":"no-store"}});
  if(selected&&url.searchParams.get("format")==="xlsx"){
   const attachment=digestMailAttachments(selected.attachments)[0];
   return new Response(new Uint8Array(attachment.content),{headers:{"Content-Type":attachment.contentType,"Content-Disposition":`attachment; filename="${attachment.filename}"`,"Cache-Control":"no-store"}});
  }
  const toolbar=`<div style="padding:18px;font:14px Arial;background:#fff"><b>READ-ONLY PREVIEW — no email sent</b><p>${counts.people} People · ${counts.workforce} Workforce · ${counts.recipients} manager emails · ${counts.unrouted} not routed</p><p>Unmapped or ambiguous managers are held; they are never sent to a guessed recipient.</p><form><label>Manager <select name="recipient">${messages.map(m=>`<option value="${esc(m.email)}" ${m.email===selected?.email?"selected":""}>${esc(m.name)} · ${esc(m.email)} · ${m.scope.pending} profiles</option>`).join("")}</select></label><button>Preview email</button></form>${selected?`<p><a href="?recipient=${encodeURIComponent(selected.email)}&format=xlsx">Download this manager’s Excel</a></p>`:""}<details><summary>Profiles needing a manager mapping (${counts.unrouted})</summary><table>${snapshot.unrouted.map(r=>`<tr><td>${esc(r.reference)}</td><td>${esc(r.name)}</td><td>${esc(r.stationCode)}</td><td>${esc(r.workspace)}</td></tr>`).join("")}</table></details></div>`;
  const html=selected?selected.html.replace(/(<body[^>]*>)/,"$1"+toolbar):`<!doctype html><html><body>${toolbar}</body></html>`;
  return new Response(html,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Content-Security-Policy":"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'self'"}});
 }catch(error){console.error("Registration preview failed",error instanceof Error?error.message:"Unknown error");return Response.json({error:"Registration preview unavailable. No email has been sent; check source configuration and retry."},{status:503});}
}
