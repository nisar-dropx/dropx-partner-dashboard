import { getAuthorization, hasPermission } from '@/lib/authorization';
import { nlStationScope } from '@/lib/ops-pulse/nl-loss';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { readAllRows } from '@/lib/supabase-pagination';
import { loadPidHistory } from '@/lib/ops-pulse/loss-pid-history-data';
export const dynamic='force-dynamic';
const reply=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store'}});
export async function GET(request:Request) {
  try {
    const auth=await getAuthorization();
    if(!auth || !hasPermission(auth,'ops_losses','access') || !supabaseAdmin) return reply({error:'Access denied.'},403);
    const q=new URL(request.url).searchParams, month=q.get('month')||'', key=q.get('case')||'';
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||!key||key.length>300) return reply({error:'Invalid case.'},400);
    const scope=await nlStationScope(auth), stations=scope.stations.map(s=>s.source_code);
    const selected=await supabaseAdmin.from('nl_loss_month_cases').select('month,case_key,details,station_code').eq('company_id',scope.company).eq('month',month).eq('case_key',key).maybeSingle();
    if(selected.error||!selected.data||!stations.includes(selected.data.station_code)) return reply({error:'Case unavailable or outside your station access.'},403);
    const tid=selected.data.details?.tid;
    let related=supabaseAdmin.from('nl_loss_month_cases').select('month,case_key,station_code').eq('company_id',scope.company).in('station_code',stations);
    related=tid&&!selected.data.details?.tid_approximate?related.eq('details->>tid',tid):related.eq('case_key',key);
    const cases=await readAllRows(related.order('month').order('case_key'));
    if(cases.error) throw Error('Related PID cases could not be loaded.');
    const all=[selected.data,...(cases.data||[])];
    const events=await loadPidHistory(scope.company,all);
    return reply({events,tid:tid||key});
  } catch(e) {return reply({error:e instanceof Error?e.message:'History could not be loaded.'},500);}
}
