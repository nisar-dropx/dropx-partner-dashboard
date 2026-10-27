import type { NlCase } from './nl-loss-policy';
import type { LedgerLine } from './nl-recovery-ledger-view';
export const RECOVERY_QUEUE_LABELS: Record<string, string> = {
 redispute_pending:'Redispute · recovery paused', redispute_won:'Redispute won · recovery stopped', source_cleared:'Source non-recoverable', update: 'Update required', returned: 'Returned for update', approval: 'Awaiting final approval',
 carried: 'Carried forward', due: 'Due this month', scheduled: 'Scheduled later', review: 'Needs review',
 exit: 'Person left · outstanding', recovered: 'Recovered', written_off: 'Written off',
};
export function indiaMonth(now = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Kolkata', year:'numeric', month:'2-digit' }).format(now).split('-').slice(0,2).join('-'); }
function nextMonth(month: string, n = 1) { const d=new Date(`${month}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth()+n); return d.toISOString().slice(0,7); }
export function recoveryQueueState(row: NlCase, lines: LedgerLine[], period: string) {
 const plan=row.recovery && !row.recovery.is_deleted ? row.recovery : null;
 const deducted=Math.round(lines.reduce((s,l)=>s+Number(l.deducted||0),0)*100)/100;
 const waived=Math.round(lines.reduce((s,l)=>s+Number(l.waived||0),0)*100)/100;
 const verifiedReceipt=plan?.outcome_code==='already_recovered' && plan.approval_status==='approved' && Number(plan.source_amount)===Number(row.amount) && row.lifecycle_status!=='needs_review';
 const outstanding=verifiedReceipt || row.source_final_nonrecoverable || row.redispute?.workflow_status==='won' ? 0 : Math.max(0,Math.round((Number(row.amount)-deducted-waived)*100)/100);
 let nextDue=lines.filter(l=>l.outstanding>0).map(l=>{
   const planned=l.first_salary_month ? nextMonth(l.first_salary_month,l.recovery_mode==='installments'?l.deducted_count:0) : plan?.deduction_month || period;
   return l.last_deducted_in && nextMonth(l.last_deducted_in)>planned ? nextMonth(l.last_deducted_in) : planned;
 }).sort()[0] || plan?.deduction_month || null;
 if(row.redispute?.recovery_month && (!nextDue || row.redispute.recovery_month>nextDue))nextDue=row.redispute.recovery_month;
 let status='update';
 if(row.redispute?.workflow_status==='won') status='redispute_won';
 else if(row.redispute?.enabled) status='redispute_pending';
 else if (row.source_final_nonrecoverable) status=deducted>0 ? 'review':'source_cleared';
 else if (outstanding===0) status=waived>0 ? 'written_off':'recovered';
 else if (!row.source_present && row.source_present!==undefined || ['needs_review','not_recoverable','rejected'].includes(row.lifecycle_status||'') || plan?.approval_status==='needs_review' || (plan && Number(plan.source_amount)!==Number(row.amount))) status='review';
 else if (plan?.approval_status==='returned' || row.lifecycle_status==='returned_to_station') status='returned';
 else if (plan?.approval_status==='proposed') status='approval';
 else if (plan?.approval_status==='approved') {
  if (row.lifecycle_status==='on_hold') status='review';
  else if (plan.outcome_code==='responsible_left' || lines.some(l=>l.status==='exit_balance')) status='exit';
  else status=nextDue && nextDue>period ? 'scheduled' : nextDue && nextDue<period ? 'carried' : 'due';
 } else if (plan) status='review';
 return { status, outstanding, deducted, waived, nextDue, verifiedReceipt };
}
export type RecoveryQueueState = ReturnType<typeof recoveryQueueState>;
export function isRecoveryApprovalRequest(row: NlCase, status: string) {
 const plan = row.recovery;
 return Boolean(plan && !plan.is_deleted && ['approval', 'review'].includes(status));
}
