import 'server-only';
import type { AuthorizationContext } from './authorization';
import { lossClusterScope } from './ops-pulse/nl-loss';
import { digestDatabase } from './portal-digest-delivery';
import { readAllRows } from './supabase-pagination';
import { buildLossDailySnapshot, lossCaseKey, type LossSourceCase, type LossPlan, type LossRequest, type LossClaim } from './loss-daily-snapshot';
import type { LedgerLine } from './ops-pulse/nl-recovery-ledger-view';
import type { LiveWindow } from './ops-pulse/nl-dispute-policy';

/** Current records only. Never relabel today's balances as a historical snapshot. */
export async function loadLossDailySnapshot(auth: AuthorizationContext) {
  const {company,stations}=await lossClusterScope(auth);
  if(!stations.length)throw new Error('No permitted loss stations.');
  const db=digestDatabase(),now=new Date(),checkedAt=now.toISOString();
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(now);
  const codes=[...new Set(stations.map(s=>s.source_code))];
  const reports=['nl','slp_initial','slp_final'];
  const [cases,plans,requests,claims,ledger,hrDue,workforceDue,settings,outcomes,liveMonth,...runs]=await Promise.all([
    readAllRows(db.from('nl_loss_month_cases').select('month,case_key,report,station_code,amount,source_status,source_present,data_source,final_seen_at,last_seen_at,source_updated_at,lifecycle_status,lifecycle_note,lifecycle_updated_at,details').eq('company_id',company).in('station_code',codes).order('month').order('case_key')),
    readAllRows(db.from('nl_loss_recoveries').select('month,case_key,approval_status,deduction_timing,deduction_month,source_amount,outcome_code,outcome_label,recovery_mode,remarks,updated_at,updated_by_name,allocations').eq('company_id',company).eq('is_deleted',false).order('month').order('case_key')),
    readAllRows(db.from('nl_dispute_requests').select('month,case_key,status,source_stage,updated_at,updated_by_name,desk_note').eq('company_id',company).order('month').order('case_key')),
    readAllRows(db.from('ops_station_loss_claims').select('reference,station_id,station_code,amount,status,raised_by_name,updated_at,decision_note,incident_date').eq('company_id',company).in('station_id',stations.map(s=>s.id)).in('status',['submitted','returned']).order('id')),
    readAllRows(db.rpc('nl_recovery_ledger',{p_company:company,p_from_month:null,p_ref:null}).in('station_code',codes).order('month').order('case_key').order('employee_ref')),
    readAllRows(db.rpc('nl_loss_recovery_due',{p_company:company,p_salary_month:date.slice(0,7),p_target:'hrms',p_run_id:null}).order('recovery_key')),
    readAllRows(db.rpc('nl_loss_recovery_due',{p_company:company,p_salary_month:date.slice(0,7),p_target:'workforce',p_run_id:null}).order('recovery_key')),
    db.from('nl_loss_sources').select('recoverable_statuses,live_window,live_window_checked_at').eq('company_id',company).maybeSingle(),
    db.from('nl_recovery_outcomes').select('code,allocation_required').eq('company_id',company),
    db.from('nl_loss_month_cases').select('month').eq('company_id',company).eq('report','nl').eq('data_source','live').eq('source_present',true).order('month',{ascending:false}).limit(1).maybeSingle(),
    ...reports.map(report=>db.from('loss_report_runs').select('checked_at,finished_at,status').eq('report',report).in('status',['completed','failed']).order('started_at',{ascending:false}).limit(1).maybeSingle()),
  ]);
  const results=[cases,plans,requests,claims,ledger,hrDue,workforceDue,settings,outcomes,liveMonth,...runs];
  const names=['cases','recovery plans','dispute requests','station claims','payroll ledger','People payroll eligibility','Workforce payroll eligibility','source settings','outcomes','live month','NL refresh','SLP Initial refresh','SLP Final refresh'];
  const failed=results.findIndex(r=>r.error);
  if(failed>=0){console.error('Loss daily snapshot failed',names[failed],results[failed].error);throw new Error(`Current ${names[failed]} could not be loaded completely. No email was sent.`);}
  if(!settings.data)throw new Error('Loss source settings are unavailable. No email was sent.');
  const warnings:string[]=[];
  const sources=runs.map((r,i)=>{
    const at=r.data?.checked_at||r.data?.finished_at||null;
    const name=['NL','SLP Initial','SLP Final'][i];
    if(!at)warnings.push(`${name}: no successful source check is recorded.`);
    else if(r.data?.status==='failed')warnings.push(`${name}: latest source refresh failed; showing last stored records.`);
    else if(now.getTime()-Date.parse(at)>86400000)warnings.push(`${name}: source check is older than 24 hours.`);
    return {name,checkedAt:at};
  });
  sources.push({name:'Amazon deadlines',checkedAt:settings.data.live_window_checked_at||null});
  const scopedKeys=new Set((cases.data||[]).map(lossCaseKey));
  return buildLossDailySnapshot({date,checkedAt,stations,cases:cases.data as LossSourceCase[],
    plans:(plans.data||[]).filter(p=>scopedKeys.has(lossCaseKey(p))) as LossPlan[],
    requests:(requests.data||[]).filter(p=>scopedKeys.has(lossCaseKey(p))) as LossRequest[],
    claims:claims.data as LossClaim[],ledger:ledger.data as LedgerLine[],
    dueLines:[...(hrDue.data||[]),...(workforceDue.data||[])].filter(p=>scopedKeys.has(lossCaseKey(p))),
    window:(settings.data.live_window||{}) as LiveWindow,liveWindowMonth:liveMonth.data?.month||null,
    recoverableStatuses:settings.data.recoverable_statuses||[],
    nonAllocatingOutcomes:(outcomes.data||[]).filter(o=>!o.allocation_required).map(o=>o.code),sources,warnings});
}
