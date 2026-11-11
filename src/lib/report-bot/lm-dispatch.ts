import "server-only";
import { summaryReportSvg, tableReportSvg, reportPngBase64, type CellStyle } from "./lm-report-image";
import { workbookBuffer } from "@/lib/report-workbook";
import { boardTidSheetRows } from "@/lib/ops-pulse/station-board-tids";
import { dsrHeatColor, dsrPctTextColor, pickupPctColor, pickupPctTextColor } from "@/lib/ops-pulse/station-board";
import { compareDispatchRows, dispatchReports, type EodSection, type ReportKey } from "./lm-dispatch-config";
import { istDay, loadAgeingDigest, loadDispatchReport, loadEodDigest, loadTodayEddSnapshot, type AgeingDigest, type EodDigest, type TodayEddSnapshot } from "./lm-dispatch-data";
import { filterDispatchSourceRows } from "./lm-source-scope";
import { resolveBankReminderMentions, resolveRouteMentionNumbers, resolveTeamLeaderMentionNumbers, type MentionManagerPolicy } from "./lm-dispatch-mentions";
import { bankMentionNumbers, bankReminderText } from "./lm-bank-message";
import { eodDsrMentionStations, eodDsrPerformanceCaption } from "./lm-eod-caption";
import { EOD_DOT_PERCENTAGE_COLUMNS, EOD_DOT_VISIBLE_COLUMNS, eodDotTotalRow } from "./lm-eod-dot";
import { reportBotDb, type ReportBotSettings } from "./settings";
import { workerRequest } from "./worker-client";
import { dispatchCaption } from "./lm-dispatch-wording";

type Group = { wa_group_id: string; group_name:string|null; location_id: string|null; company_id: string; workspace: string; is_enabled: boolean; bot_in_group: boolean; mode: string };
type Route = {
  id: string; report: ReportKey; times: string[]; format: string; formats?: string[]; pending_only: boolean;
  mentions: string[]; question: string; updated_at: string; location_id: string|null; group: Group;
  scope_type?: "station"|"region"; source_location_ids?: string[]; source_region_codes?: string[]; source_rule?: string;
  source_model_codes?: string[];
  eod_sections?: EodSection[];
  mention_manager_policy?: MentionManagerPolicy; mention_designation_codes?:string[]; mention_present_designation_codes?: string[]; mention_latest_shift_designation_codes?:string[];
};
type SourceStation = { id:string; station_code:string; station_name:string|null; region:string|null; state:string|null; report_code?:string };
type SourceStationRow = SourceStation & { is_ho:boolean|null; hide_from_location_list:boolean|null; location_models:{code:string|null}|Array<{code:string|null}>|null };
type SendOutput = { key:string; body:Record<string,unknown> };
type DispatchSnapshot = { rows: [string, string | number][]; asOf: string };

function snapshotRowsFromEdd(value: TodayEddSnapshot): [string, string | number][] {
  return value.stations.map(station => [`${station.stationCode} · Today EDD pending`, station.count]);
}

const projection = "*,group:report_bot_groups!inner(wa_group_id,group_name,location_id,company_id,workspace,is_enabled,bot_in_group,mode)";
const linked = (group: Group, company: string) => group && group.company_id === company && group.workspace === "last_mile" && group.mode === "live" && group.is_enabled && group.bot_in_group;
const asIst = (value:string) => new Date(value).toLocaleString("en-IN",{timeZone:"Asia/Kolkata",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})+" IST";

async function photo(title: string, rows: [string,string|number][], rowStyle?: (label:string,value:string|number)=>CellStyle) {
  return reportPngBase64(await summaryReportSvg(title, rows, rowStyle));
}

type PercentageTone = "performance"|"pickup";

function percentageStyle(value:string|number,tone:PercentageTone) {
  const percentage=Number.parseFloat(String(value));
  if(!Number.isFinite(percentage)) return null;
  return tone === "pickup"
    ? {background:pickupPctColor(percentage),color:pickupPctTextColor(percentage)}
    : {background:dsrHeatColor(percentage),color:dsrPctTextColor(percentage)};
}

async function tablePhoto(title:string, columns:string[], rows:Array<Array<string|number>>, percentageColumn:string|readonly string[], tone:PercentageTone) {
  return reportPngBase64(await tableReportSvg(title, columns, rows, percentageColumn, value => percentageStyle(value, tone)));
}

const positive = {background:"#fee2e2",color:"#991b1b"};
const caution = {background:"#fef3c7",color:"#92400e"};
const clear = {background:"#dcfce7",color:"#166534"};
const info = {background:"#dbeafe",color:"#1e40af"};

