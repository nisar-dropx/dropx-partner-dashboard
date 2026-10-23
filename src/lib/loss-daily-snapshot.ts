import { casePhase, requestSent, type LiveWindow } from './ops-pulse/nl-dispute-policy';
import { isRecoverable } from './ops-pulse/nl-loss-policy';
import type { LedgerLine } from './ops-pulse/nl-recovery-ledger-view';

export type LossStation = { id: string; source_code: string; station_code: string; station_name: string; cluster: string };
export type LossSourceCase = {
  month: string; case_key: string; report: string; station_code: string; amount: number | null;
  source_status: string | null; source_present: boolean; data_source: string; final_seen_at: string | null;
  last_seen_at: string; source_updated_at: string | null; lifecycle_status: string;
  lifecycle_note: string | null; lifecycle_updated_at: string | null;
  details: { tid?: string; period?: string; case_status?: string; in_final?: boolean; in_initial?: boolean; extra?: Record<string,string> };
};
export type LossPlan = {
  month: string; case_key: string; approval_status: string; deduction_timing: string; deduction_month: string | null;
  source_amount: number; outcome_code: string; outcome_label: string; recovery_mode: string; remarks: string;
  updated_at: string; updated_by_name: string;
  allocations: { ref: string; employee_code?: string; full_name?: string; amount: number; monthly_amount?: number; installments?: {n:number;amount:number}[] }[];
};
export type LossRequest = { month:string;case_key:string;status:'draft'|'submitted'|'returned'|'filed';source_stage:string|null;updated_at:string;updated_by_name:string;desk_note:string };
export type LossClaim = { reference:string;station_id:string;station_code:string;amount:number;status:string;raised_by_name:string;updated_at:string;decision_note:string|null;incident_date:string };
export type ActionKind = 'dispute'|'reply'|'plan'|'clarify'|'review'|'desk'|'approval'|'amazon'|'initial'|'claim';
export type LossAction = {stationId:string;station:string;month:string;caseKey:string;report:string;amount:number;kind:ActionKind;label:string;owner:string;due:string|null;deadlineBasis:string;overdue:boolean;dueToday:boolean;detail:string;updatedAt:string|null;updatedBy:string;link:string};
export type RecoveryLine = LedgerLine & { approval:string; nextEligible:number; payrollMonth:string; link:string };
export type StationLossSummary = LossStation & { actions:LossAction[];recoveries:RecoveryLine[];approved:number;recovered:number;remaining:number;draft:number;waived:number;nextEligible:number;overdue:number;dueToday:number;nextDue:string|null };
export type LossDailySnapshot = {date:string;checkedAt:string;stations:StationLossSummary[];scopeCount:number;actions:LossAction[];recoveries:RecoveryLine[];warnings:string[];sources:{name:string;checkedAt:string|null}[]};
export const lossCaseKey = (r:{month:string;case_key:string}) => JSON.stringify([r.month,r.case_key]);
export const roundLossMoney=(n:number)=>Math.round((n+Number.EPSILON)*100)/100;
export const sumLossMoney=(values:number[])=>roundLossMoney(values.reduce((a,b)=>a+Number(b||0),0));
export const lossTeamAction=(a:LossAction)=>['dispute','reply','plan','clarify','review','claim'].includes(a.kind);

export function lossCaseLink(c: Pick<LossSourceCase,'month'|'report'|'data_source'|'station_code'|'details'>, initial=false) {
  const q=new URLSearchParams({station:c.station_code});
  if(c.report==='station') return '/team-ops/losses/claims?'+q;
  if(c.report==='slp') { q.set('period',c.details?.period||'all'); return '/team-ops/losses/'+(initial?'slp-initial':'slp-final')+'?'+q; }
  q.set('view',c.data_source==='live'?'live':'historic');q.set('month',c.month);
  return '/team-ops/losses/nl?'+q;
}

