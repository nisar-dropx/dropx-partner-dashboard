import { getAuthorization, hasPermission } from "@/lib/authorization";
import { mayActivateRedispute } from "@/lib/ops-pulse/loss-recovery-controls";
import { nlStationScope } from "@/lib/ops-pulse/nl-loss";
import { supabaseAdmin } from "@/lib/supabase-admin";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    if (request.headers.get("origin") && request.headers.get("origin") !== new URL(request.url).origin)
      return Response.json({error:"Invalid origin."}, {status:403});
    const auth = await getAuthorization();
    if (!auth || !mayActivateRedispute(auth) || !hasPermission(auth,"ops_losses","edit") || !hasPermission(auth,"ops_losses","access"))
      return Response.json({error:"Only SLP Manager, Finance Manager, National Head or Managing Partner can finally submit a loss period."},{status:403});
    const body = await request.json();
    if (!['nl','slp'].includes(body.report) || typeof body.period !== 'string' || !body.period.trim() || body.period.length>200 || body.period==='all'
      || !Array.isArray(body.stations) || !body.stations.length || body.stations.length>500 || body.stations.some((s:unknown)=>typeof s!=='string'))
      return Response.json({error:"Choose one loss period and its stations."},{status:400});
    const scope = await nlStationScope(auth);
    const allowed = new Set(scope.stations.map(s=>s.source_code));
    if (body.stations.some((s:string)=>!allowed.has(s))) return Response.json({error:"Station outside your access."},{status:403});
    const {data,error} = await supabaseAdmin!.rpc("nl_loss_close_period", {
      p_company:scope.company,p_report:body.report,p_period:body.period,p_stations:[...new Set(body.stations)],
      p_actor:auth.userId,p_name:auth.fullName||auth.email||"OpsPulse user"
    });
    if (error) throw Error(error.code==='P0001'?error.message:"Final submission failed. Please retry.");
    return Response.json({closed:data},{headers:{"Cache-Control":"no-store"}});
  } catch(e) { return Response.json({error:e instanceof Error?e.message:"Final submission failed."},{status:400}); }
}
