import * as XLSX from "xlsx";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DigestBuilder, DigestMessage } from "./portal-digest-delivery";
import { canonicalizeProviderFirstMembers, providerMemberKey, providerSourceMemberKey } from "./provider-first-mapping-view.ts";

type Relation = { code?: string | null } | Array<{ code?: string | null }> | null;
export type MappingDigestStation = { id:string; station_code:string; station_name:string|null; hide_from_location_list:boolean|null; providers:Relation; location_models:Relation };
type MappingRow = { station_id:string|null; provider_member_id:string; workforce_id:string|null; status:string; effective_to:string|null };
type ShipmentRow = { station_code:string; provider_employee_id:string; provider_employee_name:string|null; work_date:string; amazon_delivery:number|null };
type Membership = { user_id:string; role_id:string; product_code:string; has_all_location_access:boolean; location_scope_ids:string[]|null };
type Role = { id:string; code:string; location_access_mode:string|null };
type Profile = { id:string; full_name:string|null; email:string|null };
export type MappingDigestRecipient = { email:string; name:string; stationIds:string[]; roles:string[] };
export type MappingPendingRow = { stationId:string; stationCode:string; stationName:string; program:string; providerId:string; name:string; firstOutboundDate:string; lastOutboundDate:string; ageDays:number; ageBand:string };
export type MappingDigestSnapshot = { date:string; month:string; checkedAt:string; rows:MappingPendingRow[]; recipients:Array<MappingDigestRecipient&{pending:number}> };

const roleCodes = new Set(["OPERATIONS_CLM","OPERATIONS_AOM","OPERATIONS_BH","OPERATIONS_HLM","OPERATIONS_FINMGR","FINANCE_FINMGR","FINANCE_ACE","FINANCE_ACCOUNTS"]);
const defaultAdditionalEmails = ["abdul@dropxlogistics.com","jamsheer@dropxlogistics.com"];
const ageKeys = ["0–2 days","3–5 days","6–7 days",">7 days"] as const;
const esc=(value:unknown)=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]!));
const relationCode=(value:Relation)=>String((Array.isArray(value)?value[0]:value)?.code||"").trim().toUpperCase();
const ageBand=(days:number)=>days<=2?ageKeys[0]:days<=5?ageKeys[1]:days<=7?ageKeys[2]:ageKeys[3];
const monthLabel=(month:string)=>new Date(`${month}-01T12:00:00Z`).toLocaleDateString("en-GB",{month:"long",year:"numeric",timeZone:"Asia/Kolkata"});

async function allRows<T>(query:(offset:number)=>PromiseLike<{data:unknown[]|null;error:{message:string}|null}>):Promise<T[]>{
 const rows:T[]=[];
 for(let offset=0;offset<100000;offset+=1000){const result=await query(offset);if(result.error)throw new Error(result.error.message);rows.push(...(result.data??[]) as T[]);if((result.data?.length??0)<1000)return rows;}
 throw new Error("ID-mapping digest source exceeds 100,000 rows.");
}

export function isMappingDigestStation(station:MappingDigestStation){return !station.hide_from_location_list&&!/^TEST(?:$|[\s_-])/i.test(station.station_code.trim())&&relationCode(station.providers)==="AMAZON"&&["EDSP","XPT"].includes(relationCode(station.location_models));}

export function resolveMappingDigestRecipients(stations:MappingDigestStation[],memberships:Membership[],roles:Role[],profiles:Profile[],domain:string,additionalEmails:string[]=defaultAdditionalEmails){
 const included=stations.filter(isMappingDigestStation),roleById=new Map(roles.map(role=>[role.id,role])),profileById=new Map(profiles.map(profile=>[profile.id,profile]));
 const additional=new Set(additionalEmails.map(email=>email.trim().toLowerCase())),recipients=new Map<string,MappingDigestRecipient>();
 for(const membership of memberships){
  const role=roleById.get(membership.role_id),profile=profileById.get(membership.user_id),email=String(profile?.email||"").trim().toLowerCase();
  const allowedRole=Boolean(role&&(roleCodes.has(role.code)||(membership.product_code==="operations"&&additional.has(email))));
  if(!allowedRole||!profile||!email.endsWith(`@${domain.toLowerCase()}`)||!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))continue;
  const scoped=included.filter(station=>membership.has_all_location_access||role!.location_access_mode==="all_locations"||membership.location_scope_ids?.includes(station.id));
  if(!scoped.length)continue;
  const recipient=recipients.get(email)??{email,name:profile.full_name||email,stationIds:[],roles:[]};
  recipient.stationIds=[...new Set([...recipient.stationIds,...scoped.map(station=>station.id)])].sort();recipient.roles=[...new Set([...recipient.roles,role!.code])].sort();recipients.set(email,recipient);
 }
 return [...recipients.values()].sort((a,b)=>a.email.localeCompare(b.email));
}