function numeric(value:string|number) {
  if (typeof value === "number") return value;
  const parsed = Number(String(value).replace(/[^0-9.-]/g,""));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Keep every scheduled report readable at WhatsApp size and make action/clear states obvious. */
function reportValueStyle(report:ReportKey,label:string,value:string|number):CellStyle {
  const lowerLabel=label.toLowerCase(), lowerValue=String(value).trim().toLowerCase();
  if (lowerLabel.includes("dsr") && lowerValue.includes("%")) return percentageStyle(value,"performance");
  if (lowerLabel.includes("pickup") && lowerValue.includes("%")) return percentageStyle(value,"pickup");
  if (/valid|uploaded|complete|matched|clear|yes|done/.test(lowerValue) && !/not valid|not uploaded|incomplete|no/.test(lowerValue)) return clear;
  if (/pending|missing|failed|rejected|overdue|not valid|unavailable/.test(lowerValue)) return positive;
  const amount=numeric(value);
  if (amount === null) return info;
  if (report === "scrub") return amount > 0 ? clear : positive;
  if (["dsr","creturn"].includes(report) && /total|delivered|picked up/.test(lowerLabel)) return info;
  if (["edd","station","ageing","zero","oor","cod","recon","deposit","bank","slip"].includes(report)) return amount > 0 ? positive : clear;
  return amount > 0 ? caution : clear;
}

function splitText(lines:string[], limit=3900) {
  const chunks:string[] = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > limit && current) { chunks.push(current); current = line; }
    else current = next.slice(0,limit);
  }
  if (current) chunks.push(current);
  return chunks;
}

async function routeSources(route:Route, company:string):Promise<SourceStation[]> {
  const db = reportBotDb();
  const scopeType = route.scope_type || "station";
  if (route.report === "eod" && scopeType === "region" && !route.source_model_codes?.length) throw new Error("Choose source models for this regional Final EOD schedule in Last Mile Report Bot master");
  const legacy = route.location_id ? [route.location_id] : [];
  const ids = route.source_location_ids?.length ? route.source_location_ids : legacy;
  let query = db.from("stations").select("id,station_code,station_name,region,state,is_ho,hide_from_location_list,location_models(code)").eq("company_id",company).eq("is_active",true);
  if (scopeType === "region") {
    const regions = (route.source_region_codes || []).filter(Boolean);
    if (!regions.length) throw new Error("No source regions configured");
    query = query.in("region",regions);
  } else {
    if (!ids.length) throw new Error("No source stations configured");
    query = query.in("id",ids);
  }
  const result = await query.order("station_code");
  if (result.error) throw new Error(result.error.message);
  const stations = filterDispatchSourceRows((result.data || []) as SourceStationRow[],route.source_model_codes)
    .map(({is_ho: _isHo,hide_from_location_list: _hidden,location_models: _models,...row})=>row);
  if (!stations.length) throw new Error("Configured source has no active stations");
  if (scopeType === "station" && stations.length !== ids.length) throw new Error("One or more configured source stations are inactive or unavailable");
  if (["cod","recon","deposit","bank","slip"].includes(route.report)) {
    const mapped = await db.from("cod_station_settings")
      .select("location_id,portal_station_code")
      .eq("company_id",company)
      .eq("is_active",true)
      .in("location_id",stations.map(row=>row.id));
    if (mapped.error) throw new Error("COD station mapping unavailable");
    const portalCodes = new Map((mapped.data || []).map(row=>[row.location_id,String(row.portal_station_code || "").trim().toUpperCase()]));
    stations.forEach(row=>{ row.report_code = portalCodes.get(row.id) || row.station_code; });
  }
  return stations;
}

