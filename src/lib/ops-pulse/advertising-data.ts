import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";
import { advertisingCosts, mapAdvertising, type AdvertisingDay, type AdvertisingMapping, type AdvertisingMonth } from "./advertising";
export async function loadAdvertising(company:string,from:string,to:string,codes:string[]) {
 if(!supabaseAdmin)throw Error("Advertising cost source unavailable.");
 const db=supabaseAdmin;
 const [settings,rows,months,mappings,ads,settlements]=await Promise.all([
 db.from("ops_advertising_settings").select("*").eq("company_id",company).maybeSingle(),
 readAllRows(db.from("ops_advertising_daily").select("account_id,spend_date,ad_id,ad_name,campaign_name,spend,currency,synced_at").eq("company_id",company).gte("spend_date",from).lte("spend_date",to).order("spend_date").order("ad_id")),
 db.from("ops_advertising_months").select("month,through_date,synced_at,last_error").eq("company_id",company).gte("month",from.slice(0,7)+"-01").lte("month",to),
 readAllRows(db.from("ops_advertising_mappings").select("ad_id,station_code,effective_from,effective_to").eq("company_id",company).lte("effective_from",to).order("id")),
 loadAdvertisingAdMappings(company),
 db.from("ops_advertising_settlement_rules").select("source,cost_label,effective_from,is_active").eq("company_id",company).lte("effective_from",to)]);
 if([settings,rows,months,mappings,ads,settlements].some(r=>r.error))throw Error("Advertising spend could not be loaded. Please retry.");
 if(!settings.data)return {breakup:[],gaps:[],rows:[],settlements:[]};
 return {...advertisingCosts({rows:mapAdvertising(rows.data as AdvertisingDay[],mappings.data as AdvertisingMapping[],ads.data??[]),months:months.data as AdvertisingMonth[],codes,from,to,start:settings.data.start_date,label:settings.data.cost_label,enabled:settings.data.is_enabled,refreshMinutes:settings.data.refresh_minutes}),settlements:settlements.data??[]};
}

// Recruit's current register owns routing. Legacy mappings are used only for ads
// not present in that register; an explicitly unresolved current ad stays unresolved.
export async function loadAdvertisingAdMappings(company:string) {
 if(!supabaseAdmin)throw Error("Advertising source unavailable.");const db=supabaseAdmin;
 const [current,legacy,locations,stations]=await Promise.all([
  readAllRows(db.from("recruitment_ads").select("meta_ad_id,ad_name,location_id").eq("company_id",company).order("id")),
  readAllRows(db.from("lead_ads").select("meta_ad_id,ad_name,station_code").eq("company_id",company).order("id")),
  readAllRows(db.from("recruitment_locations").select("id,code,station_id").eq("company_id",company).order("id")),
  readAllRows(db.from("stations").select("id,station_code").eq("company_id",company).order("id"))]);
 if([current,legacy,locations,stations].some(r=>r.error))throw Error("Recruit ad station mappings unavailable.");
 const byId=new Map((stations.data??[]).map(s=>[s.id,s.station_code]));
 const known=new Set((stations.data??[]).map(s=>s.station_code));
 const loc=new Map((locations.data??[]).map(l=>[l.id,l.station_id?byId.get(l.station_id)??null:known.has(l.code)?l.code:null]));
 const ids=new Set((current.data??[]).map(a=>a.meta_ad_id));
 return {data:[...(current.data??[]).map(a=>({meta_ad_id:a.meta_ad_id,ad_name:a.ad_name,station_code:loc.get(a.location_id)??null})),...(legacy.data??[]).filter(a=>!ids.has(a.meta_ad_id)).map(a=>({...a,station_code:known.has(a.station_code)?a.station_code:null}))],error:null};
}