export function buildMappingDigestSnapshot(input:{date:string;checkedAt:string;stations:MappingDigestStation[];mappings:MappingRow[];workforceIds:string[];shipments:ShipmentRow[];recipients:MappingDigestRecipient[]}):MappingDigestSnapshot{
 const {date}=input;if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error("Invalid ID-mapping digest date.");const month=date.slice(0,7);
 const stations=input.stations.filter(isMappingDigestStation),stationByCode=new Map(stations.map(station=>[station.station_code.trim().toUpperCase(),station])),stationById=new Map(input.stations.map(station=>[station.id,station]));
 const protectedKeys=new Set(input.mappings.map(mapping=>providerSourceMemberKey(stationById.get(String(mapping.station_id))?.station_code||"*",mapping.provider_member_id)));
 const source=new Map<string,{providerMemberId:string;providerMemberName:string;stationCode:string;workDate:string;outboundMonths:string[]}>();
 for(const shipment of input.shipments){if(shipment.work_date.slice(0,7)!==month||shipment.work_date>date||Number(shipment.amazon_delivery)<=0)continue;const stationCode=shipment.station_code.trim().toUpperCase(),providerMemberId=String(shipment.provider_employee_id||"").trim();if(!stationByCode.has(stationCode)||!providerMemberId)continue;const key=providerSourceMemberKey(stationCode,providerMemberId),current=source.get(key);if(current){current.outboundMonths=[...new Set([...current.outboundMonths,shipment.work_date])].sort();if(shipment.work_date>=current.workDate){current.workDate=shipment.work_date;current.providerMemberName=String(shipment.provider_employee_name||current.providerMemberName).trim();}}else source.set(key,{providerMemberId,providerMemberName:String(shipment.provider_employee_name||"Unnamed provider member").trim(),stationCode,workDate:shipment.work_date,outboundMonths:[shipment.work_date]});}
 const canonical=canonicalizeProviderFirstMembers([...source.values()],protectedKeys),active=new Map<string,MappingRow>(),workforce=new Set(input.workforceIds);
 for(const mapping of input.mappings){if(mapping.status!=="active"||mapping.effective_to)continue;const key=providerMemberKey(String(mapping.station_id||""),mapping.provider_member_id);if(!active.has(key))active.set(key,mapping);}
 const rows:MappingPendingRow[]=[];
 for(const member of canonical){const station=stationByCode.get(member.stationCode.toUpperCase());if(!station)continue;const mapping=active.get(providerMemberKey(station.id,member.providerMemberId));if(mapping?.workforce_id&&workforce.has(mapping.workforce_id))continue;const dates=[...new Set(member.outboundMonths||[])].filter(value=>/^\d{4}-\d{2}-\d{2}$/.test(value)).sort();if(!dates.length)throw new Error(`Missing outbound dates for ${station.station_code} / ${member.providerMemberId}`);const ageDays=Math.round((Date.parse(`${date}T00:00:00Z`)-Date.parse(`${dates[0]}T00:00:00Z`))/86400000);rows.push({stationId:station.id,stationCode:station.station_code,stationName:station.station_name||station.station_code,program:relationCode(station.location_models),providerId:member.providerMemberId,name:member.providerMemberName||"Unnamed provider member",firstOutboundDate:dates[0],lastOutboundDate:dates[dates.length-1],ageDays,ageBand:ageBand(ageDays)});}
 rows.sort((a,b)=>a.stationCode.localeCompare(b.stationCode)||b.ageDays-a.ageDays||a.name.localeCompare(b.name)||a.providerId.localeCompare(b.providerId));
 if(new Set(rows.map(row=>`${row.stationCode}|${row.providerId.toUpperCase()}`)).size!==rows.length)throw new Error("Duplicate station/provider IDs in ID-mapping digest.");
 return {date,month,checkedAt:input.checkedAt,rows,recipients:input.recipients.map(recipient=>({...recipient,pending:rows.filter(row=>recipient.stationIds.includes(row.stationId)).length})).filter(recipient=>recipient.pending>0)};
}

