import 'server-only';
import type {SupabaseClient} from '@supabase/supabase-js';
import {readAllRows} from '@/lib/supabase-pagination';
import {baseStations,latestPublications,monthEnd,monthValue,paise,type Sources,type Entry,type Loss} from './model';
export const FINAL_PNL_COMPANY='43866344-b550-4e8a-9a2d-9d23f3d8a997';
type Row=Record<string,any>;
async function rows(query:any,label:string):Promise<Row[]>{const result=await readAllRows(query);if(result.error)throw Error(`${label} could not be read: ${result.error.message}`);return result.data??[];}
export async function loadSources(db:SupabaseClient,company:string,month:string):Promise<Sources>{
 monthValue(month);if(company!==FINAL_PNL_COMPANY)throw Error('This company has no invoice connection.');
 const capturedAt=new Date().toISOString(),start=`${month}-01`,end=monthEnd(month);
 const table=(name:string,fields='*')=>db.from(name).select(fields).eq('company_id',company);
 const [stations,aliases,workforce,helpers,hrRuns,nlCases,nlPlans,recoveryCases,claims]=await Promise.all([
  rows(table('stations','id,station_code,parent_station_id').order('id'),'Station topology'),
  rows(table('cod_station_settings','location_id,portal_station_code').order('location_id'),'Station aliases'),
  rows(table('workforce_payout_publications','id,workforce_id,station_id,revision,snapshot,published_at,period_start,period_end,payroll_run_id').gte('period_end',start).order('id'),'Published workforce payouts'),
  rows(table('helper_payout_publications','id,helper_id,station_id,revision,snapshot,published_at,period_start,period_end').gte('period_end',start).order('id'),'Published helper payouts'),
  rows(table('hr_payroll_runs','id,period_start,period_end,status,published_at,approved_at').gte('period_end',start).order('id'),'Employee payroll runs'),
  rows(table('nl_loss_month_cases','month,case_key,station_code,amount,source_status,source_present,details,report').eq('month',month).order('case_key'),'Ops Pulse losses'),
  rows(table('nl_loss_recoveries','month,case_key,outcome_label,allocations,deduction_month,remarks,is_deleted,source_amount').eq('month',month).eq('is_deleted',false).order('case_key'),'Ops Pulse recovery plans'),
  rows(table('payment_recovery_cases','id,tid,station_id,station_code_snapshot,debit_date,debit_month,debit_amount,payout_month,status').gte('debit_month',start).lte('debit_month',end).order('id'),'Payment recovery cases'),
  rows(table('workforce_station_loss_claims','id,workforce_id,station_id,adjustment_id,incident_date,reference').gte('incident_date',start).lte('incident_date',end).order('id'),'Station loss claims')
 ]);
 const topology=baseStations(stations as any,aliases as any),stationById=new Map(stations.map(s=>[s.id,s.station_code]));
 const issues:string[]=[],entries:Entry[]=[],losses:Loss[]=[];
 const add=(entry:Omit<Entry,'month'|'sourceStation'>)=>{entries.push({...entry,month,sourceStation:entry.station});};
 const codes=stations.map(s=>s.station_code);
 const cps=await db.rpc('ops_cps_base_v2',{p_company:company,p_from:start,p_through:end,p_stations:codes});
 if(cps.error||!cps.data||!Array.isArray(cps.data.breakup))throw Error('Operating expense sources could not be read.');
 const costs=new Map<string,Entry>();let heldCosts=0;
 for(const r of cps.data.breakup as Row[]){
  // Payroll models and configurable CPS inputs are estimates, not final payroll.
  if(['Shipment payment mapping','CPS Inputs'].includes(r.source))continue;
  if(/salary|payroll|associate payout|helper payout|employee payout/i.test(r.sub_head??'')){heldCosts++;continue;}
  const id=`cost:${JSON.stringify([r.station_code,r.source,r.head,r.sub_head])}`;
  const existing=costs.get(id);if(existing)existing.paise+=paise(r.amount);else costs.set(id,{id,month,station:r.station_code,sourceStation:r.station_code,side:'expense',head:r.sub_head||r.head,description:r.source==='Finance Rent Master'?'Contract rent and maintenance for this month':`${r.sub_head||r.head} · recorded operating expenses`,paise:paise(r.amount),source:r.source,reference:`${r.source} / ${month}`,date:end});
 }
 entries.push(...costs.values());
 if(heldCosts)issues.push(`${heldCosts} salary-labelled expense groups are excluded to avoid counting payroll twice. Review salary payments outside published payroll.`);
 const allWorkforce=latestPublications(workforce,'workforce_id'),allHelpers=latestPublications(helpers,'helper_id');
 let payrollCount=0;
 for(const [kind,list] of [['Workforce',allWorkforce],['Helper',allHelpers]] as const){
  const groups=new Map<string,{paise:number;count:number}>();
  for(const r of list){
   if(r.period_start>end||r.period_end<start)continue;
   if(r.period_start<start||r.period_end>end){issues.push(`${kind} publication ${r.id} crosses month boundaries; add a documented allocation.`);continue;}
   const item=r.snapshot?.item;if(!item||item.gross_amount==null){issues.push(`${kind} publication ${r.id} has no final gross amount.`);continue;}
   const station=stationById.get(r.station_id)||item.station_code||'UNKNOWN';
   const n=paise(item.gross_amount);const existing=groups.get(station)??{paise:0,count:0};existing.paise+=n;existing.count++;groups.set(station,existing);payrollCount++;
  }
  for(const [station,g] of groups)add({id:`payroll:${kind}:${station}`,station,side:'expense',head:`${kind} payouts`,description:`${g.count} latest published payouts · gross before recoveries`,paise:g.paise,source:'Published payroll',reference:`${kind} publications / ${month}`,date:end});
 }
 const finalRuns=hrRuns.filter(r=>['approved','locked','published'].includes(r.status));
 const hrPeople:Row[]=[],hrItems:Row[]=[];
 for(let i=0;i<finalRuns.length;i+=50){const ids=finalRuns.slice(i,i+50).map(r=>r.id);if(!ids.length)continue;
  hrPeople.push(...await rows(table('hr_payroll_run_people','id,run_id,worker_type,worker_id,location_id,gross_pay,attendance_deductions,other_earnings,employer_contributions,net_pay,statutory_deductions,other_deductions,is_adjusted').in('run_id',ids).order('id'),'Final employee payroll'));
 }
 const runMap=new Map(finalRuns.map(r=>[r.id,r]));const hrSeen=new Set<string>();const employeeCosts=new Map<string,{paise:number;count:number}>();
 for(const p of hrPeople){const run=runMap.get(p.run_id)!;if(run.period_start> end||run.period_end<start)continue;
  if(run.period_start<start||run.period_end>end){issues.push(`Employee payroll ${run.id} spans months; allocate its expense.`);continue;}
  const identity=`${p.worker_type}:${p.worker_id}:${run.period_start}:${run.period_end}`;
  if(hrSeen.has(identity)){throw Error('Multiple final payroll runs cover the same employee and period. Resolve payroll duplication before syncing.');}hrSeen.add(identity);
  const duplicate=(p.worker_type==='workforce'?allWorkforce:p.worker_type==='helper'?allHelpers:[]).some(r=>r[p.worker_type==='helper'?'helper_id':'workforce_id']===p.worker_id&&r.period_start===run.period_start&&r.period_end===run.period_end);
  if(duplicate){issues.push('People payroll overlaps a published workforce/helper payout. The overlapping People row is excluded; review payroll ownership.');continue;}
  const earned=paise(p.net_pay)+paise(p.statutory_deductions)+paise(p.other_deductions),cost=earned+paise(p.employer_contributions);
  if(p.is_adjusted)issues.push('Manually adjusted employee payroll exists. Review its final cost treatment.');
  const station=stationById.get(p.location_id)||'HO / unallocated';const g=employeeCosts.get(station)??{paise:0,count:0};g.paise+=cost;g.count++;employeeCosts.set(station,g);payrollCount++;
 }
 for(const [station,g] of employeeCosts)add({id:`payroll:employee:${station}`,station,side:'expense',head:'Employee payroll',description:`${g.count} approved payroll rows · earned pay plus employer contributions, before recoveries`,paise:g.paise,source:'Approved employee payroll',reference:`Employee payroll / ${month}`,date:end});
 if(!payrollCount)issues.push('No published or approved payroll was found for this month. The recorded margin is incomplete until final payroll or documented expenses are added.');
 // NL outcomes are allocation plans. No name/amount matching is used to manufacture a payroll posting.
 const planMap=new Map(nlPlans.map(p=>[p.case_key,p]));
 for(const c of nlCases){const p=planMap.get(c.case_key),alloc=Array.isArray(p?.allocations)?p.allocations:[];
  losses.push({id:`nl:${c.case_key}`,month,station:c.station_code,reference:c.case_key,paise:paise(c.amount),outcome:p?.outcome_label||c.source_status||'Awaiting dispute outcome',plannedPaise:alloc.reduce((n:number,a:Row)=>n+paise(a.amount??0),0),payrollMonth:p?.deduction_month||'',responsible:alloc.map((a:Row)=>a.employee_code||a.ref).join(', '),postedPaise:0,evidence:c.source_present?'Ops Pulse loss register':'No longer present in the current source'});
 }
 // Payment recovery events marked applied may predate publication. Verify the actual payroll evidence too.
 const recoveryIds=recoveryCases.map(r=>r.id);const allocations:Row[]=[],events:Row[]=[];
 for(let i=0;i<recoveryIds.length;i+=100){const ids=recoveryIds.slice(i,i+100);
  allocations.push(...await rows(table('payment_recovery_allocations','id,recovery_case_id,allocation_amount,workforce_id,station_id,payout_engine,payout_run_id,payout_run_person_id,deduction_value_id').in('recovery_case_id',ids).order('id'),'Recovery allocation links'));
  events.push(...await rows(table('payment_recovery_events','id,recovery_case_id,allocation_id,event_type,status,amount,period_start,period_end,reference,created_at').in('recovery_case_id',ids).eq('status','applied').order('id'),'Recovery posting evidence'));
 }
 const personIds=[...new Set(allocations.map(a=>a.payout_run_person_id).filter(Boolean))];
 for(let i=0;i<personIds.length;i+=100)hrItems.push(...await rows(table('hr_payroll_run_items','id,run_person_id,code,source,amount').in('run_person_id',personIds.slice(i,i+100)).eq('source','payment_recovery').order('id'),'Employee recovery deductions'));
 const allocationTotals=new Map<string,number>();for(const a of allocations){const key=a.payout_run_person_id||a.deduction_value_id;if(key)allocationTotals.set(key,(allocationTotals.get(key)??0)+paise(a.allocation_amount));}
 for(const c of recoveryCases){const caseKey=`payment:${c.id}`,caseAlloc=allocations.filter(a=>a.recovery_case_id===c.id);let posted=0;
  for(const e of events.filter(e=>e.recovery_case_id===c.id)){
   let confirmed=['provider_credit','manual_recovery'].includes(e.event_type)&&!!e.reference;
   if(e.event_type==='payout_deduction'){
    const a=caseAlloc.find(a=>a.id===e.allocation_id);
    if(a?.payout_run_person_id){const p=hrPeople.find(p=>p.id===a.payout_run_person_id);const item=hrItems.find(i=>i.run_person_id===a.payout_run_person_id&&i.code==='RECOVERY');confirmed=!!p&&!!item&&paise(item.amount)>=(allocationTotals.get(a.payout_run_person_id)??Infinity);}
    else if(a?.deduction_value_id){const pubs=allWorkforce.filter(p=>p.workforce_id===a.workforce_id&&p.station_id===a.station_id&&p.period_start===e.period_start&&p.period_end===e.period_end);confirmed=pubs.some(p=>(p.snapshot?.lines??[]).filter((l:Row)=>l.source_type==='deduction'&&l.calculation_snapshot?.category==='RECOVERY').reduce((n:number,l:Row)=>n+Math.abs(paise(l.net_amount)),0)>=(allocationTotals.get(a.deduction_value_id)??Infinity));}
   }
   if(!confirmed)continue;const n=paise(e.amount);posted+=n;
   add({id:`recovery:event:${e.id}`,station:c.station_code_snapshot||stationById.get(c.station_id)||'UNKNOWN',side:'income',head:'Loss recovery',description:`${c.tid} · ${e.event_type.replaceAll('_',' ')}`,paise:n,source:'Confirmed recovery evidence',reference:e.reference||e.id,date:e.created_at.slice(0,10),recovery:true,caseKey,payrollMonth:e.period_start?.slice(0,7)||''});
  }
  losses.push({id:caseKey,month,station:c.station_code_snapshot||stationById.get(c.station_id)||'UNKNOWN',reference:c.tid,paise:paise(c.debit_amount),outcome:c.status,plannedPaise:caseAlloc.reduce((n,a)=>n+paise(a.allocation_amount),0),payrollMonth:c.payout_month?.slice(0,7)||'',responsible:'Payment recovery allocations',postedPaise:posted,evidence:posted?'Confirmed recovery register / payroll':'Awaiting confirmed recovery evidence'});
 }
 // Legacy loss claims have an explicit adjustment -> payroll-run link.
 if(claims.length){const adjustmentIds=claims.map(c=>c.adjustment_id).filter(Boolean);const adjustments:Row[]=[];
  for(let i=0;i<adjustmentIds.length;i+=100)adjustments.push(...await rows(table('workforce_adjustments','id,amount,status,payroll_run_id,effective_date').in('id',adjustmentIds.slice(i,i+100)).order('id'),'Station loss adjustments'));
  const runIds=[...new Set(adjustments.map(a=>a.payroll_run_id).filter(Boolean))],runs:Row[]=[];
  for(let i=0;i<runIds.length;i+=100)runs.push(...await rows(table('workforce_payroll_runs','id,status,period_start,period_end').in('id',runIds.slice(i,i+100)).order('id'),'Confirmed workforce payroll'));
  for(const c of claims){const a=adjustments.find(a=>a.id===c.adjustment_id);if(!a)continue;const run=runs.find(r=>r.id===a.payroll_run_id);const posted=!!run&&['approved','confirmed','paid'].includes(run.status)&&a.status==='posted';const id=`claim:${c.id}`,n=paise(a.amount),station=stationById.get(c.station_id)||'UNKNOWN';
   losses.push({id,month,station,reference:c.reference||c.id,paise:n,outcome:a.status,plannedPaise:n,payrollMonth:run?.period_start?.slice(0,7)||a.effective_date?.slice(0,7)||'',responsible:'Workforce loss claim',postedPaise:posted?n:0,evidence:posted?'Posted adjustment linked to confirmed payroll':'Awaiting confirmed payroll'});
   if(posted)add({id:`recovery:claim:${c.id}`,station,side:'income',head:'Loss recovery',description:'Station loss adjustment posted to payroll',paise:n,source:'Confirmed workforce payroll',reference:c.reference||c.id,date:a.effective_date,recovery:true,caseKey:id,payrollMonth:run!.period_start.slice(0,7)});
  }
 }
 if(nlPlans.some(p=>Array.isArray(p.allocations)&&p.allocations.length))issues.push('NL allocations are plans. Their source currently has no explicit payroll posting link; confirm the deduction evidence before recording recovery.');
 issues.push('Final P&L remains open for expense completeness review. Contract rent is accrued; configured CPS estimates are excluded. Invoice chargebacks already count as expenses, so loss-register amounts are not charged again.');
 return {company,month,capturedAt,stations:topology,entries,losses,issues:[...new Set(issues)],counts:{invoiceIndependentCostGroups:costs.size,payrollRows:payrollCount,nlLosses:nlCases.length,paymentRecoveryCases:recoveryCases.length,confirmedRecoveryEntries:entries.filter(e=>e.recovery).length}};
}
