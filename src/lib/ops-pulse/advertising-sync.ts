import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { cpsMonthSlices } from "./cps";
import { todayKolkata } from "./cod";
type Insight={ad_id?:string;ad_name?:string;campaign_name?:string;date_start?:string;date_stop?:string;spend?:string;account_currency?:string};
export async function fetchDailyMetaSpend({token,account,version,from,to}:{token:string;account:string;version:string;from:string;to:string}) {
 if(!/^act_\d+$/.test(account)||!/^v\d+\.\d+$/.test(version))throw Error("Check Meta account and API version in Recruit settings.");
 const headers={Authorization:`Bearer ${token}`};
 const info=await fetch(`https://graph.facebook.com/${version}/${account}?fields=currency,timezone_name`,{headers,cache:"no-store",signal:AbortSignal.timeout(45000)});
 const accountInfo=await info.json();
 if(!info.ok||accountInfo.error)throw Error(`Meta account access failed (${accountInfo.error?.code??info.status}). Reconnect Meta in Recruit settings.`);
 if(accountInfo.currency!=="INR"||!["Asia/Kolkata","Asia/Calcutta"].includes(accountInfo.timezone_name))throw Error("Meta account must use INR and India time for daily station costs. Review the account currency/timezone.");
 const query=new URLSearchParams({fields:"ad_id,ad_name,campaign_name,date_start,date_stop,spend,account_currency",level:"ad",time_increment:"1",limit:"500",time_range:JSON.stringify({since:from,until:to})});
 const rows:Insight[]=[];
 let after="";
 const cursors=new Set<string>();
 for(let page=0;page<100;page++) {
  if(after)query.set("after",after);
  const response=await fetch(`https://graph.facebook.com/${version}/${account}/insights?${query}`,{headers,cache:"no-store",signal:AbortSignal.timeout(45000)});
  const payload=await response.json();
  if(!response.ok||payload.error)throw Error(`Meta spend refresh failed (${payload.error?.code??response.status}). Check Meta connection permissions.`);
  if(!Array.isArray(payload.data))throw Error("Meta returned an incomplete daily spend response.");
  rows.push(...payload.data);
  if(!payload.paging?.next) {
   const seen=new Set<string>();
   return rows.map(row=>{
    const date=String(row.date_start??""),id=String(row.ad_id??""),spend=Number(row.spend),key=`${date}|${id}`;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date<from||date>to||row.date_stop!==date||!/^\d+$/.test(id)||!Number.isFinite(spend)||spend<0||row.account_currency!=="INR"||seen.has(key))throw Error("Meta returned invalid or duplicated daily spend. Previous costs retained.");
    seen.add(key);return {spend_date:date,ad_id:id,ad_name:row.ad_name??"",campaign_name:row.campaign_name??"",spend:Math.round(spend*100)/100,currency:"INR"};
   });
  }
  after=payload.paging?.cursors?.after??"";
  if(!after||cursors.has(after))throw Error("Meta pagination was incomplete. Previous costs retained.");
  cursors.add(after);
 }
 throw Error("Meta daily spend exceeded the page limit. Previous costs retained.");
}
export async function syncAdvertising(company:string,month:string) {
 if(!supabaseAdmin)throw Error("Advertising sync unavailable.");
 const db=supabaseAdmin;
 const [settings,meta]=await Promise.all([
 db.from("ops_advertising_settings").select("*").eq("company_id",company).single(),
 db.from("meta_leads_settings").select("is_enabled,ad_account_id,graph_api_version").eq("company_id",company).maybeSingle()]);
 if(settings.error||meta.error)throw Error("Advertising settings unavailable.");
 if(!settings.data.is_enabled)throw Error("Advertising sync is paused in Ops Masters.");
 if(!meta.data?.is_enabled||!meta.data.ad_account_id)throw Error("Connect Meta Leads & Ads in Recruit settings first.");
 const today=todayKolkata();
 if(!/^\d{4}-\d{2}-01$/.test(month)||month<settings.data.start_date.slice(0,7)+"-01"||month>today)throw Error("Choose a month within the configured advertising period.");
 const end=cpsMonthSlices(month,today)[0].to;
 const account=`act_${String(meta.data.ad_account_id).replace(/^act_/,"")}`;
 const claim=await db.rpc("ops_claim_advertising_month",{p_company:company,p_account:account,p_month:month});
 if(claim.error)throw Error("Could not start advertising refresh.");
 if(!claim.data)return {message:"This month is already refreshing.",rows:0};
 try {
  const token=await db.rpc("get_meta_leads_access_token",{company_uuid:company});
  if(token.error||!token.data)throw Error("Meta access token unavailable. Reconnect Meta in Recruit settings.");
  const rawVersion=String(meta.data.graph_api_version||"v25.0");
  const rows=await fetchDailyMetaSpend({token:String(token.data),account,version:rawVersion.startsWith("v")?rawVersion:`v${rawVersion}`,from:month,to:end});
  const saved=await db.rpc("ops_replace_advertising_month",{p_company:company,p_account:account,p_month:month,p_through:end,p_rows:rows});
  if(saved.error)throw Error("Daily advertising spend could not be saved. Previous costs retained.");
  return {message:`Refreshed ${month.slice(0,7)} through ${end}.`,rows:rows.length};
 } catch(e) {
  const message=e instanceof Error?e.message:"Advertising refresh failed.";
  await db.from("ops_advertising_months").update({last_error:message,lease_until:null,checked_at:new Date().toISOString()}).eq("company_id",company).eq("month",month);
  throw Error(message);
 }
}
export async function syncAdvertisingDue() {
 if(!supabaseAdmin)throw Error("Database unavailable.");
 const settings=await supabaseAdmin.from("ops_advertising_settings").select("*").eq("is_enabled",true);
 if(settings.error)throw Error("Advertising settings unavailable.");
 const results=[];
 for(const setting of settings.data??[]) {
  const history=await supabaseAdmin.from("ops_advertising_months").select("month,synced_at,checked_at").eq("company_id",setting.company_id);
  if(history.error)continue;
  const today=todayKolkata(),current=today.slice(0,7)+"-01";
  const months=cpsMonthSlices(setting.start_date.slice(0,7)+"-01",today).map(s=>s.from);
  const last=(month:string)=>history.data?.find(r=>r.month===month);
  const due=(month:string)=>!last(month)?.checked_at||Date.now()-Date.parse(last(month)!.checked_at)>setting.refresh_minutes*60000;
  // Current month first, then one missing/oldest month: backfill and source corrections are bounded.
  const candidates=[current,...months.filter(m=>m!==current).sort((a,b)=>(last(a)?.synced_at??"").localeCompare(last(b)?.synced_at??""))].filter(due).slice(0,2);
  for(const month of candidates)try{results.push(await syncAdvertising(setting.company_id,month));}catch(e){results.push({message:e instanceof Error?e.message:"Sync failed"});}
 }
 return results;
}