function workbookAttachment(rows:MappingPendingRow[],date:string,email:string){
 const counts=Object.fromEntries(ageKeys.map(key=>[key,rows.filter(row=>row.ageBand===key).length]));
 const stations=[...new Set(rows.map(row=>row.stationCode))].sort().map(station=>{const scoped=rows.filter(row=>row.stationCode===station);return {Station:station,"Unmapped IDs":scoped.length,...Object.fromEntries(ageKeys.map(key=>[key,scoped.filter(row=>row.ageBand===key).length])),"Oldest outbound":scoped.map(row=>row.firstOutboundDate).sort()[0]};});
 const details=rows.map(row=>({Station:row.stationCode,Location:row.stationName,Program:row.program,"Provider ID":row.providerId,"Provider member":row.name,"First outbound":row.firstOutboundDate,"Last outbound":row.lastOutboundDate,"Age (days)":row.ageDays,"Age band":row.ageBand}));
 const workbook=XLSX.utils.book_new(),summary=XLSX.utils.json_to_sheet(stations),detail=XLSX.utils.json_to_sheet(details);summary["!cols"]=[{wch:14},{wch:15},...ageKeys.map(()=>({wch:13})),{wch:18}];detail["!cols"]=[{wch:14},{wch:28},{wch:10},{wch:24},{wch:42},{wch:16},{wch:16},{wch:12},{wch:14}];XLSX.utils.book_append_sheet(workbook,summary,"Station summary");XLSX.utils.book_append_sheet(workbook,detail,"Unmapped IDs");
 const bytes=XLSX.write(workbook,{type:"buffer",bookType:"xlsx"}) as Buffer;const slug=email.split("@")[0].replace(/[^a-zA-Z0-9_-]/g,"_");return {filename:`ID_Mapping_${date}_${slug}.xlsx`,contentType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" as const,content:bytes.toString("base64"),encoding:"base64" as const,counts};
}

export function buildIdMappingDigestMessages(snapshot:MappingDigestSnapshot,subjectTemplate:string):DigestMessage[]{
 const subject=subjectTemplate.replaceAll("{{month}}",monthLabel(snapshot.month).split(" ")[0]).replaceAll("{{year}}",snapshot.month.slice(0,4));if(!subject||/[\r\n]/.test(subject)||/unmapped\s+IDs/i.test(subject))throw new Error("ID-mapping subject must remain stable for the month.");
 return snapshot.recipients.map(recipient=>{const rows=snapshot.rows.filter(row=>recipient.stationIds.includes(row.stationId));const attachment=workbookAttachment(rows,snapshot.date,recipient.email),stationRows=[...new Set(rows.map(row=>row.stationCode))].sort().map(code=>{const scoped=rows.filter(row=>row.stationCode===code);return [code,...ageKeys.map(key=>String(scoped.filter(row=>row.ageBand===key).length)),String(scoped.length)];});const headers=["Station",...ageKeys,"Total"];
  const table=`<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr>${headers.map(header=>`<th style="padding:8px;border:1px solid #334155;background:#17243b;color:white;text-align:left">${esc(header)}</th>`).join("")}</tr></thead><tbody>${stationRows.map((cells,index)=>`<tr style="background:${index%2?"#f8fafc":"white"}">${cells.map((cell,i)=>`<td style="padding:8px;border:1px solid #e2e8f0;${i?"text-align:right":"font-weight:700"}">${esc(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  const text=`TOP PRIORITY · ID mapping\n${rows.length} unmapped IDs across ${stationRows.length} stations in your scope as of ${snapshot.date}.\n\n${headers.join(" | ")}\n${stationRows.map(cells=>cells.join(" | ")).join("\n")}\n\nComplete each mapping in OpsPulse on the same day. Pending or incorrect mapping causes incorrect CPS calculations and affects payments calculated and disbursed live.\n\nOpen OpsPulse: https://ops.dropxlogistics.com/provider-id-mapping\nA fresh recipient-scoped Excel is attached.`;
  const html=`<!doctype html><html><body style="margin:0;background:#eef2f7;font-family:Arial,sans-serif;color:#223148"><table role="presentation" width="100%"><tr><td align="center" style="padding:24px 10px"><table role="presentation" width="720" style="width:100%;max-width:720px;background:white;border-collapse:collapse;border-radius:14px;overflow:hidden"><tr><td style="padding:26px 28px;background:linear-gradient(120deg,#17243b,#78334d);color:white;border-top:5px solid #f45a2a"><div style="font-size:11px;letter-spacing:1.5px;color:#ffb38f;font-weight:700">DROPX · OPSPULSE</div><h1 style="margin:9px 0 4px;font-size:25px">ID mapping · ${esc(monthLabel(snapshot.month))}</h1><p style="margin:0;color:#e5eaf2">Amazon EDSP + XPT · current status ${esc(snapshot.date)}</p></td></tr><tr><td style="padding:24px 28px"><div style="background:#fff1ea;border-left:4px solid #f45a2a;padding:14px 16px;margin-bottom:18px"><strong style="font-size:20px;color:#b54220">${rows.length} unmapped IDs</strong><br><span>${stationRows.length} stations in your permitted scope</span></div><h2 style="font-size:17px">Close today’s mapping pendency</h2><p style="font-size:13px;line-height:1.6">Complete each mapping on the same day. Pending or incorrect mapping causes incorrect CPS calculations and affects payments calculated and disbursed live.</p>${table}<p style="margin:20px 0"><a href="https://ops.dropxlogistics.com/provider-id-mapping" style="display:inline-block;background:#f04d23;color:white;text-decoration:none;padding:12px 18px;border-radius:6px;font-weight:700">Open ID Mapping →</a></p><p style="font-size:12px;color:#64748b">The attached Excel contains only your permitted stations and the current pending IDs. Every update in this calendar month remains in this same email thread.</p></td></tr></table></td></tr></table></body></html>`;
  return {email:recipient.email,name:recipient.name,subject,html,text,attachments:[attachment],scope:{stationIds:[...new Set(rows.map(row=>row.stationId))],reportDate:snapshot.date,unmappedIds:rows.length,threadMode:"monthly"}};
 });
}

export async function loadIdMappingRecipientScope(db:SupabaseClient,companyId:string,domain:string,additionalEmails:string[]=defaultAdditionalEmails){
 const [stations,memberships,roles,profiles]=await Promise.all([
  allRows<MappingDigestStation>(offset=>db.from("stations").select("id,station_code,station_name,hide_from_location_list,providers(code),location_models(code)").eq("company_id",companyId).eq("is_active",true).order("id").range(offset,offset+999)),
  allRows<Membership>(offset=>db.from("company_product_memberships").select("user_id,role_id,product_code,has_all_location_access,location_scope_ids").eq("company_id",companyId).in("product_code",["operations","finance"]).eq("is_active",true).order("id").range(offset,offset+999)),
  allRows<Role>(offset=>db.from("user_roles").select("id,code,location_access_mode").eq("company_id",companyId).eq("is_active",true).order("id").range(offset,offset+999)),
  allRows<Profile>(offset=>db.from("profiles").select("id,full_name,email").eq("company_id",companyId).eq("is_active",true).order("id").range(offset,offset+999))
 ]);return {stations,recipients:resolveMappingDigestRecipients(stations,memberships,roles,profiles,domain,additionalEmails)};
}

export const buildIdMappingDigest:DigestBuilder=async(db,control,date)=>{
 const monthStart=`${date.slice(0,7)}-01`,domain=String(control.config.email_domain||"").toLowerCase(),additional=Array.isArray(control.config.additional_recipient_emails)?control.config.additional_recipient_emails.map(String):defaultAdditionalEmails;
 if(!domain||!control.subject_template)throw new Error("ID-mapping notification configuration is incomplete.");
 const scopePromise=loadIdMappingRecipientScope(db,control.company_id,domain,additional);
 const [scope,mappings,workers,shipments]=await Promise.all([
  scopePromise,
  allRows<MappingRow>(offset=>db.from("field_executive_provider_mappings").select("station_id,provider_member_id,workforce_id,status,effective_to").eq("company_id",control.company_id).order("id").range(offset,offset+999)),
  allRows<{id:string}>(offset=>db.from("workforce").select("id").eq("company_id",control.company_id).is("deleted_at",null).order("id").range(offset,offset+999)),
  allRows<ShipmentRow>(offset=>db.from("cps_shipment_daily").select("station_code,provider_employee_id,provider_employee_name,work_date,amazon_delivery").eq("company_id",control.company_id).eq("client","Amazon").gt("amazon_delivery",0).gte("work_date",monthStart).lte("work_date",date).order("work_date").order("station_code").order("provider_employee_id").range(offset,offset+999))
 ]);
 const checkedAt=new Date().toISOString(),snapshot=buildMappingDigestSnapshot({date,checkedAt,stations:scope.stations,mappings,workforceIds:workers.map(worker=>worker.id),shipments,recipients:scope.recipients});return {checkedAt,messages:buildIdMappingDigestMessages(snapshot,control.subject_template)};
};