function eddOutputs(route:Route, snapshot:TodayEddSnapshot, sources:SourceStation[], header:string, caption:string, day:string, mentionNumbers:string[]):Promise<SendOutput[]> {
  const labels = new Map(sources.map(row=>[row.station_code,row.station_name ? `${row.station_code} · ${row.station_name}` : row.station_code]));
  const active = snapshot.stations.filter(row=>row.count>0);
  const coverage = snapshot.unverifiedStations.length ? `Coverage pending: ${snapshot.unverifiedStations.join(", ")}` : "";
  const formats = route.formats?.length ? route.formats : [route.format === "table" ? "text" : route.format];
  const outputs:SendOutput[] = [];
  const mentions = mentionNumbers.map(number=>number+"@s.whatsapp.net");
  if (formats.includes("text")) {
    const lines = [header,coverage,...active.flatMap(station=>[`${labels.get(station.stationCode) || station.stationCode}: ${station.count}`, ...station.trackingIds.map(row=>row.trackingId)]),caption].filter(Boolean);
    splitText(lines).forEach((text,index)=>outputs.push({key:`text_${String(index+1).padStart(3,"0")}`,body:{text,...(index===0&&mentions.length?{mentions}:{})}}));
  }
  const pendingRows:[string,string|number][] = active.map(station=>[labels.get(station.stationCode) || station.stationCode,station.count]);
  const tasks:Promise<void>[] = [];
  if (formats.includes("photo")) tasks.push(photo(header,pendingRows,(_label,value)=>numeric(value)!>0?positive:clear).then(image_base64=>{outputs.push({key:"photo",body:{image_base64,mime:"image/png",caption:[caption,coverage].filter(Boolean).join("\n"),...(mentions.length?{mentions}:{})}});}));
  if (formats.includes("excel")) {
    const summary = active.map(station=>({Station:station.stationCode,"Station name":sources.find(row=>row.station_code===station.stationCode)?.station_name || "",Region:sources.find(row=>row.station_code===station.stationCode)?.region || "","Today EDD pending":station.count,"Source verified":"Yes","As of (IST)":asIst(station.asOf)}));
    const tids = active.flatMap(station=>boardTidSheetRows(station.trackingIds));
    const buffer = workbookBuffer([{name:"Station summary",rows:summary},{name:"Tracking IDs",rows:tids}]);
    const scope = route.scope_type === "region" ? (route.source_region_codes || []).join("-") : active.map(row=>row.stationCode).join("-");
    outputs.push({key:"excel",body:{document_base64:buffer.toString("base64"),mime:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",filename:`EDD_${scope.replace(/[^A-Za-z0-9_-]/g,"_")}_${day}.xlsx`,caption:header,...(mentions.length?{mentions}:{})}});
  }
  return Promise.all(tasks).then(()=>outputs.sort((a,b)=>a.key.localeCompare(b.key)));
}

function sumNumeric<T extends Record<string,string|number>>(rows:T[],key:string) {
  return rows.reduce((sum,row)=>sum+(typeof row[key]==="number" ? Number(row[key]) : 0),0);
}

async function eodOutputs(route:Route,digest:EodDigest,region:string,day:string,recognitionNumbers:string[],focusNumbers:string[],staticNumbers:string[]):Promise<SendOutput[]> {
  const dsrTotal=sumNumeric(digest.dsr,"Verified total"),dsrDelivered=sumNumeric(digest.dsr,"Delivered");
  const dsr=[...digest.dsr,{Station:"Grand total","Verified total":dsrTotal,Delivered:dsrDelivered,"Delivery failed":sumNumeric(digest.dsr,"Delivery failed"),Rejected:sumNumeric(digest.dsr,"Rejected"),"On road":sumNumeric(digest.dsr,"On road"),"DSR %":dsrTotal?`${(dsrDelivered/dsrTotal*100).toFixed(1)}%`:"—"}];
  const dot=[...digest.dot,eodDotTotalRow(digest.dot)];
  const cTotal=sumNumeric(digest.creturn,"Total"),cPicked=sumNumeric(digest.creturn,"Picked up");
  const creturn=[...digest.creturn,{Station:"Grand total",Total:cTotal,"Picked up":cPicked,"Pending pickup":sumNumeric(digest.creturn,"Pending pickup"),"Pickup %":cTotal?`${(cPicked/cTotal*100).toFixed(1)}%`:"—"}];
  const dateLabel=new Date(`${day}T00:00:00+05:30`).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric",timeZone:"Asia/Kolkata"});
  const regionLabel=`${region} Region`;
  const dsrTitle=`EOD DSR Report · ${dateLabel} · ${regionLabel}`;
  const dsrCaption=eodDsrPerformanceCaption(dsrTitle,digest.dsr,recognitionNumbers,focusNumbers);
  const dsrMentionNumbers=[...new Set([...staticNumbers,...recognitionNumbers,...focusNumbers])];
  const dsrMentions=dsrMentionNumbers.map(number=>number+"@s.whatsapp.net");
  const configuredSections=new Set<EodSection>(route.eod_sections?.length ? route.eod_sections : ["dsr","dot","creturn"]);
  const tables=[
    {key:"01_dsr",title:dsrTitle,rows:dsr,percentage:"DSR %",tone:"performance" as const,caption:dsrCaption,mentions:dsrMentions},
    {key:"02_dot",title:`EOD DOT · Standard + Premium + Overall · ${dateLabel} · ${regionLabel}`,rows:dot,columns:[...EOD_DOT_VISIBLE_COLUMNS],percentage:[...EOD_DOT_PERCENTAGE_COLUMNS],tone:"performance" as const,caption:`*EOD DOT · Standard + Premium + Overall · ${dateLabel} · ${regionLabel}*`,mentions:[]},
    {key:"03_creturn",title:`EOD C-Return Report · ${dateLabel} · ${regionLabel}`,rows:creturn,percentage:"Pickup %",tone:"pickup" as const,caption:`*EOD C-Return Report · ${dateLabel} · ${regionLabel}*`,mentions:[]},
  ].filter(table=>configuredSections.has(table.key.split("_")[1] as EodSection));
  const outputs:SendOutput[]=[];
  const formats=route.formats?.length?route.formats:[route.format];
  if(formats.includes("photo")) for(const table of tables) {
    const configuredColumns=(table as {columns?:string[]}).columns;
    const columns:string[]=configuredColumns?.length ? configuredColumns : Object.keys(table.rows[0]||{});
    const values=table.rows.map(row=>columns.map(column=>(row as Record<string,string|number>)[column]));
    outputs.push({key:`photo_${table.key}`,body:{image_base64:await tablePhoto(table.title,columns,values,table.percentage,table.tone),mime:"image/png",caption:table.caption,...(table.mentions.length?{mentions:table.mentions}:{})}});
  }
  if(formats.includes("excel")) {
    const sheets=[
      {section:"dsr" as const,name:"Final DSR",rows:dsr},
      {section:"dot" as const,name:"Final DOT",rows:dot},
      {section:"creturn" as const,name:"Final C-Return",rows:creturn},
    ].filter(sheet=>configuredSections.has(sheet.section)).map(({name,rows})=>({name,rows}));
    const buffer=workbookBuffer(sheets);
    outputs.push({key:"excel",body:{document_base64:buffer.toString("base64"),mime:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",filename:`Final_EOD_${region.replace(/[^A-Za-z0-9_-]/g,"_")}_${day}.xlsx`,caption:`*EOD Report · ${dateLabel} · ${regionLabel}*`}});
  }
  return outputs.sort((a,b)=>a.key.localeCompare(b.key));
}

/** Regional live views use the same verified board snapshot as EOD, but keep
 * one report per message and one station per row. Destinations, source scope
 * and times remain entirely route configuration. */
async function livePerformanceOutputs(route:Route,digest:EodDigest,scopeLabel:string,day:string):Promise<{outputs:SendOutput[];snapshot:DispatchSnapshot}> {
  const dateLabel=new Date(`${day}T00:00:00+05:30`).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric",timeZone:"Asia/Kolkata"});
  const stamp=asIst(digest.asOf);
  const formats=route.formats?.length?route.formats:[route.format];
  const outputs:SendOutput[]=[];
  let tableRows:Array<Record<string,string|number>>, columns:string[], percentage:string, tone:PercentageTone, title:string;
  if(route.report==="dsr") {
    const total=sumNumeric(digest.dsr,"Verified total"), delivered=sumNumeric(digest.dsr,"Delivered");
    const inventoryRows=digest.dsr.map(row=>({
      Station:row.Station,
      "EDD at station":digest.stationInventory[row.Station]?.eddAtStation??"—",
      "Physical at station":digest.stationInventory[row.Station]?.physicalAtStation??"—",
      Assigned:row["Verified total"],Delivered:row.Delivered,Failed:row["Delivery failed"],Rejected:row.Rejected,"On road":row["On road"],"DSR %":row["DSR %"],
    }));
    const inventoryValues=Object.values(digest.stationInventory);
    const eddAvailable=inventoryValues.every(row=>row.eddAtStation!==null),physicalAvailable=inventoryValues.every(row=>row.physicalAtStation!==null);
    tableRows=[...inventoryRows,{Station:"Grand total","EDD at station":eddAvailable?inventoryValues.reduce((sum,row)=>sum+Number(row.eddAtStation||0),0):"—","Physical at station":physicalAvailable?inventoryValues.reduce((sum,row)=>sum+Number(row.physicalAtStation||0),0):"—",Assigned:total,Delivered:delivered,Failed:sumNumeric(digest.dsr,"Delivery failed"),Rejected:sumNumeric(digest.dsr,"Rejected"),"On road":sumNumeric(digest.dsr,"On road"),"DSR %":total?`${(delivered/total*100).toFixed(1)}%`:"—"}];
    columns=["Station","EDD at station","Physical at station","Assigned","Delivered","Failed","Rejected","On road","DSR %"];
    percentage="DSR %"; tone="performance"; title=`Live DSR Report · ${dateLabel} · ${scopeLabel} · ${stamp}`;
  } else {
    const total=sumNumeric(digest.creturn,"Total"), picked=sumNumeric(digest.creturn,"Picked up");
    tableRows=[...digest.creturn,{Station:"Grand total",Total:total,"Picked up":picked,"Pending pickup":sumNumeric(digest.creturn,"Pending pickup"),"Pickup %":total?`${(picked/total*100).toFixed(1)}%`:"—"}];
    columns=["Station","Total","Picked up","Pending pickup","Pickup %"];
    percentage="Pickup %"; tone="pickup"; title=`Live C-Return Report · ${dateLabel} · ${scopeLabel} · ${stamp}`;
  }
  const values=tableRows.map(row=>columns.map(column=>row[column]));
  if(formats.includes("photo")) outputs.push({key:"photo",body:{image_base64:await tablePhoto(title,columns,values,percentage,tone),mime:"image/png",caption:`*${title}*`}});
  if(formats.includes("text")) {
    const lines=[`*${title}*`,...tableRows.map(row=>`${row.Station}: ${row[percentage]}`)];
    splitText(lines).forEach((value,index)=>outputs.push({key:`text_${String(index+1).padStart(3,"0")}`,body:{text:value}}));
  }
  if(formats.includes("excel")) {
    const sheets=route.report==="dsr"
      ? [
          {name:"EDD at station",rows:boardTidSheetRows(digest.stationInventoryTracking.edd)},
          {name:"Physical at station",rows:boardTidSheetRows(digest.stationInventoryTracking.physical)},
        ]
      : [{name:"Live C-Return",rows:tableRows}];
    const buffer=workbookBuffer(sheets);
    outputs.push({key:"excel",body:{document_base64:buffer.toString("base64"),mime:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",filename:`${route.report==="dsr"?"Live_DSR_Inventory":"Live_C-Return"}_${scopeLabel.replace(/[^A-Za-z0-9_-]/g,"_")}_${day}.xlsx`,caption:route.report==="dsr"?`${title} · EDD at station and Physical at station tracking IDs`:`${title} · detailed export`}});
  }
  const snapshotRows=tableRows.filter(row=>row.Station!=="Grand total").map(row=>[`${row.Station} · ${percentage}`,row[percentage]] as [string,string|number]);
  return {outputs,snapshot:{rows:snapshotRows,asOf:digest.asOf}};
}

function ageingBucketLabel(bucket:string) {
  if(bucket==="1") return "1 day";
  if(bucket==="14+") return "15+ days";
  return `${bucket} days`;
}

function ageingDays(day:string,edd:string) {
  const report=Date.parse(`${day}T00:00:00+05:30`), due=Date.parse(`${edd}T00:00:00+05:30`);
  return Number.isFinite(report)&&Number.isFinite(due)?Math.max(0,Math.floor((report-due)/86400000)):null;
}

async function ageingOutputs(route:Route,digest:AgeingDigest,scopeLabel:string,day:string):Promise<{outputs:SendOutput[];snapshot:DispatchSnapshot}> {
  const dateLabel=new Date(`${day}T00:00:00+05:30`).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric",timeZone:"Asia/Kolkata"});
  const formats=route.formats?.length?route.formats:[route.format];
  const totals=digest.dayBuckets.map(bucket=>{
    const cells=digest.byStation.map(row=>row.byDay[bucket]||{count:0,amount:0});
    return {bucket,count:cells.reduce((sum,cell)=>sum+cell.count,0),amount:cells.reduce((sum,cell)=>sum+cell.amount,0)};
  });
  const grand={count:totals.reduce((sum,row)=>sum+row.count,0),amount:totals.reduce((sum,row)=>sum+row.amount,0)};
  const title=`Ageing Report · ${dateLabel} · ${scopeLabel} · ${asIst(digest.asOf)}`;
  const summaryRows:[string,string|number][]=totals.flatMap(row=>[[`${ageingBucketLabel(row.bucket)} · TIDs`,row.count],[`${ageingBucketLabel(row.bucket)} · Value`,`₹${row.amount.toLocaleString("en-IN",{maximumFractionDigits:2})}`]]) as [string,string|number][];
  summaryRows.push(["Total TIDs",grand.count],["Total value",`₹${grand.amount.toLocaleString("en-IN",{maximumFractionDigits:2})}`]);
  const outputs:SendOutput[]=[];
  const missing=digest.missingStations.length?`Coverage pending: ${digest.missingStations.join(", ")}`:"";
  if(formats.includes("photo")) outputs.push({key:"photo",body:{image_base64:await photo(title,summaryRows,(label,value)=>{
    if(label.startsWith("1 day")) return caution;
    if(label.startsWith("2-3")) return {background:"#ffedd5",color:"#9a3412"};
    if(label.startsWith("4-7")||label.startsWith("8-14")||label.startsWith("15+")) return positive;
    return numeric(value)!>0?info:clear;
  }),mime:"image/png",caption:[`*${title}*`,missing].filter(Boolean).join("\n")}});
  if(formats.includes("text")) outputs.push({key:"text_001",body:{text:[`*${title}*`,...summaryRows.map(([label,value])=>`${label}: ${value}`),missing].filter(Boolean).join("\n")}});
  if(formats.includes("excel")) {
    const dayRows=digest.byStation.map(row=>({Station:row.stationCode,...Object.fromEntries(digest.dayBuckets.flatMap(bucket=>[[`${ageingBucketLabel(bucket)} TIDs`,row.byDay[bucket]?.count||0],[`${ageingBucketLabel(bucket)} value`,row.byDay[bucket]?.amount||0]])),"Total TIDs":row.total.count,"Total value":row.total.amount}));
    dayRows.push({Station:"Grand total",...Object.fromEntries(totals.flatMap(row=>[[`${ageingBucketLabel(row.bucket)} TIDs`,row.count],[`${ageingBucketLabel(row.bucket)} value`,row.amount]])),"Total TIDs":grand.count,"Total value":grand.amount});
    const weekRows=digest.byStation.map(row=>({Station:row.stationCode,...Object.fromEntries(digest.weekBuckets.flatMap(bucket=>[[`${bucket} TIDs`,row.byWeek[bucket]?.count||0],[`${bucket} value`,row.byWeek[bucket]?.amount||0]])),"Total TIDs":row.total.count,"Total value":row.total.amount}));
    const tidRows=[...digest.trackingIds].sort((a,b)=>a.stationCode.localeCompare(b.stationCode)||a.edd.localeCompare(b.edd)||a.trackingId.localeCompare(b.trackingId)).map(source=>{const row=boardTidSheetRows([source])[0]||{};const days=ageingDays(day,source.edd);return {...row,"Ageing days":days??"","Ageing bucket":days===null?"":days<=1?"1 day":days<=3?"2-3 days":days<=7?"4-7 days":days<=14?"8-14 days":"15+ days"};});
    const sheets=[{name:"Ageing by day",rows:dayRows},...(weekRows.length&&digest.weekBuckets.length?[{name:"Ageing by week",rows:weekRows}]:[]),{name:"Tracking IDs",rows:tidRows}];
    const buffer=workbookBuffer(sheets);
    outputs.push({key:"excel",body:{document_base64:buffer.toString("base64"),mime:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",filename:`Ageing_${scopeLabel.replace(/[^A-Za-z0-9_-]/g,"_")}_${day}.xlsx`,caption:`${title} · bucket summary and row-level tracking IDs`}});
  }
  const snapshotRows=digest.byStation.map(row=>[`${row.stationCode} · Ageing TIDs`,row.total.count] as [string,string|number]);
  return {outputs:outputs.sort((a,b)=>a.key.localeCompare(b.key)),snapshot:{rows:snapshotRows,asOf:digest.asOf}};
}

async function standardOutputs(route:Route, header:string, rows:[string,string|number][], caption:string, day:string):Promise<SendOutput[]> {
  const formats = route.formats?.length ? route.formats : [route.format === "table" ? "text" : route.format];
  const mentions = route.mentions.map(number=>number+"@s.whatsapp.net");
  const outputs:SendOutput[] = [];
  if (formats.includes("text")) {
    const lines = [header,...rows.map(([label,value])=>`${label}: ${value}`),caption].filter(Boolean);
    splitText(lines).forEach((text,index)=>outputs.push({key:`text_${String(index+1).padStart(3,"0")}`,body:{text,...(index===0&&mentions.length?{mentions}:{})}}));
  }
  if (formats.includes("photo")) {
    outputs.push({key:"photo",body:{image_base64:await photo(header,rows,(label,value)=>reportValueStyle(route.report,label,value)),mime:"image/png",caption,...(mentions.length?{mentions}:{})}});
  }
  if (formats.includes("excel")) {
    const buffer = workbookBuffer([{name:"Report",rows:rows.map(([label,value])=>({Metric:label,Value:value}))}]);
    const scope = route.scope_type === "region" ? (route.source_region_codes || []).join("-") : "stations";
    outputs.push({key:"excel",body:{
      document_base64:buffer.toString("base64"),
      mime:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      filename:`${route.report}_${scope.replace(/[^A-Za-z0-9_-]/g,"_")}_${day}.xlsx`,
      caption:header,
      ...(mentions.length?{mentions}:{})
    }});
  }
  return outputs.sort((a,b)=>a.key.localeCompare(b.key));
}

async function reconciliationOutputs(route:Route,header:string,columns:string[],rows:Array<Array<string|number>>,caption:string):Promise<SendOutput[]> {
  const mentions=route.mentions.map(number=>number+"@s.whatsapp.net");
  const image_base64=await reportPngBase64(await tableReportSvg(header,columns,rows,[],()=>info));
  return [{key:"photo",body:{image_base64,mime:"image/png",caption,...(mentions.length?{mentions}:{})}}];
}

async function claimRun(routeId:string,day:string,slot:string) {
  const db = reportBotDb();
  const inserted = await db.from("report_bot_lm_dispatch_runs").insert({route_id:routeId,day,slot}).select("id,status").single();
  if (!inserted.error) return inserted.data as {id:string;status:string};
  if (inserted.error.code !== "23505") throw new Error(inserted.error.message);
  const existing = await db.from("report_bot_lm_dispatch_runs").select("id,status").eq("route_id",routeId).eq("day",day).eq("slot",slot).single();
  if (existing.error) throw new Error(existing.error.message);
  if (["sent","skipped"].includes(existing.data.status)) return null;
  return existing.data as {id:string;status:string};
}

async function previousSnapshot(routeId: string, runId: string): Promise<DispatchSnapshot | null> {
  const result = await reportBotDb().from("report_bot_lm_dispatch_runs")
    .select("snapshot").eq("route_id", routeId).eq("status", "sent").neq("id", runId)
    .not("snapshot", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (result.error) throw new Error(result.error.message);
  return (result.data?.snapshot as DispatchSnapshot | null) ?? null;
}

async function sendOutput(settings:ReportBotSettings,runId:string,groupId:string,output:SendOutput) {
  const db = reportBotDb();
  const inserted = await db.from("report_bot_lm_dispatch_run_outputs").insert({run_id:runId,output_key:output.key}).select("id,status").single();
  let row = inserted.data as {id:string;status:string}|null;
  if (inserted.error?.code === "23505") {
    const existing = await db.from("report_bot_lm_dispatch_run_outputs").select("id,status").eq("run_id",runId).eq("output_key",output.key).single();
    if (existing.error) throw new Error(existing.error.message);
    row = existing.data as {id:string;status:string};
  } else if (inserted.error) throw new Error(inserted.error.message);
  if (!row || row.status === "sent") return;
  try {
    const receipt = await workerRequest<{id:string|null}>(settings,"/send",{method:"POST",timeoutMs:30000,body:{client_ref:row.id,to:groupId,...output.body}});
    if (!receipt?.id) throw new Error("Worker returned no WhatsApp message ID");
    const saved = await db.from("report_bot_lm_dispatch_run_outputs").update({status:"sent",receipt_id:receipt.id,detail:null,updated_at:new Date().toISOString()}).eq("id",row.id);
    if (saved.error) throw new Error(saved.error.message);
  } catch (error) {
    await db.from("report_bot_lm_dispatch_run_outputs").update({status:"failed",detail:String(error instanceof Error?error.message:error).slice(0,400),updated_at:new Date().toISOString()}).eq("id",row.id);
    throw error;
  }
}

export async function dispatchLastMile(settings: ReportBotSettings, deadline: number) {
  if (settings.mode !== "live") return 0;
  const db = reportBotDb(), company = settings.company_id;
  const routes = await db.from("report_bot_lm_dispatch_routes").select(projection).eq("company_id",company).eq("enabled",true);
  if (routes.error) throw new Error(routes.error.message);
  const now = new Date(), day = istDay(now);
  const jobs = (routes.data as unknown as Route[]).filter(route=>linked(route.group,company)).flatMap(route=>route.times.filter(slot=>{
    const due=Date.parse(day+"T"+slot+":00+05:30");
    return +now>=due && +now-due<8*60000 && Date.parse(route.updated_at)<=due;
  }).map(slot=>({route,slot})));
  let claimed=0;
  async function next() {
    while (jobs.length && Date.now()<deadline-30000) {
      const {route,slot}=jobs.shift()!;
      const run=await claimRun(route.id,day,slot);
      if (!run) continue;
      claimed++;
      let status="skipped",detail="No pending items";
      let sentSnapshot: DispatchSnapshot | null = null;
      try {
        const latest=await db.from("report_bot_lm_dispatch_routes").select(projection).eq("id",route.id).eq("enabled",true).eq("updated_at",route.updated_at).maybeSingle();
        if (latest.error) throw new Error(latest.error.message);
        const current=latest.data as unknown as Route|null;
        if (!current || !linked(current.group,company) || current.group.wa_group_id!==route.group.wa_group_id) throw new Error("Group or schedule changed");
        const sources=await routeSources(route,company);
        let outputs:SendOutput[]=[];
        if (route.report==="edd" && route.source_rule!=="current_report") {
          const snapshot=await loadTodayEddSnapshot(sources.map(row=>row.station_code),day);
          if (!snapshot.pending && snapshot.unverifiedStations.length) throw new Error(`Today EDD source is not verified for: ${snapshot.unverifiedStations.join(", ")}`);
          if (route.pending_only && !snapshot.pending) { status="skipped"; detail="Verified Today EDD is clear"; }
          else {
            const scope=route.scope_type==="region" ? (route.source_region_codes||[]).join(", ") : sources.map(row=>row.station_code).join(", ");
            const header=`${scope} · Today EDD pending · ${asIst(snapshot.asOf)}`;
            const pendingSources=sources.filter(source=>snapshot.stations.some(station=>station.stationCode===source.station_code&&station.count>0));
            const mentionNumbers=await resolveRouteMentionNumbers(company,pendingSources,route,day);
            const rows = snapshotRowsFromEdd(snapshot);
            const prior = await previousSnapshot(route.id, run.id);
            const delta = compareDispatchRows(rows, prior?.rows ?? null);
            const deltaText = !prior ? "Baseline report" : delta === "unchanged" ? "No change since last report" : delta === "increased" ? "Increased since last report" : "Improved since last report";
            const caption=await dispatchCaption(settings, route.report, dispatchReports[route.report], deltaText, asIst(snapshot.asOf), `${rows.reduce((sum, [, value]) => sum + (typeof value === "number" ? value : 0), 0)} pending`, route.question, mentionNumbers);
            outputs=await eddOutputs(route,snapshot,sources,header,caption,day,mentionNumbers);
            sentSnapshot={rows,asOf:snapshot.asOf};
            detail=`${snapshot.stations.reduce((sum,row)=>sum+row.count,0)} TIDs · ${sources.length} source station(s)`;
          }
        } else if (route.report==="eod") {
          const digest=await loadEodDigest(sources.map(row=>row.station_code),day);
          const region=route.scope_type==="region"
            ? (route.source_region_codes||[]).join(", ")
            : [...new Set(sources.map(row=>String(row.state||"").trim()).filter(Boolean))].join(", ") || sources.map(row=>row.station_code).join(", ");
          const mentionStations=eodDsrMentionStations(digest.dsr);
          const sourceByCode=new Map(sources.map(source=>[source.station_code.trim().toUpperCase(),source]));
          const recognitionSources=mentionStations.recognition.map(code=>sourceByCode.get(code)).filter((source):source is SourceStation=>Boolean(source));
          const focusSources=mentionStations.focus.map(code=>sourceByCode.get(code)).filter((source):source is SourceStation=>Boolean(source));
          const dynamicRoute={...route,mentions:[]};
          const [recognitionNumbers,focusNumbers,staticNumbers]=await Promise.all([
            recognitionSources.length?resolveTeamLeaderMentionNumbers(company,recognitionSources,day):Promise.resolve([]),
            focusSources.length?resolveRouteMentionNumbers(company,focusSources,dynamicRoute,day):Promise.resolve([]),
            resolveRouteMentionNumbers(company,[],route,day),
          ]);
          outputs=await eodOutputs(route,digest,region,day,recognitionNumbers,focusNumbers,staticNumbers);
          detail=`${region} · ${sources.length} source station(s) · Final DSR + DOT + C-Return`;
        } else if (["dsr","creturn"].includes(route.report) && (route.scope_type==="region" || sources.length>1)) {
          const digest=await loadEodDigest(sources.map(row=>row.station_code),day);
          const pending=route.report==="dsr"
            ? digest.dsr.some(row=>Number.parseFloat(row["DSR %"])<100)
            : digest.creturn.some(row=>Number.parseFloat(row["Pickup %"])<100);
          if(!route.pending_only||pending) {
            const scopeLabel=route.scope_type==="region"
              ? (route.source_region_codes||[]).join(", ")
              : route.group.group_name || [...new Set(sources.map(row=>String(row.state||"").trim()).filter(Boolean))].join(", ") || sources.map(row=>row.station_code).join(", ");
            const live=await livePerformanceOutputs(route,digest,scopeLabel,day);
            outputs=live.outputs; sentSnapshot=live.snapshot;
            detail=`${scopeLabel} · ${sources.length} source station(s) · Live ${dispatchReports[route.report]}`;
          }
        } else if (route.report==="ageing" && (route.scope_type==="region" || sources.length>1)) {
          const digest=await loadAgeingDigest(sources.map(row=>row.station_code),day);
          const pending=digest.byStation.some(row=>row.total.count>0||row.total.amount>0);
          if(!route.pending_only||pending) {
            const scopeLabel=route.scope_type==="region"
              ? (route.source_region_codes||[]).join(", ")
              : route.group.group_name||sources.map(row=>row.station_code).join(", ");
            const regional=await ageingOutputs(route,digest,scopeLabel,day);
            outputs=regional.outputs; sentSnapshot=regional.snapshot;
            detail=`${scopeLabel} · ${sources.length} source station(s) · Ageing summary + row-level Excel`;
          }
        } else {
          const reports=await Promise.all(sources.map(source=>loadDispatchReport(route.report,company,source.id,source.report_code || source.station_code,day)));
          const pending=reports.some(row=>row.pending);
          if ((route.report==="bank" ? pending : !route.pending_only||pending)) {
            const header=`${sources.map(row=>row.station_code).join(", ")} · ${dispatchReports[route.report]} · ${asIst(reports[0].asOf)}`;
            const rows=reports.flatMap((report,index)=>report.rows.map(([label,value]):[string,string|number]=>[sources.length>1?`${sources[index].station_code} · ${label}`:label,value]));
            const prior = await previousSnapshot(route.id, run.id);
            const delta = compareDispatchRows(rows, prior?.rows ?? null);
            const deltaText = !prior ? "Baseline report" : delta === "unchanged" ? "No change since last report" : delta === "increased" ? "Increased since last report" : "Improved since last report";
            const mentionNumbers = route.report==="bank"?[]:await resolveRouteMentionNumbers(company, sources, route, day);
            const caption=await dispatchCaption(settings, route.report, dispatchReports[route.report], deltaText, asIst(reports[0].asOf), rows.map(([label,value])=>`${label}: ${value}`).join("; "), route.question, mentionNumbers);
            if(route.report==="bank") {
              // Parent/XPT groups can contain several source stations. Each gets
              // its own actionable message and its own scoped TL/manager tags.
              outputs=await Promise.all(sources.flatMap((source,index)=>reports[index].pending?[{source,report:reports[index]}]:[]).map(async({source,report})=>{
                const groups=await resolveBankReminderMentions(company,[source],route,day);
                const mentions=bankMentionNumbers(groups).map(number=>number+"@s.whatsapp.net");
                return {key:`bank_${source.id}`,body:{text:bankReminderText(`${source.station_code} · Bank remittance · ${asIst(report.asOf)}`,report.rows,groups),mentions}};
              }));
            } else if(route.report==="recon") {
              const firstTable=reports.find(report=>report.table)?.table;
              const tableRows=reports.flatMap((report,index)=>(report.table?.rows||[]).map(row=>sources.length>1?[sources[index].station_code,...row]:row));
              const columns=firstTable ? (sources.length>1?["Station",...firstTable.columns]:firstTable.columns) : ["DA","Last delivery","90-min due","Pending ₹","TIDs","Age","Status"];
              outputs=await reconciliationOutputs({...route,mentions:mentionNumbers},header,columns,tableRows,caption);
            } else outputs=await standardOutputs({...route,mentions:mentionNumbers},header,rows,caption,day);
            detail=header;
            sentSnapshot={rows,asOf:reports[0].asOf};
          }
        }
        if (outputs.length) {
          for (const output of outputs) await sendOutput(settings,run.id,route.group.wa_group_id,output);
          status="sent";
        }
      } catch(error) { status="unavailable"; detail=error instanceof Error?error.message:"Report unavailable"; }
      const saved=await db.from("report_bot_lm_dispatch_runs").update({status,detail:detail.slice(0,400),snapshot:status === "sent" ? sentSnapshot : null}).eq("id",run.id);
      if(saved.error) throw new Error(saved.error.message);
    }
  }
  await Promise.all(Array.from({length:4},next));
  return claimed;
}
