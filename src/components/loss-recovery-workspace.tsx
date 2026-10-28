'use client';
import { useMemo, useState } from 'react';
import {useSearchParams} from 'next/navigation';
import type { NlCase, LossSettings, RecoveryOutcome } from '@/lib/ops-pulse/nl-loss-policy';
import type { LedgerLine } from '@/lib/ops-pulse/nl-recovery-ledger-view';
import { indiaMonth, recoveryQueueState, isRecoveryApprovalRequest, RECOVERY_QUEUE_LABELS } from '@/lib/ops-pulse/loss-recovery-queue-policy';
import { LossClarificationInbox } from "./loss-clarification-inbox";
import { RecoveryForm } from './nl-loss-cases';
import { TrackingDetailModal } from './tracking-detail-modal';
import { ListPager, usePaged } from './list-pager';
import { LossPidTimeline } from "./loss-pid-timeline";
import styles from './nl-loss.module.css';
const money=(n:number)=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:2}).format(n);
export function LossRecoveryWorkspace({rows,lines,outcomes,settings,canEdit,canRecovered=false,canApprove,approvals=false}:{rows:NlCase[];lines:LedgerLine[];outcomes:RecoveryOutcome[];settings:LossSettings|null;canEdit:boolean;canRecovered?:boolean;canApprove:boolean;approvals?:boolean}) {
 const params=useSearchParams();
 const caseQuery=params.get('case'), caseMonth=params.get('month');
 const [period,setPeriod]=useState(indiaMonth()),[filter,setFilter]=useState(caseQuery?'all':approvals?'open':'pending_update'),[query,setQuery]=useState(caseQuery||''),[station,setStation]=useState(''),[active,setActive]=useState(caseQuery&&caseMonth?`${caseMonth}|${caseQuery}`:''),[tracking,setTracking]=useState<{id:string;station:string}|null>(null);
 const data=useMemo(()=>{
  const byCase=new Map<string,LedgerLine[]>(); for(const l of lines){const k=`${l.month}|${l.case_key}`;byCase.set(k,[...(byCase.get(k)||[]),l]);}
  return rows.map(row=>({row,...recoveryQueueState(row,byCase.get(`${row.month}|${row.case_key}`)||[],period)}));
 },[rows,lines,period]);
 const exceptionReason=(row:NlCase)=>{const r=row.recovery;
  if(r?.outcome_code==='responsible_left') return 'Person left';
  if(r?.outcome_code==='already_recovered') return 'Verify receipt';
  if(r?.cap_override) return 'Salary cap override';
  if(r?.recovery_mode==='installments') return 'Split across payrolls';
  if(r?.deduction_timing==='next_month') return 'Deferred recovery';
  if(r?.approval_status==='needs_review'||row.lifecycle_status==='needs_review') return 'Review required';
  return r?.approval_note || r?.outcome_label || 'Eligibility / correction review';
 };
 const shown=useMemo(()=>data.filter(x=>(!approvals || isRecoveryApprovalRequest(x.row,x.status))&&(!station||x.row.station_code===station)&&(!caseQuery||query!==caseQuery||!caseMonth||x.row.month===caseMonth)&&(filter==='pending_update'?['update','review','returned'].includes(x.status):filter==='all'||filter==='open'?!['recovered','written_off','source_cleared'].includes(x.status)||filter==='all':x.status===filter)&&[x.row.case_key,x.row.station_code,x.row.details.tid,...(x.row.recovery?.allocations.map(a=>`${a.full_name} ${a.employee_code}`)||[])].join(' ').toLowerCase().includes(query.toLowerCase())).sort((a,b)=>b.outstanding-a.outstanding),[data,station,filter,query,approvals,caseQuery,caseMonth]);
 const paged=usePaged(shown,25,`${period}|${filter}|${station}|${query}`);
 const scoped=shown;
 return <>
  {approvals && canApprove ? <LossClarificationInbox/> : null}
  {approvals ? <div className={styles.toolbar} style={{padding:'8px 0'}}><strong>{scoped.filter(x=>isRecoveryApprovalRequest(x.row,x.status)).length} pending exceptions</strong><span>· {money(scoped.filter(x=>isRecoveryApprovalRequest(x.row,x.status)).reduce((sum,x)=>sum+x.outstanding,0))}</span><a href="/team-ops/losses/recovery">Recovery review ↗</a></div> : <div className={styles.metrics}>
   <div><span>Outstanding</span><strong>{money(scoped.reduce((s,x)=>s+x.outstanding,0))}</strong><small>Matching shipments · verified balance</small></div>
   <div><span>Carried forward</span><strong>{money(scoped.filter(x=>x.status==='carried').reduce((s,x)=>s+x.outstanding,0))}</strong><small>Unpaid scheduled recovery remains due</small></div>
   <div><span>Awaiting approval</span><strong>{scoped.filter(x=>isRecoveryApprovalRequest(x.row,x.status)).length}</strong><small>Not final until independently approved</small></div>
  </div>}
  <section className={styles.panel}>
   <div className={styles.panelHead}><div><h2>{approvals?'Exception approvals':'Recovery queue'}</h2><small>{approvals?'Departures · deferred recovery · instalments · verification':'Unpaid balances carry forward. Expand a case to update recovery.'}</small></div></div>
   <div className={styles.toolbar} style={{padding:12}}>
    {!approvals ? <><label>Collection month <input aria-label="Collection month" type="month" min={indiaMonth()} value={period} onChange={e=>setPeriod(e.target.value||indiaMonth())}/></label>
    <select aria-label="Recovery workflow status" value={filter} onChange={e=>setFilter(e.target.value)}><option value="pending_update">Pending recovery update</option><option value="open">All outstanding</option>{Object.entries(RECOVERY_QUEUE_LABELS).map(([k,v])=><option key={k} value={k}>{v} · {data.filter(x=>(!station||x.row.station_code===station)&&x.status===k).length}</option>)}<option value="all">All cases</option></select></> : null}
    <select aria-label="Recovery station" value={station} onChange={e=>setStation(e.target.value)}><option value="">All my stations</option>{[...new Set(rows.map(r=>r.station_code))].sort().map(s=><option key={s}>{s}</option>)}</select>
    <input aria-label="Search recovery queue" placeholder="TID, person or station" value={query} onChange={e=>setQuery(e.target.value)}/>
   </div>
   {paged.rows.map(x=>{const k=`${x.row.month}|${x.row.case_key}`;return <article key={k} className={styles.case}>
    <div className={styles.panelHead} style={{padding:'10px 12px'}}><div><button className={styles.button} onClick={()=>setTracking({id:x.row.details.tid||x.row.case_key,station:x.row.station_code})}>{x.row.station_code} · {x.row.details.tid||x.row.case_key} ↗</button><small> {x.row.report?.toUpperCase()} · loss {x.row.month} · {approvals?exceptionReason(x.row):RECOVERY_QUEUE_LABELS[x.status]}</small></div><div><strong>{money(x.outstanding)}</strong> <button className={styles.button} aria-expanded={active===k} onClick={()=>setActive(active===k?'':k)}>{active===k?'Close':'Review'}</button></div></div>
    {active===k?<div className={styles.detail}><p className={styles.hint}>Loss {money(x.row.amount)} · payroll recovered {money(x.deducted)}{x.waived?` · written off ${money(x.waived)}`:''}{x.nextDue?` · due from ${x.nextDue}`:''}. A missed salary month carries the unpaid instalment forward.</p>
      {x.row.source_final_nonrecoverable || x.row.source_present===false ? <LossPidTimeline month={x.row.month} caseKey={x.row.case_key}/> : null}
      {x.row.source_final_nonrecoverable?<p className={styles.notice}>Source confirms non-recoverable. No further recovery is due.{x.deducted>0?" Review previous deductions with Finance; history has not been reversed.":""}</p>:x.row.source_present===false?<p role="alert">Source case unavailable. Balance retained for review; edits are paused.</p>:<RecoveryForm key={`${k}:${x.row.recovery?.version||0}:${x.row.lifecycle_version||0}`} row={x.row} outcomes={outcomes} settings={settings} canEdit={canEdit} canRecovered={canRecovered} canApprove={canApprove}/>}</div>:null}
   </article>})}
   {!shown.length?<p className={styles.empty}>No cases match this queue.</p>:null}
   <ListPager page={paged.page} pages={paged.pages} size={paged.size} total={paged.total} onPage={paged.setPage} onSize={paged.setSize} label="cases"/>
  </section>
  <TrackingDetailModal trackingId={tracking?.id||null} stationHint={tracking?.station} onClose={()=>setTracking(null)}/>
 </>;
}
