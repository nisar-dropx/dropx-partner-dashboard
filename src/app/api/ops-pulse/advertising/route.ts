import { getAuthorization,hasPermission } from "@/lib/authorization";
import { cpsScope } from "@/lib/ops-pulse/cps-data";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";
import { mapAdvertising } from "@/lib/ops-pulse/advertising";
import { loadAdvertisingAdMappings } from "@/lib/ops-pulse/advertising-data";
import { syncAdvertising } from "@/lib/ops-pulse/advertising-sync";
export const dynamic="force-dynamic";export const maxDuration=300;
const headers={"Cache-Control":"private, no-store"};
async function context(write=false) {
 const auth=await getAuthorization();
 if(!auth||!hasPermission(auth,"cps_inputs","access")||(write&&(auth.readOnly||!hasPermission(auth,"cps_inputs","edit"))))throw Error("Advertising master permission required.");
 if(!supabaseAdmin)throw Error("Database unavailable.");
 const scope=await cpsScope(auth,{});return {auth,scope,db:supabaseAdmin};
}
export async function GET(request:Request) {
 try {
  const {auth,scope,db}=await context();const month=new URL(request.url).searchParams.get("month")||new Date().toISOString().slice(0,7);
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw Error("Choose a valid month.");
  const from=month+"-01",to=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10);
  const [settings,history,spend,mappings,ads,settlements]=await Promise.all([
   db.from("ops_advertising_settings").select("*").eq("company_id",scope.companyId).maybeSingle(),
   db.from("ops_advertising_months").select("month,through_date,synced_at,last_error").eq("company_id",scope.companyId).order("month",{ascending:false}),
   readAllRows(db.from("ops_advertising_daily").select("account_id,spend_date,ad_id,ad_name,campaign_name,spend,currency,synced_at").eq("company_id",scope.companyId).gte("spend_date",from).lte("spend_date",to).order("spend_date").order("ad_id")),
   readAllRows(db.from("ops_advertising_mappings").select("id,ad_id,station_code,effective_from,effective_to").eq("company_id",scope.companyId).order("id")),
   loadAdvertisingAdMappings(scope.companyId),
   db.from("ops_advertising_settlement_rules").select("*").eq("company_id",scope.companyId).order("cost_label")]);
  if([settings,history,spend,mappings,ads,settlements].some(r=>r.error))throw Error("Advertising master could not be loaded.");
  const allowed=new Set(scope.all.map(l=>l.station_code));
  const rows=mapAdvertising(spend.data??[],mappings.data??[],ads.data??[]).filter(r=>auth.hasAllLocationAccess||allowed.has(r.station_code));
  const visibleAds=(ads.data??[]).filter(a=>auth.hasAllLocationAccess||allowed.has(a.station_code??""));
  return Response.json({settlements:auth.hasAllLocationAccess?settlements.data:[],settings:settings.data,history:history.data,rows,ads:visibleAds,mappings:(mappings.data??[]).filter(m=>auth.hasAllLocationAccess||allowed.has(m.station_code)),stations:scope.all.map(l=>({code:l.station_code,name:l.station_name})),canEdit:!auth.readOnly&&hasPermission(auth,"cps_inputs","edit"),canConfigure:auth.hasAllLocationAccess&&!auth.readOnly&&hasPermission(auth,"cps_inputs","edit")},{headers});
 }catch(e){return Response.json({error:e instanceof Error?e.message:"Unable to load"},{status:400,headers});}
}
export async function POST(request:Request) {
 try {
  const {auth,scope,db}=await context(true);const body=await request.json();
  if(body.action==="sync") {
   if(!auth.hasAllLocationAccess)throw Error("Company-wide advertising sync requires all-location access.");
   return Response.json(await syncAdvertising(scope.companyId,String(body.month)+"-01"),{headers});
  }
  if(body.action==="settlement") {
   if(!auth.hasAllLocationAccess)throw Error("Settlement rules require all-location access.");
   const source=String(body.source??""),label=String(body.cost_label??"").trim(),from=String(body.effective_from??"");
   if(!["Cashbook","Approved payment requests"].includes(source)||!label||label.length>120||!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(from)||typeof body.is_active!=="boolean")throw Error("Check settlement source, label and start month.");
   const saved=await db.from("ops_advertising_settlement_rules").upsert({company_id:scope.companyId,source,cost_label:label,effective_from:from,is_active:body.is_active,updated_at:new Date().toISOString(),updated_by:auth.userId},{onConflict:"company_id,source,cost_label,effective_from"});
   if(saved.error)throw Error("Settlement rule could not be saved.");
  }else if(body.action==="settings") {
   if(!auth.hasAllLocationAccess)throw Error("Company-wide configuration requires all-location access.");
   const start=String(body.start_date??""),minutes=Number(body.refresh_minutes),label=String(body.cost_label??"").trim();
   if(!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(start)||start>new Date().toISOString().slice(0,10)||!Number.isInteger(minutes)||minutes<30||minutes>1440||!label||label.length>120||typeof body.is_enabled!=="boolean")throw Error("Check the start month, refresh interval and cost label.");
   const saved=await db.from("ops_advertising_settings").upsert({company_id:scope.companyId,start_date:start,refresh_minutes:minutes,cost_label:label,is_enabled:body.is_enabled,updated_at:new Date().toISOString(),updated_by:auth.userId});
   if(saved.error)throw Error("Settings could not be saved.");
  }else if(body.action==="mapping"||body.action==="delete_mapping") {
   const ad=String(body.ad_id??""),station=String(body.station_code??""),from=String(body.effective_from??"");
   if(!/^\d+$/.test(ad)||!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(from)||!(scope.all.some(s=>s.station_code===station)||(auth.hasAllLocationAccess&&station==="@corporate")))throw Error("Choose an ad, month and authorized station.");
   // Never allow a station-scoped user to move another station's ad.
   const previous=await db.from("ops_advertising_mappings").select("station_code").eq("company_id",scope.companyId).eq("ad_id",ad);
   const allAds=await loadAdvertisingAdMappings(scope.companyId);
   const original={data:allAds.data.filter(a=>a.meta_ad_id===ad),error:allAds.error};
   const source=await db.from("ops_advertising_daily").select("ad_id").eq("company_id",scope.companyId).eq("ad_id",ad).limit(1);
   if(previous.error||original.error||source.error||(!source.data?.length&&!original.data?.length))throw Error("Ad is unavailable.");
   if(!auth.hasAllLocationAccess&&(!original.data?.length||[...(previous.data??[]),...(original.data??[])].some(r=>!scope.all.some(s=>s.station_code===r.station_code))))throw Error("This ad is outside your station access.");
   const end=new Date(Date.UTC(Number(from.slice(0,4)),Number(from.slice(5,7)),0)).toISOString().slice(0,10);
   const result=body.action==="delete_mapping"?await db.from("ops_advertising_mappings").delete().eq("company_id",scope.companyId).eq("ad_id",ad).eq("effective_from",from):await db.from("ops_advertising_mappings").upsert({company_id:scope.companyId,ad_id:ad,station_code:station,effective_from:from,effective_to:end,updated_by:auth.userId,updated_at:new Date().toISOString()},{onConflict:"company_id,ad_id,effective_from"});
   if(result.error)throw Error("Mapping could not be saved.");
  }else throw Error("Invalid action.");
  return Response.json({message:"Saved. CPS and P&L use this configuration on refresh."},{headers});
 }catch(e){return Response.json({error:e instanceof Error?e.message:"Unable to save"},{status:400,headers});}
}
