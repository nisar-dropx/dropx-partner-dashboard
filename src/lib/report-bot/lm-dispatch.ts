import "server-only";
import sharp from "sharp";
import { workbookBuffer } from "@/lib/report-workbook";
import { boardTidSheetRows } from "@/lib/ops-pulse/station-board-tids";
import { dsrHeatColor, dsrPctTextColor, pickupPctColor, pickupPctTextColor } from "@/lib/ops-pulse/station-board";
import { dispatchReports, type ReportKey } from "./lm-dispatch-config";
import { istDay, loadDispatchReport, loadEodDigest, loadTodayEddSnapshot, type EodDigest, type TodayEddSnapshot } from "./lm-dispatch-data";
import { filterDispatchSourceRows } from "./lm-source-scope";
import { resolveRouteMentionNumbers, type MentionManagerPolicy } from "./lm-dispatch-mentions";
import { eodDsrMentionStations, eodDsrPerformanceCaption } from "./lm-eod-caption";
import { reportBotDb, type ReportBotSettings } from "./settings";
import { workerRequest } from "./worker-client";

type Group = { wa_group_id: string; location_id: string|null; company_id: string; workspace: string; is_enabled: boolean; bot_in_group: boolean; mode: string };
type Route = {
  id: string; report: ReportKey; times: string[]; format: string; formats?: string[]; pending_only: boolean;
  mentions: string[]; question: string; updated_at: string; location_id: string|null; group: Group;
  scope_type?: "station"|"region"; source_location_ids?: string[]; source_region_codes?: string[]; source_rule?: string;
  source_model_codes?: string[];
  mention_manager_policy?: MentionManagerPolicy; mention_present_designation_codes?: string[];
};
type SourceStation = { id:string; station_code:string; station_name:string|null; region:string|null; report_code?:string };
type SourceStationRow = SourceStation & { is_ho:boolean|null; hide_from_location_list:boolean|null; location_models:{code:string|null}|Array<{code:string|null}>|null };
type SendOutput = { key:string; body:Record<string,unknown> };

