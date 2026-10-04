import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { sendEmail } from "@/lib/email";
import { loadAdHocActivity, isAdHocActivityLocation } from "@/lib/ops-pulse/adhoc-activity";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { fleetAdHocRequestType } from "@/lib/fleet-control-adhoc-scope";
import { buildFleetDailyStatusEmail, type FleetDailyStatusSummary as Summary, type FleetDailyStatusVehicle as Vehicle } from "@/lib/fleet/daily-status-email";
import { loadFleetDailyStatusRecipients } from "@/lib/fleet/daily-status-recipients";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const clean = (value: unknown) => String(value ?? "").trim();
const email = (value: unknown) => { const result = clean(value).toLowerCase(); return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(result) ? result : null; };
const active = (status: unknown) => clean(status).toLowerCase() === "active";
const closed = (status: unknown) => ["sold", "disposed", "returned"].includes(clean(status).toLowerCase());
const own = (type: unknown) => !["odcd", "rented", "leased"].includes(clean(type).toLowerCase());
const approved = (status: unknown, source: string) => source === "Cashbook" || ["approved", "final_approved", "processing", "processed", "paid"].includes(clean(status).toLowerCase());
function kolkataParts() { const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()); const value = Object.fromEntries(parts.map((part) => [part.type, part.value])); return { date: `${value.year}-${value.month}-${value.day}`, time: `${value.hour}:${value.minute}` }; }
function inWindow(now: string, configured: string) { const minutes = (value: string) => { const [hour, minute] = value.slice(0, 5).split(":").map(Number); return hour * 60 + minute; }; const delta = minutes(now) - minutes(configured || "20:30"); return delta >= 0 && delta < 30; }