/** One case has one next action. Ledger progress is separate from disputed / unapproved money. */
export function buildLossDailySnapshot(input:{
  date:string;checkedAt:string;stations:LossStation[];cases:LossSourceCase[];plans:LossPlan[];
  requests:LossRequest[];claims:LossClaim[];ledger:LedgerLine[];dueLines:{month:string;case_key:string;employee_ref:string;amount:number}[];
  window:LiveWindow;liveWindowMonth:string|null;recoverableStatuses:string[];nonAllocatingOutcomes:string[];
  sources:LossDailySnapshot['sources'];warnings?:string[];
}):LossDailySnapshot {
  const {date,checkedAt}=input;
  const stationByCode=new Map(input.stations.map(s=>[s.source_code,s]));
  const plans=new Map(input.plans.map(p=>[lossCaseKey(p),p]));
  const requests=new Map(input.requests.map(r=>[lossCaseKey(r),r]));
  const cases=new Map(input.cases.map(c=>[lossCaseKey(c),c]));
  const latestLiveMonth=input.liveWindowMonth;
  const actions:LossAction[]=[];
  const warnings=[...(input.warnings||[])];
  const add=(c:LossSourceCase,kind:ActionKind,label:string,owner:string,detail='',due:string|null=null,updatedAt:string|null=c.lifecycle_updated_at||c.last_seen_at,updatedBy='Source / system')=>{
    const s=stationByCode.get(c.station_code);if(!s)return;
    const validDue=due&&/^\d{4}-\d{2}-\d{2}$/.test(due)?due:null;
    actions.push({stationId:s.id,station:s.station_code,month:c.details?.period||c.month,caseKey:c.case_key,report:c.report,amount:Number(c.amount||0),kind,label,owner,due:validDue,deadlineBasis:validDue?'Amazon deadline · end of day IST':kind==='initial'?'Report only':kind==='amazon'?'Waiting for Amazon':'Internal deadline not configured',overdue:!!validDue&&validDue<date,dueToday:validDue===date,detail,updatedAt,updatedBy,link:lossCaseLink(c,kind==='initial')});
  };
  for(const c of input.cases){
    const s=stationByCode.get(c.station_code);if(!s)continue;
    const p=plans.get(lossCaseKey(c));
    const state=c.lifecycle_status;
    if(!c.source_present){if(p)add(c,'review','Verify missing source',s.cluster,'Source no longer present; retain existing recovery obligations.');continue;}
    if(c.amount==null){add(c,'review','Verify source amount',s.cluster,'Source amount unavailable; do not interpret as zero.');continue;}
    if(c.report==='nl'&&c.data_source==='live'){
      const phase=casePhase({case_status:c.details?.case_status,nl_status:c.source_status,extra:c.details?.extra}).key;
      const stage=c.details?.extra?.current_sla_stage;
      const request=requests.get(lossCaseKey(c));
      if(phase==='action'||phase==='respond'){
        const due=c.month===latestLiveMonth?(input.window[phase==='respond'?'eDSP2':'eDSP1']||null):null;
        if(requestSent(request,stage))add(c,request?.status==='filed'?'amazon':'desk',request?.status==='filed'?'Filed · await source update':'File in Cloak',request?.status==='filed'?'Amazon':'Cloak desk',request?.desk_note||'Station response recorded for this stage.',request?.status==='filed'?null:due,request?.updated_at,request?.updated_by_name);
        else add(c,phase==='respond'?'reply':'dispute',phase==='respond'?'Reply to Amazon':'Dispute / accept','Station TL',request?.status==='returned'?'Returned: '+request.desk_note:'Provide decision and evidence, then confirm filing in Cloak.',due,request?.updated_at||c.last_seen_at,request?.updated_by_name||'Amazon source');
        continue;
      }
      if(phase==='amazon'){add(c,'amazon','Under Amazon review','Amazon','No station response requested.');continue;}
      if(phase==='won')continue;
      if(phase==='missed'&&!isRecoverable(c.source_status,input.recoverableStatuses)){add(c,'review','Missed dispute window',s.cluster,'Confirm final recoverability before allocating payroll recovery.');continue;}
    }
    if(c.report==='slp'&&!c.final_seen_at&&!c.details?.in_final){add(c,'initial','SLP Initial · report only','Station / SLP','Investigate; this is not an approved recovery or a timed reply task.');continue;}
    const recoverable=c.report==='slp'||(c.report==='station'&&c.source_status==='Approved')||isRecoverable(c.source_status,input.recoverableStatuses);
    if(['rejected','not_recoverable','written_off','recovered'].includes(state))continue;
    if(['needs_review','on_hold','exit_balance'].includes(state)){add(c,'review',state==='exit_balance'?'Review exit balance':state==='on_hold'?'Recovery on hold':'Review source change',s.cluster,c.lifecycle_note||'Review the named blocker before further recovery.');continue;}
    if(!recoverable){if(p)add(c,'review','Confirm source decision',s.cluster,'Saved plan requires source verification.');continue;}
    if(state==='returned_to_station'||state==='station_dispute_or_clarification_window'){add(c,'clarify','Station clarification','Station TL',c.lifecycle_note||'Answer the pending clarification before recovery planning.');continue;}
    if(p&&input.nonAllocatingOutcomes.includes(p.outcome_code))continue;
    if(p?.approval_status==='approved')continue;
    if(p?.approval_status==='proposed'){add(c,'approval','Approve recovery','Authorised SLP approver','Proposed plan; no payroll deduction until approval.',null,p.updated_at,p.updated_by_name);continue;}
    const missing:string[]=[];
    if(!p?.allocations?.length)missing.push('person ID and allocated share');
    else{
      if(p.allocations.some(a=>!a.ref||!a.employee_code))missing.push('valid person ID');
      if(Math.abs(sumLossMoney(p.allocations.map(a=>a.amount))-Number(c.amount))>.01)missing.push('full amount allocation');
    }
    if(!p?.deduction_month)missing.push('start payroll month');
    if(!p?.recovery_mode)missing.push('recovery schedule');
    add(c,'plan','Complete recovery plan',s.cluster,missing.length?'Missing: '+missing.join(', '):'Submit the saved plan for SLP approval.',null,p?.updated_at||c.lifecycle_updated_at,p?.updated_by_name||'Source / system');
  }
  for(const c of input.claims){
    const s=input.stations.find(s=>s.id===c.station_id);if(!s||!['submitted','returned'].includes(c.status))continue;
    const returned=c.status==='returned';
    actions.push({stationId:s.id,station:s.station_code,month:c.incident_date.slice(0,7),caseKey:'claim:'+c.reference,report:'station',amount:Number(c.amount),kind:'claim',label:returned?'Respond to returned claim':'Decide station claim',owner:returned?c.raised_by_name:'Current claim approver',due:null,deadlineBasis:'Internal deadline not configured',overdue:false,dueToday:false,detail:c.decision_note||'Station claim approval precedes recovery planning.',updatedAt:c.updated_at,updatedBy:c.raised_by_name,link:'/team-ops/losses/claims'});
  }
  const recoveries:RecoveryLine[]=input.ledger.filter(l=>stationByCode.has(l.station_code)&&plans.get(lossCaseKey(l))?.approval_status==='approved').map(l=>{
    const c=cases.get(lossCaseKey(l));
    return {...l,total:Number(l.total),deducted:Number(l.deducted),in_payroll:Number(l.in_payroll),waived:Number(l.waived),outstanding:Number(l.outstanding),monthly_amount:Number(l.monthly_amount),approval:'approved',payrollMonth:date.slice(0,7),nextEligible:sumLossMoney(input.dueLines.filter(d=>d.month===l.month&&d.case_key===l.case_key&&d.employee_ref===l.employee_ref).map(d=>Number(d.amount))),link:c?lossCaseLink(c):'/team-ops/losses/ledger'};
  });
  const stations=input.stations.map(s=>{
    const a=actions.filter(a=>a.stationId===s.id),r=recoveries.filter(r=>r.station_code===s.source_code);
    return {...s,actions:a,recoveries:r,approved:sumLossMoney(r.map(l=>l.total)),recovered:sumLossMoney(r.map(l=>l.deducted)),remaining:sumLossMoney(r.map(l=>l.outstanding)),draft:sumLossMoney(r.map(l=>l.in_payroll)),waived:sumLossMoney(r.map(l=>l.waived)),nextEligible:sumLossMoney(r.map(l=>l.nextEligible)),overdue:a.filter(a=>a.overdue).length,dueToday:a.filter(a=>a.dueToday).length,nextDue:a.flatMap(a=>a.due?[a.due]:[]).sort()[0]||null};
  }).filter(s=>s.actions.length||s.recoveries.length).sort((a,b)=>b.overdue-a.overdue||b.dueToday-a.dueToday||(a.nextDue||'9999').localeCompare(b.nextDue||'9999')||b.actions.filter(lossTeamAction).length-a.actions.filter(lossTeamAction).length||a.station_code.localeCompare(b.station_code));
  return {date,checkedAt,stations,scopeCount:input.stations.length,actions,recoveries,warnings,sources:input.sources};
}
