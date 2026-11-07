import { getAuthorization, hasPermission } from '@/lib/authorization';
import { nlStationScope } from '@/lib/ops-pulse/nl-loss';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { readAllRows } from '@/lib/supabase-pagination';
export const dynamic = 'force-dynamic';
const reply = (body: unknown, status = 200) => Response.json(body, {status, headers: {'Cache-Control':'private, no-store'}});
export async function POST(request: Request) {
  try {
    const auth = await getAuthorization();
    if (!auth || !hasPermission(auth,'ops_losses','access') || !supabaseAdmin) return reply({error:'Access denied.'},403);
    const body = await request.json();
    if (!Array.isArray(body.cases) || !body.cases.length || body.cases.length > 100 || body.cases.some((c:any)=>!/^\d{4}-(0[1-9]|1[0-2])$/.test(c.month)||typeof c.caseKey!=='string'||!c.caseKey||c.caseKey.length>300)) return reply({error:'Invalid cases.'},400);
    const scope = await nlStationScope(auth), stations = scope.stations.map(s=>s.source_code);
    if (!stations.length) return reply({rows:[]});
    const months = [...new Set<string>(body.cases.map((c:any)=>c.month))], keys = [...new Set<string>(body.cases.map((c:any)=>c.caseKey))];
    const requested = new Set(body.cases.map((c:any)=>`${c.month}|${c.caseKey}`));
    const cases = await readAllRows(supabaseAdmin.from('nl_loss_month_cases').select('month,case_key,station_code,report,details').eq('company_id',scope.company).in('station_code',stations).in('month',months).in('case_key',keys).order('month').order('case_key'));
    if(cases.error) throw Error('Loss cases could not be loaded.');
    const allowed = new Map((cases.data||[]).filter(c=>requested.has(`${c.month}|${c.case_key}`)).map(c=>[`${c.month}|${c.case_key}`,c]));
    const results = await Promise.all([
      readAllRows(supabaseAdmin.from('nl_payout_dispute_adjustments').select('*').eq('company_id',scope.company).eq('treatment','write_off').in('month',months).in('case_key',keys).order('created_at').order('recovery_key')),
      readAllRows(supabaseAdmin.from('nl_recovery_waivers').select('*').eq('company_id',scope.company).in('month',months).in('case_key',keys).order('created_at').order('employee_ref')),
    ]);
    if(results.some(r=>r.error)) throw Error('Write-off history could not be loaded.');
    const rows = results.flatMap((r,source)=>(r.data||[]).filter(a=>allowed.has(`${a.month}|${a.case_key}`)).map(a=>({...a,source:source?'waiver':'dispute',station:allowed.get(`${a.month}|${a.case_key}`)!.station_code,tid:allowed.get(`${a.month}|${a.case_key}`)!.details?.tid||a.case_key})));
    const ids = [...new Set(rows.map(r=>r.dispute_id).filter(Boolean))];
    let events:any[]=[];
    for(let i=0;i<ids.length;i+=100){
      const history=await readAllRows(supabaseAdmin.from('workforce_payout_dispute_events').select('id,dispute_id,actor_name,created_at,event_type,from_status,to_status,message,metadata').eq('company_id',scope.company).in('dispute_id',ids.slice(i,i+100)).order('created_at').order('id'));
      if(history.error) throw Error('Dispute history could not be loaded.');
      events.push(...history.data||[]);
    }
    return reply({rows:rows.map(r=>({...r,events:events.filter(e=>e.dispute_id===r.dispute_id)}))});
  } catch {return reply({error:'Write-off history could not be loaded. Please retry.'},500);}
}
