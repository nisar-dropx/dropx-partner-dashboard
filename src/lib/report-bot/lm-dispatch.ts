import "server-only";
import sharp from "sharp";
import { dispatchReports, type ReportKey } from "./lm-dispatch-config";
import { istDay, loadDispatchReport } from "./lm-dispatch-data";
import { reportBotDb, type ReportBotSettings } from "./settings";
import { workerRequest } from "./worker-client";

type Group = { wa_group_id: string; location_id: string; company_id: string; workspace: string; is_enabled: boolean; bot_in_group: boolean; mode: string };
type Route = { id: string; report: ReportKey; times: string[]; format: string; pending_only: boolean; mentions: string[]; question: string; updated_at: string; location_id: string; group: Group };
const linked = (g: Group, r: Route, company: string) => g && g.company_id === company && g.workspace === "last_mile" && g.location_id === r.location_id && g.mode === "live" && g.is_enabled && g.bot_in_group;
const xml = (s: unknown) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
async function photo(title: string, rows: [string,string|number][]) {
  const body = rows.map(([label,value],i) => {
    const y = 44 + i*30;
    return '<rect y="'+y+'" width="760" height="30" fill="'+(i%2 ? "#f2f5f9" : "#fff")+'"/><text x="14" y="'+(y+21)+'">'+xml(label.slice(0,65))+'</text><text x="745" text-anchor="end" y="'+(y+21)+'">'+xml(value)+'</text>';
  }).join("");
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="760" height="'+(44+rows.length*30)+'" font-family="sans-serif" font-size="16"><rect width="760" height="44" fill="#193456"/><text x="14" y="28" fill="white">'+xml(title)+'</text>'+body+'</svg>';
  return (await sharp(Buffer.from(svg)).png().toBuffer()).toString("base64");
}

export async function dispatchLastMile(settings: ReportBotSettings, deadline: number) {
  if (settings.mode !== "live") return 0;
  const db = reportBotDb(), company = settings.company_id;
  const projection = "*,group:report_bot_groups!inner(wa_group_id,location_id,company_id,workspace,is_enabled,bot_in_group,mode)";
  const routes = await db.from("report_bot_lm_dispatch_routes").select(projection).eq("company_id",company).eq("enabled",true);
  if (routes.error) throw new Error(routes.error.message);
  const now = new Date(), day = istDay(now);
  const jobs = (routes.data as unknown as Route[]).filter(r => linked(r.group,r,company)).flatMap(route => route.times.filter(slot => {
    const due = Date.parse(day+"T"+slot+":00+05:30");
    return +now >= due && +now-due < 8*60000 && Date.parse(route.updated_at) <= due;
  }).map(slot => ({route,slot})));
  let claimed = 0;
  async function next() {
    while (jobs.length && Date.now() < deadline - 30000) {
      const {route,slot} = jobs.shift()!;
      const claim = await db.from("report_bot_lm_dispatch_runs").insert({route_id:route.id,day,slot}).select("id").single();
      if (claim.error?.code === "23505") continue;
      if (claim.error) throw new Error(claim.error.message);
      claimed++;
      let status = "skipped", detail = "No pending items";
      let sending = false;
      try {
        const station = await db.from("stations").select("station_code").eq("company_id",company).eq("id",route.location_id).eq("is_active",true).single();
        if (!station.data) throw new Error("Station mapping unavailable");
        const code = station.data.station_code;
        let sourceCode = code;
        if (["cod","recon","bank","deposit"].includes(route.report)) {
          const mapping = await db.from("cod_station_settings").select("portal_station_code").eq("company_id",company).eq("location_id",route.location_id).eq("is_active",true).maybeSingle();
          if (mapping.error) throw new Error("COD station mapping unavailable");
          sourceCode = mapping.data?.portal_station_code || code;
        }
        const r = await loadDispatchReport(route.report,company,route.location_id,sourceCode,day);
        if (!route.pending_only || r.pending) {
          const header = code+" · "+dispatchReports[route.report]+" · "+new Date(r.asOf).toLocaleString("en-IN",{timeZone:"Asia/Kolkata",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})+" IST";
          const caption = [route.question,route.mentions.map(n => "@"+n).join(" ")].filter(Boolean).join("\n");
          const rows = r.rows.slice(0,60);
          if (rows.length < r.rows.length) rows.push(["Additional rows",r.rows.length-rows.length]);
          const text = [header,...rows.map(([k,v]) => k+(route.format === "table" ? "\t" : ": ")+v),caption].filter(Boolean).join("\n");
          const content = route.format === "photo" ? {image_base64:await photo(header,rows),mime:"image/png",caption} : {text};
          const latest = await db.from("report_bot_lm_dispatch_routes").select(projection).eq("id",route.id).eq("enabled",true).eq("updated_at",route.updated_at).maybeSingle();
          if (latest.error) throw new Error(latest.error.message);
          const current = latest.data as unknown as Route|null;
          if (current && linked(current.group,current,company) && current.group.wa_group_id === route.group.wa_group_id) {
            sending = true;
            const receipt = await workerRequest<{id:string|null}>(settings,"/send",{method:"POST",body:{client_ref:claim.data.id,to:route.group.wa_group_id,mentions:route.mentions.map(n=>n+"@s.whatsapp.net"),...content}});
            if (!receipt?.id) throw new Error("Worker returned no WhatsApp message ID");
            status = "sent"; detail = header;
          } else detail = "Group or schedule changed";
        }
      } catch (e) {
        status = sending ? "send unconfirmed" : "unavailable";
        detail = e instanceof Error ? e.message : "Report unavailable";
      }
      const saved = await db.from("report_bot_lm_dispatch_runs").update({status,detail:detail.slice(0,400)}).eq("id",claim.data.id);
      if (saved.error) throw new Error(saved.error.message);
    }
  }
  await Promise.all(Array.from({length:4},next));
  return claimed;
}
