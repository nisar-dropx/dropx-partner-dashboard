import type {DigestBuilder,DigestMessage} from "./portal-digest-delivery";
import {createStreamingXlsx} from "./xlsx-stream.ts";
import {registrationEvents,type RegistrationSnapshot,type RegistrationRow} from "./registration-pendency.ts";
import {loadRegistrationSummaryRecipients,type RegistrationSummaryRecipient} from "./registration-summary-recipients.ts";
import {loadRegistrationTeamRecipients,registrationMailRecipients,type RegistrationMailRecipient} from "./registration-mail-recipients.ts";

const esc=(value:unknown)=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]!));
const stamp=(value:string)=>value?new Date(value).toLocaleString("en-GB",{timeZone:"Asia/Kolkata",day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit",hour12:true}):"—";
export const registrationColumns=["Workspace","Profile type","DropX ID","Name","Designation","Station / store","Location name","Registration status","Required filled","Required total","Missing required fields","Other unfilled optional fields","Action required","Reporting manager","Manager email","Joining date","Age since profile creation (days)","Last profile update (IST)","Last draft save (IST)","Profile link","Snapshot (IST)","Cluster","Cluster manager","Activity confirmation"];
export function registrationCells(row:RegistrationRow,checkedAt:string){
 return [row.workspace,row.profileType,row.reference,row.name,row.designation,row.stationCode,row.stationName,row.status,row.requiredFilled,row.requiredTotal,row.missing.join("; ")||"None",row.optionalMissing.join("; ")||"None",row.action,row.managerName,row.managerEmail,row.joinedAt,row.ageDays,stamp(row.updatedAt),stamp(row.draftAt),row.href,stamp(checkedAt),row.cluster||"Not mapped",row.clusterManager||"Not mapped","If active, complete registration/review for timely salary or payout processing. If no longer active, verify and initiate offboarding."];
}
export async function registrationAttachment(rows:RegistrationRow[],date:string,checkedAt:string,slot:string){
 const stream=createStreamingXlsx({sheetName:"Registration pendency",wrapText:true,headers:registrationColumns,columnWidths:[13,14,16,30,24,18,25,30,14,14,65,50,60,28,35,16,20,25,25,65,25,26,30,65],rows:rows.map(row=>registrationCells(row,checkedAt))});
 const chunks:Buffer[]=[];for await(const chunk of stream)chunks.push(Buffer.from(chunk));
 const bytes=Buffer.concat(chunks);
 if(bytes.length>10*1024*1024)throw Error("Registration report exceeds the email attachment limit; no incomplete attachment sent.");
 return {filename:`Registration_Pendency_${date}_${slot}.xlsx`,contentType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" as const,content:bytes.toString("base64"),encoding:"base64" as const};
}

export async function buildRegistrationMessages(snapshot:RegistrationSnapshot,event:string,subjectTemplate:string,summaryRecipients:RegistrationSummaryRecipient[]=[],teamRecipients:RegistrationMailRecipient[]=[]):Promise<DigestMessage[]>{
 if(!registrationEvents.includes(event as typeof registrationEvents[number]))throw Error("Invalid registration schedule.");
 const morning=event.endsWith("_morning"),slot=morning?"Morning":"Afternoon";
 const month=new Date(`${snapshot.date}T12:00:00Z`).toLocaleDateString("en-GB",{month:"long",timeZone:"Asia/Kolkata"});
 const subject=subjectTemplate.replaceAll("{{month}}",month).replaceAll("{{year}}",snapshot.date.slice(0,4));
 if(!subject||/[\r\n]/.test(subject))throw Error("Invalid registration email subject.");
 const messages:DigestMessage[]=[];
 for(const recipient of registrationMailRecipients(snapshot,summaryRecipients,teamRecipients)){
  const keys=new Set(recipient.profileKeys),rows=snapshot.rows.filter(row=>keys.has(row.key));
  if(!rows.length)continue;
  const workspaces=[...new Set(rows.map(row=>row.workspace))].sort();
  const stations=[...new Set(rows.map(row=>row.stationId))].map(id=>{
   const scoped=rows.filter(row=>row.stationId===id);
   return {code:scoped[0].stationCode,name:scoped[0].stationName,people:scoped.filter(row=>row.workspace==="People").length,workforce:scoped.filter(row=>row.workspace==="Workforce").length,review:scoped.filter(row=>row.stage==="review").length,total:scoped.length};
  }).sort((a,b)=>b.total-a.total||a.code.localeCompare(b.code));
  const pending=rows.filter(row=>row.stage!=="review").length,review=rows.length-pending;
  const both=workspaces.length===2;
  const headers=["Station / store",...(both?["People","Workforce"]:[]),"Review*","Total"];
  const table=`<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px"><thead><tr>${headers.map(v=>`<th align="left" style="padding:9px 8px;background:#18243d;color:#fff">${v}</th>`).join("")}</tr></thead><tbody>${stations.slice(0,12).map((s,i)=>`<tr style="background:${i%2?"#f2f5fa":"#fff"}"><td style="padding:8px;border-bottom:1px solid #e3e8f1"><b>${esc(s.code)}</b> <span style="color:#64748b">${esc(s.name)}</span></td>${[...(both?[s.people,s.workforce]:[]),s.review,s.total].map(n=>`<td style="padding:8px;border-bottom:1px solid #e3e8f1">${n}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  const action="Active: complete registration and any pending review to support on-time salaries and payouts. No longer active: verify and initiate offboarding.";
  const reminder=morning?"Morning action list":"Afternoon follow-up · fresh check";
  const gaps=rows.filter(row=>!row.managerEmail).length;
  const scopeNote=recipient.consolidated?`Consolidated overview · ${gaps} profiles have no verified manager email.`:
   `${recipient.audience} · ${workspaces.join(" + ")} · assigned locations/reportees${gaps?` · ${gaps} need a manager mapping`:""}.`;
  const links=workspaces.map(workspace=>({label:workspace==="People"?"Open People":"Open Workforce",url:workspace==="People"?"https://people.dropxlogistics.com/people":"https://ops.dropxlogistics.com/work-force-register?view=pending"}));
  const html=`<!doctype html><html><body style="margin:0;background:#edf1f7;color:#1b2942;font-family:Arial,sans-serif"><table role="presentation" width="100%" cellspacing="0"><tr><td align="center" style="padding:16px 8px"><table role="presentation" width="640" cellspacing="0" style="width:100%;max-width:640px;background:white;border-radius:12px;overflow:hidden"><tr><td style="padding:20px 22px;background:#20213f;background:linear-gradient(120deg,#18243d,#6e315d);color:white;border-top:5px solid #f45a2a"><div style="font-size:11px;font-weight:bold;letter-spacing:1px;color:#ffbb9c">DROPX · ${esc(workspaces.join(" + ").toUpperCase())}</div><h1 style="font-size:23px;margin:8px 0">Registration pendency${recipient.consolidated?" · Consolidated":""}</h1><div style="font-size:12px;color:#e6e8f2">${reminder} · ${esc(stamp(snapshot.checkedAt))} IST</div></td></tr><tr><td style="padding:18px 22px"><p style="margin:0 0 12px;font-size:13px">Hello ${esc(recipient.name)},</p><table role="presentation" width="100%" cellspacing="0" style="margin-bottom:14px"><tr>${[[pending,"To complete","#fff0e7","#b84317"],[review,"Awaiting review","#f0eaff","#6d3bb1"],[stations.length,"Stations / stores","#e4f6f1","#11745c"]].map(([n,label,bg,color])=>`<td width="33%" style="padding:10px;background:${bg};color:${color};border-right:4px solid white"><b style="font-size:24px">${n}</b><br><span style="font-size:11px">${label}</span></td>`).join("")}</tr></table>${table}<p style="font-size:11px;color:#64748b;margin:8px 0">*Review is included in total.${stations.length>12?` Showing the 12 stations with most pendency; all ${stations.length} are in Excel.`:""}</p><div style="padding:12px;background:#fff6e4;border-left:4px solid #f59e0b;font-size:13px;line-height:1.5"><b>Active?</b> Complete registration and review for on-time salaries and payouts.<br><b>No longer active?</b> Verify and initiate offboarding.</div><p style="font-size:12px;line-height:1.5">Excel attached: every pending person, station, cluster, status, missing fields and next action. Submitted profiles need review, not re-entry.</p><p style="line-height:2.5;margin:10px 0">${links.map(link=>`<a style="display:inline-block;background:#d94827;color:white;padding:2px 14px;text-decoration:none;border-radius:6px;font-weight:bold;font-size:12px;margin-right:6px" href="${link.url}">${link.label} →</a>`).join("")}</p><p style="font-size:11px;color:#64748b;margin-bottom:0">${esc(scopeNote)}</p></td></tr><tr><td style="padding:12px 22px;background:#f4f6fa;color:#64748b;font-size:11px;line-height:1.5">Morning + afternoon updates reply in one monthly thread. Completed profiles drop out; no email when nothing is pending. No identity numbers, bank details or document copies attached.</td></tr></table></td></tr></table></body></html>`;
  const text=`DropX registration pendency · ${reminder}\nAs of ${stamp(snapshot.checkedAt)} IST\nHello ${recipient.name},\n${pending} to complete; ${review} awaiting review; ${stations.length} stations/stores.\n${scopeNote}\nStation | People | Workforce | Review (included) | Total\n${stations.slice(0,12).map(s=>`${s.code} | ${s.people} | ${s.workforce} | ${s.review} | ${s.total}`).join("\n")}\n\n${action}\nFull details, cluster and missing fields are in the attached Excel. Submitted profiles need review, not re-entry.\n${links.map(l=>`${l.label}: ${l.url}`).join("\n")}\nOne monthly thread. No email when there is no pendency.`;
  messages.push({email:recipient.email,name:recipient.name,subject:recipient.consolidated?subject+" | Consolidated":subject,html,text,attachments:[await registrationAttachment(rows,snapshot.date,snapshot.checkedAt,slot)],scope:{profileKeys:rows.map(r=>r.key),stationIds:[...new Set(rows.map(r=>r.stationId))],pending:rows.length,people:rows.filter(r=>r.workspace==="People").length,workforce:rows.filter(r=>r.workspace==="Workforce").length,reportDate:snapshot.date,slot,consolidated:recipient.consolidated,audience:recipient.audience}});
 }
 return messages;
}
export const buildRegistrationDigest:DigestBuilder=async(db,control,date)=>{
 const {loadRegistrationPendency}=await import("./registration-pendency-data");
 const snapshot=await loadRegistrationPendency(db,control.company_id,date,String(control.config.email_domain||""));
 if(snapshot.unrouted.length)console.warn("Registration pendency has unmapped managers",{profiles:snapshot.unrouted.length,stations:new Set(snapshot.unrouted.map(r=>r.stationId)).size});
 const [summaries,teams]=await Promise.all([loadRegistrationSummaryRecipients(db,control.company_id,control.config),loadRegistrationTeamRecipients(db,control.company_id,control.config,snapshot)]);
 return {checkedAt:snapshot.checkedAt,messages:await buildRegistrationMessages(snapshot,control.event_key,control.subject_template||"",summaries,teams)};
};
