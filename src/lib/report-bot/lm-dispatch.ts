import "server-only";
import sharp from "sharp";
import { workbookBuffer } from "@/lib/report-workbook";
import { boardTidSheetRows } from "@/lib/ops-pulse/station-board-tids";
import { dispatchReports, type ReportKey } from "./lm-dispatch-config";
import { istDay, loadDispatchReport, loadTodayEddSnapshot, type TodayEddSnapshot } from "./lm-dispatch-data";
import { reportBotDb, type ReportBotSettings } from "./settings";
import { workerRequest } from "./worker-client";

type Group = { wa_group_id: string; location_id: string|null; company_id: string; workspace: string; is_enabled: boolean; bot_in_group: boolean; mode: string };
type Route = {
  id: string; report: ReportKey; times: string[]; format: string; formats?: string[]; pending_only: boolean;
  mentions: string[]; question: string; updated_at: string; location_id: string|null; group: Group;
  scope_type?: "station"|"region"; source_location_ids?: string[]; source_region_codes?: string[]; source_rule?: string;
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
  const stations = ((result.data || []) as SourceStationRow[]).filter(row=>{
    const model = Array.isArray(row.location_models) ? row.location_models[0] : row.location_models;
    return !row.is_ho && !row.hide_from_location_list && String(model?.code || "").trim().toUpperCase() !== "NOW";
  }).map(({is_ho: _isHo,hide_from_location_list: _hidden,location_models: _models,...row})=>row);
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

function eddOutputs(route:Route, snapshot:TodayEddSnapshot, sources:SourceStation[], header:string, caption:string, day:string):Promise<SendOutput[]> {
  const labels = new Map(sources.map(row=>[row.station_code,row.station_name ? `${row.station_code} · ${row.station_name}` : row.station_code]));
  const active = snapshot.stations.filter(row=>row.count>0);
  const coverage = snapshot.unverifiedStations.length ? `Coverage pending: ${snapshot.unverifiedStations.join(", ")}` : "";
  const formats = route.formats?.length ? route.formats : [route.format === "table" ? "text" : route.format];
  const outputs:SendOutput[] = [];
  const mentions = route.mentions.map(number=>number+"@s.whatsapp.net");
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
            const caption=[route.question,route.mentions.map(number=>"@"+number).join(" ")].filter(Boolean).join("\n");
            outputs=await eddOutputs(route,snapshot,sources,header,caption,day);
            detail=`${snapshot.stations.reduce((sum,row)=>sum+row.count,0)} TIDs · ${sources.length} source station(s)`;
          }
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
