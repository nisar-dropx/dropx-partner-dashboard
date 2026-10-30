import { getAuthorization, hasPermission } from '@/lib/authorization';
import { nlStationScope, lossContext } from '@/lib/ops-pulse/nl-loss';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { mayActivateRedispute, mayMarkAlreadyRecovered } from '@/lib/ops-pulse/loss-recovery-controls';
import { readAllRows } from '@/lib/supabase-pagination';
export const dynamic='force-dynamic';
const reply=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store'}});
export async function GET(request:Request){
 try{
  const auth=await getAuthorization();
  if(!auth||!hasPermission(auth,'ops_losses','access')||!supabaseAdmin)return reply({error:'Access denied.'},403);
  const tid=new URL(request.url).searchParams.get('shipment')?.trim()||'';
  if(!/^[A-Za-z0-9_-]{5,100}$/.test(tid))return reply({error:'Enter a complete Shipment ID.'},400);
  const scope=await nlStationScope(auth),codes=scope.stations.map(s=>s.source_code);
  if(!codes.length)return reply({rows:[]});
  const query=()=>supabaseAdmin!.from('nl_loss_month_cases').select('*').eq('company_id',scope.company).in('station_code',codes);
  // Separate exact predicates avoid interpolating a user value into PostgREST syntax.
  const matches=await Promise.all([readAllRows(query().eq('details->>tid',tid).order('month').order('case_key')),readAllRows(query().eq('case_key',tid).order('month').order('case_key'))]);
  if(matches.some(r=>r.error))throw Error('Shipment loss records could not be loaded.');
  const cases=[...new Map(matches.flatMap(r=>r.data||[]).map(r=>[r.month+'|'+r.case_key,r])).values()];
  if(!cases.length)return reply({rows:[]});
  const months=[...new Set(cases.map(c=>c.month))],keys=[...new Set(cases.map(c=>c.case_key))];
  const [context,plans,windows]=await Promise.all([
   lossContext(scope.company,'nl'),
   readAllRows(supabaseAdmin.from('nl_loss_recoveries').select('*').eq('company_id',scope.company).in('month',months).in('case_key',keys).eq('is_deleted',false).order('month').order('case_key')),
   readAllRows(supabaseAdmin.from('nl_case_response_windows').select('month,case_key,enabled,workflow_status,recovery_month').eq('company_id',scope.company).in('month',months).in('case_key',keys).order('month').order('case_key')),
  ]);
  if(plans.error||windows.error)throw Error('Recovery status could not be loaded.');
  const key=(r:{month:string;case_key:string})=>r.month+'|'+r.case_key;
  const byPlan=new Map((plans.data||[]).map(r=>[key(r),r])),byWindow=new Map((windows.data||[]).map(r=>[key(r),r]));
  const canEdit=!auth.readOnly&&hasPermission(auth,'ops_losses','edit');
  return reply({rows:cases.map(c=>({...c,amount:Number(c.amount),recovery:byPlan.get(key(c))||null,redispute:byWindow.get(key(c))||null})).sort((a,b)=>b.month.localeCompare(a.month)),outcomes:context.outcomes,settings:context.settings,canEdit,canRecovered:canEdit&&mayMarkAlreadyRecovered(auth),canApprove:canEdit&&mayActivateRedispute(auth)});
 }catch(e){return reply({error:e instanceof Error?e.message:'Search could not be completed.'},500);}
}
