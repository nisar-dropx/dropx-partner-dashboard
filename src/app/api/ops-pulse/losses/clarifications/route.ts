import { getAuthorization, hasPermission } from "@/lib/authorization";
import { mayActivateRedispute, mayViewLossApprovals } from "@/lib/ops-pulse/loss-recovery-controls";
import { nlStationScope } from "@/lib/ops-pulse/nl-loss";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";
export const dynamic="force-dynamic";
const reply=(data:unknown,status=200)=>Response.json(data,{status,headers:{"Cache-Control":"private, no-store"}});
async function context(edit=false){
 const auth=await getAuthorization();
 if(!auth || !hasPermission(auth,"ops_losses",edit?"edit":"access") || !(edit?mayActivateRedispute(auth):mayViewLossApprovals(auth))) throw Error("Only the authorised loss review team can access associate questions.");
 return {auth,...await nlStationScope(auth)};
}
export async function GET(){try{
 const ctx=await context(),codes=ctx.stations.map(s=>s.source_code);
 if(!codes.length)return reply({questions:[]});
 const result=await readAllRows(supabaseAdmin!.from("nl_loss_clarifications").select("id,month,case_key,raised_by_name,note,status,version,decision_note,decided_by_name,created_at,nl_loss_month_cases!inner(station_code)").eq("company_id",ctx.company).in("nl_loss_month_cases.station_code",codes).in("status",["submitted","returned"]).order("created_at").order("id"));
 if(result.error)throw Error("Unable to load associate questions.");
 return reply({questions:result.data});
}catch(e){return reply({error:e instanceof Error?e.message:"Unable to load questions."},403);}}
export async function POST(request:Request){try{
 if(request.headers.get("origin") && request.headers.get("origin")!==new URL(request.url).origin)return reply({error:"Invalid origin."},403);
 const ctx=await context(true),body=await request.json(),note=String(body.note||"").trim();
 if(!Number.isInteger(body.version)||note.length<10||note.length>4000||typeof body.id!=="string")return reply({error:"A current version and a reply of 10–4000 characters are required."},400);
 const q=await supabaseAdmin!.from("nl_loss_clarifications").select("id,raised_by,nl_loss_month_cases!inner(station_code)").eq("company_id",ctx.company).eq("id",body.id).maybeSingle();
 const relation=q.data?.nl_loss_month_cases as unknown as {station_code:string}|{station_code:string}[];
 const station=Array.isArray(relation)?relation[0]?.station_code:relation?.station_code;
 if(q.error||!q.data||!ctx.stations.some(s=>s.source_code===station)||q.data.raised_by===ctx.auth.userId)throw Error("This question needs an independent reviewer within the station scope.");
 const result=await supabaseAdmin!.rpc("nl_loss_clarification_resolve",{p_company:ctx.company,p_id:body.id,p_action:"resolve",p_version:body.version,p_actor:ctx.auth.userId,p_name:ctx.auth.fullName||ctx.auth.email||"Loss review team",p_note:note});
 if(result.error)throw Error(result.error.code==="P0001"?result.error.message:"Reply could not be saved.");
 return reply({ok:true});
}catch(e){return reply({error:e instanceof Error?e.message:"Unable to reply."},403);}}