const projection = "*,group:report_bot_groups!inner(wa_group_id,location_id,company_id,workspace,is_enabled,bot_in_group,mode)";
const linked = (group: Group, company: string) => group && group.company_id === company && group.workspace === "last_mile" && group.mode === "live" && group.is_enabled && group.bot_in_group;
const xml = (value: unknown) => String(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const asIst = (value:string) => new Date(value).toLocaleString("en-IN",{timeZone:"Asia/Kolkata",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})+" IST";

async function photo(title: string, rows: [string,string|number][]) {
  const visible = rows.slice(0,70);
  if (visible.length < rows.length) visible.push(["Additional stations",rows.length-visible.length]);
  const body = visible.map(([label,value],index) => {
    const y = 50 + index*34;
    return '<rect y="'+y+'" width="900" height="34" fill="'+(index%2 ? "#f2f5f9" : "#fff")+'"/><text x="18" y="'+(y+23)+'">'+xml(label.slice(0,75))+'</text><text x="875" text-anchor="end" y="'+(y+23)+'" font-weight="700">'+xml(value)+'</text>';
  }).join("");
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="'+(50+visible.length*34)+'" font-family="Arial,sans-serif" font-size="18"><rect width="900" height="50" fill="#193456"/><text x="18" y="32" fill="white" font-weight="700">'+xml(title)+'</text>'+body+'</svg>';
  return (await sharp(Buffer.from(svg)).png().toBuffer()).toString("base64");
}

type PercentageTone = "performance"|"pickup";

function percentageStyle(value:string|number,tone:PercentageTone) {
  const percentage=Number.parseFloat(String(value));
  if(!Number.isFinite(percentage)) return null;
  return tone === "pickup"
    ? {background:pickupPctColor(percentage),color:pickupPctTextColor(percentage)}
    : {background:dsrHeatColor(percentage),color:dsrPctTextColor(percentage)};
}

async function tablePhoto(title:string, columns:string[], rows:Array<Array<string|number>>, percentageColumn:string, tone:PercentageTone) {
  const columnWidth = Math.max(102,Math.min(158,Math.floor(1264/columns.length)));
  const width = Math.max(760,columns.length*columnWidth);
  const rowHeight = 29, titleHeight = 45;
  const allRows = rows.slice(0,55);
  const header = columns.map((label,index)=>{
    const align=index===0?"start":"middle",x=index===0?index*columnWidth+8:index*columnWidth+columnWidth/2;
    return `<rect x="${index*columnWidth}" y="${titleHeight}" width="${columnWidth}" height="${rowHeight}" fill="#dce8f6"/><text x="${x}" y="${titleHeight+20}" text-anchor="${align}" font-weight="700">${xml(label.slice(0,22))}</text>`;
  }).join("");
  const body = allRows.map((row,rowIndex)=>row.map((value,columnIndex)=>{
    const y=titleHeight+rowHeight*(rowIndex+1),align=columnIndex===0?"start":"middle",x=columnIndex===0?columnIndex*columnWidth+10:columnIndex*columnWidth+columnWidth/2;
    const total=rowIndex===allRows.length-1;
    const style=!total&&columns[columnIndex]===percentageColumn?percentageStyle(value,tone):null;
    const background=style?.background || (total?"#e8eef6":rowIndex%2 ? "#f6f8fb":"#fff");
    const color=style?.color || "#172033";
    return `<rect x="${columnIndex*columnWidth}" y="${y}" width="${columnWidth}" height="${rowHeight}" fill="${background}"/><text x="${x}" y="${y+20}" text-anchor="${align}" fill="${color}"${total||style?' font-weight="700"':""}>${xml(value)}</text>`;
  }).join("")).join("");
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${titleHeight+rowHeight*(allRows.length+1)}" font-family="Arial,sans-serif" font-size="13"><rect width="${width}" height="${titleHeight}" fill="#193456"/><text x="12" y="29" fill="white" font-size="17" font-weight="700">${xml(title)}</text>${header}${body}</svg>`;
  return (await sharp(Buffer.from(svg)).png().toBuffer()).toString("base64");
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
  if (route.report === "eod" && !route.source_model_codes?.length) throw new Error("Choose source models for Final EOD in Last Mile Report Bot master");
  const legacy = route.location_id ? [route.location_id] : [];
  const ids = route.source_location_ids?.length ? route.source_location_ids : legacy;
  let query = db.from("stations").select("id,station_code,station_name,region,is_ho,hide_from_location_list,location_models(code)").eq("company_id",company).eq("is_active",true);
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
  if (["cod","recon","deposit","bank"].includes(route.report)) {
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
  if (formats.includes("photo")) tasks.push(photo(header,pendingRows).then(image_base64=>{outputs.push({key:"photo",body:{image_base64,mime:"image/png",caption:[caption,coverage].filter(Boolean).join("\n"),...(mentions.length?{mentions}:{})}});}));
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
  const dotValid=digest.dot.filter(row=>typeof row["Verified eligible"]==="number"),dotEligible=sumNumeric(dotValid,"Verified eligible"),dotDelivered=sumNumeric(dotValid,"Delivered");
  const dot=[...digest.dot,{Station:"Grand total","Verified eligible":dotEligible,Dispatched:sumNumeric(dotValid,"Dispatched"),"At station":sumNumeric(dotValid,"At station"),"On road":sumNumeric(dotValid,"On road"),Delivered:dotDelivered,Failed:sumNumeric(dotValid,"Failed"),Rejected:sumNumeric(dotValid,"Rejected"),"DOT %":dotEligible?`${(dotDelivered/dotEligible*100).toFixed(1)}%`:"—"}];
  const cTotal=sumNumeric(digest.creturn,"Total"),cPicked=sumNumeric(digest.creturn,"Picked up");
  const creturn=[...digest.creturn,{Station:"Grand total",Total:cTotal,"Picked up":cPicked,"Pending pickup":sumNumeric(digest.creturn,"Pending pickup"),"Pickup %":cTotal?`${(cPicked/cTotal*100).toFixed(1)}%`:"—"}];
  const dateLabel=new Date(`${day}T00:00:00+05:30`).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric",timeZone:"Asia/Kolkata"});
  const regionLabel=`${region} Region`;
  const dsrTitle=`EOD DSR Report · ${dateLabel} · ${regionLabel}`;
  const dsrCaption=eodDsrPerformanceCaption(dsrTitle,digest.dsr,recognitionNumbers,focusNumbers);
  const dsrMentionNumbers=[...new Set([...staticNumbers,...recognitionNumbers,...focusNumbers])];
  const dsrMentions=dsrMentionNumbers.map(number=>number+"@s.whatsapp.net");
  const tables=[
    {key:"01_dsr",title:dsrTitle,rows:dsr,percentage:"DSR %",tone:"performance" as const,caption:dsrCaption,mentions:dsrMentions},
    {key:"02_dot",title:`EOD DOT Report · ${dateLabel} · ${regionLabel}`,rows:dot,percentage:"DOT %",tone:"performance" as const,caption:`*EOD DOT Report · ${dateLabel} · ${regionLabel}*`,mentions:[]},
    {key:"03_creturn",title:`EOD C-Return Report · ${dateLabel} · ${regionLabel}`,rows:creturn,percentage:"Pickup %",tone:"pickup" as const,caption:`*EOD C-Return Report · ${dateLabel} · ${regionLabel}*`,mentions:[]},
  ];
  const outputs:SendOutput[]=[];
  const formats=route.formats?.length?route.formats:[route.format];
  if(formats.includes("photo")) for(const table of tables) {
    const columns=Object.keys(table.rows[0]||{}),values=table.rows.map(row=>columns.map(column=>(row as Record<string,string|number>)[column]));
    outputs.push({key:`photo_${table.key}`,body:{image_base64:await tablePhoto(table.title,columns,values,table.percentage,table.tone),mime:"image/png",caption:table.caption,...(table.mentions.length?{mentions:table.mentions}:{})}});
  }
  if(formats.includes("excel")) {
    const buffer=workbookBuffer([{name:"Final DSR",rows:dsr},{name:"Final DOT",rows:dot},{name:"Final C-Return",rows:creturn}]);
    outputs.push({key:"excel",body:{document_base64:buffer.toString("base64"),mime:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",filename:`Final_EOD_${region.replace(/[^A-Za-z0-9_-]/g,"_")}_${day}.xlsx`,caption:`*EOD Report · ${dateLabel} · ${regionLabel}*`}});
  }
  return outputs.sort((a,b)=>a.key.localeCompare(b.key));
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
    outputs.push({key:"photo",body:{image_base64:await photo(header,rows),mime:"image/png",caption,...(mentions.length?{mentions}:{})}});
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
            const caption=[route.question,mentionNumbers.map(number=>"@"+number).join(" ")].filter(Boolean).join("\n");
            outputs=await eddOutputs(route,snapshot,sources,header,caption,day,mentionNumbers);
            detail=`${snapshot.stations.reduce((sum,row)=>sum+row.count,0)} TIDs · ${sources.length} source station(s)`;
          }
        } else if (route.report==="eod") {
          if(route.scope_type!=="region") throw new Error("Final EOD requires regional scope.");
          const digest=await loadEodDigest(sources.map(row=>row.station_code),day);
          const region=(route.source_region_codes||[]).join(", ");
          const mentionStations=eodDsrMentionStations(digest.dsr);
          const sourceByCode=new Map(sources.map(source=>[source.station_code.trim().toUpperCase(),source]));
          const recognitionSources=mentionStations.recognition.map(code=>sourceByCode.get(code)).filter((source):source is SourceStation=>Boolean(source));
          const focusSources=mentionStations.focus.map(code=>sourceByCode.get(code)).filter((source):source is SourceStation=>Boolean(source));
          const dynamicRoute={...route,mentions:[]};
          const [recognitionNumbers,focusNumbers,staticNumbers]=await Promise.all([
            recognitionSources.length?resolveRouteMentionNumbers(company,recognitionSources,dynamicRoute,day):Promise.resolve([]),
            focusSources.length?resolveRouteMentionNumbers(company,focusSources,dynamicRoute,day):Promise.resolve([]),
            resolveRouteMentionNumbers(company,[],route,day),
          ]);
          outputs=await eodOutputs(route,digest,region,day,recognitionNumbers,focusNumbers,staticNumbers);
          detail=`${region} · ${sources.length} source station(s) · Final DSR + DOT + C-Return`;
        } else {
          const reports=await Promise.all(sources.map(source=>loadDispatchReport(route.report,company,source.id,source.report_code || source.station_code,day)));
          const pending=reports.some(row=>row.pending);
          if (!route.pending_only||pending) {
            const header=`${sources.map(row=>row.station_code).join(", ")} · ${dispatchReports[route.report]} · ${asIst(reports[0].asOf)}`;
            const rows=reports.flatMap((report,index)=>report.rows.map(([label,value]):[string,string|number]=>[sources.length>1?`${sources[index].station_code} · ${label}`:label,value]));
            const caption=[route.question,route.mentions.map(number=>"@"+number).join(" ")].filter(Boolean).join("\n");
            outputs=await standardOutputs(route,header,rows,caption,day); detail=header;
          }
        }
        if (outputs.length) {
          for (const output of outputs) await sendOutput(settings,run.id,route.group.wa_group_id,output);
          status="sent";
        }
      } catch(error) { status="unavailable"; detail=error instanceof Error?error.message:"Report unavailable"; }
      const saved=await db.from("report_bot_lm_dispatch_runs").update({status,detail:detail.slice(0,400)}).eq("id",run.id);
      if(saved.error) throw new Error(saved.error.message);
    }
  }
  await Promise.all(Array.from({length:4},next));
  return claimed;
}
