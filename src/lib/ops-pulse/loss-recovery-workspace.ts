import 'server-only';
import { type AuthorizationContext, hasPermission } from '@/lib/authorization';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { readAllRows } from '@/lib/supabase-pagination';
import { nlStationScope, lossContext } from './nl-loss';
import { loadRecoveryLedger } from './nl-recovery-ledger';
import { hasFinalLossOutcome, mayActivateRedispute, mayMarkAlreadyRecovered } from './loss-recovery-controls';
import { isRecoverable, type NlCase, type Recovery } from './nl-loss-policy';
export async function loadRecoveryWorkspace(auth: AuthorizationContext, includeAllCases = false) {
 const {company,stations}=await nlStationScope(auth), codes=stations.map(s=>s.source_code);
 const [context,cases,plans,ledger,redisputes]=await Promise.all([
  lossContext(company,'nl'),
  codes.length ? readAllRows(supabaseAdmin!.from('nl_loss_month_cases').select('*').eq('company_id',company).in('station_code',codes).order('month').order('case_key')) : {data:[],error:null},
  readAllRows(supabaseAdmin!.from('nl_loss_recoveries').select('*').eq('company_id',company).eq('is_deleted',false).order('month').order('case_key')),
  includeAllCases ? {ready:true,lines:[]} : loadRecoveryLedger(auth),
  readAllRows(supabaseAdmin!.from("nl_case_response_windows").select("month,case_key,enabled,workflow_status,recovery_month").eq("company_id",company).order("month").order("case_key")),
 ]);
 if(redisputes.error || cases.error || plans.error || !ledger.ready) throw Error('The recovery queue could not be loaded completely. Retry.');
 const responseByKey=new Map((redisputes.data||[]).map(w=>[`${w.month}|${w.case_key}`,w]));
 const byKey=new Map((plans.data||[]).map(p=>[`${p.month}|${p.case_key}`,p as Recovery]));
 const rows=(cases.data||[]).filter(c=>{
  if(includeAllCases) return true;
  if(byKey.has(`${c.month}|${c.case_key}`)) return true;
  if(!c.source_present) return false;
  if(c.report==='station') return c.source_status==='Approved';
  if(c.report==='slp') return !!c.final_seen_at;
  return isRecoverable(c.source_status,context.settings?.recoverable_statuses||[]) && hasFinalLossOutcome(true,c.source_status,c.details?.case_status,c.details?.extra?.current_sla_stage);
 }).map(c=>({...c,redispute:responseByKey.get(`${c.month}|${c.case_key}`)||null,source_final_nonrecoverable:c.report==="nl" && /^non[ -]?recoverable/i.test(c.source_status) && hasFinalLossOutcome(false,c.source_status,c.details?.case_status,c.details?.extra?.current_sla_stage),amount:Number(c.amount),recovery:byKey.get(`${c.month}|${c.case_key}`)||null})) as NlCase[];
 const canEdit=!auth.readOnly&&hasPermission(auth,'ops_losses','edit');
 return {rows,lines:ledger.lines,outcomes:context.outcomes,settings:context.settings,canEdit,canRecovered:canEdit&&mayMarkAlreadyRecovered(auth),canApprove:mayActivateRedispute(auth)&&hasPermission(auth,'ops_losses','edit')};
}