async function processCompany(company: { id: string; name: string | null }, date: string, time: string) {
  if (!supabaseAdmin) return "failed";
  const setting = await supabaseAdmin.from("fleet_control_settings").select("daily_status_email_enabled,daily_status_send_time,daily_status_only_affected").eq("company_id",company.id).maybeSingle();
  if (setting.error || !setting.data?.daily_status_email_enabled || !inWindow(time, clean(setting.data.daily_status_send_time))) return "disabled";
  const existing = await supabaseAdmin.from("fleet_status_report_logs").select("id").eq("company_id",company.id).eq("report_date",date).maybeSingle();
  if (existing.data?.id) return "already_sent";
  const locationsResult = await loadCodLocations(company.id, [], true);
  const locations = locationsResult.locations.filter(isAdHocActivityLocation);
  const activity = await loadAdHocActivity(company.id, locations, date, date);
  const [vehiclesResult, recipientsResult] = await Promise.all([
    supabaseAdmin.from("fleet_vehicles").select("vehicle_no,station_code,model,ownership_type,status,non_operational_since,expected_operational_date,status_comment,status_reason_key").eq("company_id",company.id),
    supabaseAdmin.from("fleet_status_report_recipients").select("name,email,station_codes").eq("company_id",company.id).eq("is_active",true)
  ]);
  if (vehiclesResult.error || recipientsResult.error || activity.error) throw new Error(vehiclesResult.error?.message || recipientsResult.error?.message || activity.error || "Fleet data could not be loaded.");
  const vehicles = ((vehiclesResult.data ?? []) as Vehicle[]).filter(row => !closed(row.status));
  const approvedVans = activity.stations.flatMap(station => station.days.flatMap(day => day.entries.map(entry => ({ station: station.code, entry })))).filter(({entry}) => fleetAdHocRequestType(entry) === "Van" && approved(entry.approvalStatus, entry.source));
  const codes = [...new Set([...vehicles.map(row=>clean(row.station_code).toUpperCase()),...approvedVans.map(row=>row.station)].filter(Boolean))].sort();
  const allRows = codes.map((station): Summary => { const rows=vehicles.filter(row=>clean(row.station_code).toUpperCase()===station); const owned=rows.filter(row=>own(row.ownership_type)); const partner=rows.filter(row=>!own(row.ownership_type)); const ownOperational=owned.filter(row=>active(row.status)).length; const partnerOperational=partner.filter(row=>active(row.status)).length; return {station,ownTotal:owned.length,ownOperational,ownNonOperational:owned.length-ownOperational,partnerTotal:partner.length,partnerOperational,partnerNonOperational:partner.length-partnerOperational,totalNonOperational:rows.filter(row=>!active(row.status)).length,adHocVans:approvedVans.filter(row=>row.station===station).length}; });
  const rows = (setting.data.daily_status_only_affected === false ? allRows : allRows.filter(row=>row.totalNonOperational>0 || row.adHocVans>0))
    .sort((a,b)=>b.totalNonOperational-a.totalNonOperational || b.adHocVans-a.adHocVans || a.station.localeCompare(b.station));
  if (!rows.length) return "no_affected_station";
  const affected = rows.map(row=>row.station);
  const reportStations = locations.filter(location=>affected.includes(clean(location.station_code).toUpperCase()));
  const peopleRecipients = await loadFleetDailyStatusRecipients(supabaseAdmin, company.id, reportStations);
  const defaults = peopleRecipients.filter(row=>row.stationCodes.some(code=>affected.includes(code))).map(row=>row.email);
  const manual = (recipientsResult.data ?? []).flatMap(row => { const scopes=Array.isArray(row.station_codes)?row.station_codes.map((value:string)=>clean(value).toUpperCase()):[]; const address=email(row.email); return address && (!scopes.length || scopes.some((code:string)=>affected.includes(code))) ? [address] : []; });
  const recipients=[...new Set([...defaults,...manual])];
  if (!recipients.length) throw new Error("No People station owner or Fleet status recipient was found for the affected stations.");
  const month=date.slice(0,7); const monthLabel=new Intl.DateTimeFormat("en-IN",{month:"long",year:"numeric",timeZone:"Asia/Kolkata"}).format(new Date(`${month}-01T12:00:00+05:30`));
  const prior=await supabaseAdmin.from("fleet_status_report_logs").select("message_id,root_message_id,subject").eq("company_id",company.id).eq("report_month",month).eq("status","sent").order("created_at",{ascending:false}).limit(1).maybeSingle();
  const subject=prior.data?.subject || `DropX Daily Fleet Update | ${monthLabel}`; const root=prior.data?.root_message_id || prior.data?.message_id || null; const last=prior.data?.message_id || null; const messageId=last?`<dropx.fleet-status.${randomUUID()}@partner.dropxlogistics.com>`:`<dropx.fleet-status.${company.id}.${month}@partner.dropxlogistics.com>`;
  const down=vehicles.filter(row=>!active(row.status)&&affected.includes(clean(row.station_code).toUpperCase())).sort((a,b)=>(a.non_operational_since||date).localeCompare(b.non_operational_since||date));
  const presentation=buildFleetDailyStatusEmail({companyName:company.name,date,rows,exceptions:down});
  const result=await sendEmail({companyId:company.id,to:recipients,subject,body:presentation.text,html:presentation.html,messageId,inReplyTo:last||undefined,references:last?[...new Set([root,last].filter((value):value is string=>Boolean(value)))]:undefined});
  await supabaseAdmin.from("fleet_status_report_logs").insert({company_id:company.id,report_date:date,report_month:month,affected_station_codes:affected,recipients,subject,status:"sent",message_id:result.messageId||messageId,root_message_id:root||result.messageId||messageId});
  return "sent";
}

export async function GET(request: Request) { const secret=process.env.CRON_SECRET?.trim(); if(secret && request.headers.get("authorization")!==`Bearer ${secret}`) return NextResponse.json({error:"Unauthorized"},{status:401}); if(!supabaseAdmin) return NextResponse.json({error:"Database service is unavailable."},{status:500}); const {date,time}=kolkataParts(); const companies=await supabaseAdmin.from("companies").select("id,name").eq("is_active",true); if(companies.error)return NextResponse.json({error:companies.error.message},{status:500}); const totals:Record<string,number>={}; for(const company of companies.data??[]){try{const outcome=await processCompany(company,date,time);totals[outcome]=(totals[outcome]||0)+1;}catch(error){totals.failed=(totals.failed||0)+1; await supabaseAdmin.from("fleet_status_report_logs").upsert({company_id:company.id,report_date:date,report_month:date.slice(0,7),affected_station_codes:[],recipients:[],subject:`DropX Fleet | Daily status | ${date.slice(0,7)}`,status:"failed",error_message:error instanceof Error?error.message:"Unable to send report."},{onConflict:"company_id,report_date"});}} return NextResponse.json({date,time,...totals}); }
