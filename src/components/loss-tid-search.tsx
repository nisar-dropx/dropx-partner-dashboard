"use client";

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, X } from 'lucide-react';
import { TrackingDetailModal } from './tracking-detail-modal';
import { LossCaseRow, LossCaseColumns } from './loss-case-row';
import { canEnableException } from '@/lib/ops-pulse/loss-exception-batch';
import { recoveryDetailsUpdated } from '@/lib/ops-pulse/loss-final-summary';
import { redisputeStatus } from '@/lib/ops-pulse/loss-redispute-queue';
import type { NlCase, LossSettings } from '@/lib/ops-pulse/nl-loss-policy';
import styles from './nl-loss.module.css';
import ui from './loss-tid-search.module.css';
type Results={rows:NlCase[];settings?:LossSettings|null};
export function LossTidSearch(){
 const [value,setValue]=useState(''),[shipment,setShipment]=useState('');
 return <><div className="tracking-search"><Search size={15} className="tracking-search-icon" aria-hidden="true"/>
  <input type="search" className="tracking-search-input" placeholder="Search Shipment ID…" aria-label="Search tracking ID" value={value} onChange={e=>setValue(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();if(value.trim())setShipment(value.trim());}}}/>
  {value?<button type="button" className="tracking-search-clear" aria-label="Clear tracking ID search" onClick={()=>{setValue('');setShipment('');}}><X size={13}/></button>:null}
 </div>{shipment?<LossSearchResults key={shipment} shipment={shipment} onClose={()=>setShipment('')}/>:null}</>;
}
function LossSearchResults({shipment,onClose}:{shipment:string;onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null);
 const [results,setResults]=useState<Results|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[revision,setRevision]=useState(0);
 const [active,setActive]=useState(''),[tracking,setTracking]=useState<{id:string;station:string}|null>(null);
 useEffect(()=>{dialog.current?.showModal();},[]);
 useEffect(()=>{
  const controller=new AbortController();setLoading(true);setError('');
  fetch('/api/ops-pulse/losses/search?'+new URLSearchParams({shipment}),{signal:controller.signal,cache:'no-store'})
   .then(async r=>{const body=await r.json();if(!r.ok)throw Error(body.error||'Search failed.');return body;})
   .then(body=>{if(!controller.signal.aborted)setResults(body);})
   .catch(e=>{if(!controller.signal.aborted)setError(e.message);})
   .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
  return()=>controller.abort();
 },[shipment,revision]);
 return createPortal(<dialog ref={dialog} className={ui.dialog} aria-labelledby="loss-search-title" onCancel={e=>{e.preventDefault();onClose();}}>
  <header className={ui.head}><div><h2 id="loss-search-title">Shipment loss &amp; recovery</h2><small>{shipment} · all authorised locations and loss months</small></div><button type="button" aria-label="Close loss search" onClick={onClose}><X size={18}/></button></header>
  <div className={`${styles.workspace} ${ui.body}`}>
   <TrackingDetailModal trackingId={tracking?.id||null} stationHint={tracking?.station} onClose={()=>setTracking(null)}/>
   <div className={styles.toolbar}><small>View loss and recovery details. Click Shipment ID for delivery tracking.</small><button type="button" className={styles.button} disabled={loading} onClick={()=>setRevision(n=>n+1)}>Refresh status</button></div>
   {loading?<p role="status">Checking loss and recovery records…</p>:null}
   {error?<p role="alert">{error}</p>:null}
   {results?.rows.length?<><LossCaseColumns readOnly/>{results.rows.map(c=>{
    const key=c.month+'|'+c.case_key,eligible=canEnableException(c,results.settings?.recoverable_statuses||[]);
    const updated=recoveryDetailsUpdated(c,c.recovery,c.report==='slp');
    return <article key={key} className={styles.case}>
     <LossCaseRow station={c.station_code} tid={c.details.tid||c.case_key} approximate={!!c.details.tid_approximate} reason={`${(c.report||"nl").toUpperCase()} · ${c.month} · ${c.details.category||c.source_status}`} value={new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'}).format(c.amount)} date={c.recovery?.updated_at} updatedBy={c.recovery?.updated_by_name} historyCase={{month:c.month,caseKey:c.case_key}} open={active===key} onTrack={()=>setTracking({id:c.details.tid||c.case_key,station:c.station_code})} onToggle={()=>setActive(active===key?'':key)} status={<><span>{c.source_status}</span><small>{c.redispute?.enabled?`Redispute · ${redisputeStatus({...c.redispute,followup_status:''})}`:c.recovery&&!c.recovery.is_deleted?`${updated?'Details updated':'Needs review'} · ${c.recovery.outcome_label}`:eligible?'Recovery update pending':'No recovery update required'}</small>{c.recovery?.deduction_month?<small>Salary month {c.recovery.deduction_month}</small>:null}</>}/>
     {active===key?<LossSearchDetails row={c}/>:null}
    </article>;
   })}</>:null}
   {!loading&&!error&&results&&!results.rows.length?<p>No loss records for this Shipment ID in your authorised locations.</p>:null}
  </div>
 </dialog>,document.body);
}

function LossSearchDetails({row}:{row:NlCase}) {
 const plan=row.recovery&&!row.recovery.is_deleted?row.recovery:null;
 const money=(amount:number)=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'}).format(amount);
 return <section className={ui.details} aria-label="Saved loss and recovery details">
  <dl className={ui.summary}>
   <div><dt>Loss month</dt><dd>{row.month}</dd></div>
   <div><dt>Recovery</dt><dd>{plan?.outcome_label||'No recovery plan recorded'}</dd></div>
   {plan?<><div><dt>Salary month</dt><dd>{plan.deduction_month||'Not scheduled'}</dd></div><div><dt>Plan status</dt><dd>{(plan.approval_status||'Recorded').replaceAll('_',' ')}</dd></div></>:null}
   {row.redispute?<div><dt>Redispute</dt><dd>{redisputeStatus({...row.redispute,followup_status:''})}</dd></div>:null}
  </dl>
  {plan?.allocations?.length?<><small>Saved recovery allocation · actual deductions are recorded in payroll</small><div className={ui.tableWrap}><table className={ui.allocations}><thead><tr><th>Person</th><th>Designation</th><th>Salary month</th><th>Assigned value</th></tr></thead><tbody>{plan.allocations.map((person,i)=><tr key={person.ref||i}><td>{person.full_name||person.employee_code||'Name not recorded'}{person.employee_code?<small> · {person.employee_code}</small>:null}</td><td>{person.designation||'—'}</td><td>{person.salary_month||plan.deduction_month||'Not scheduled'}</td><td>{money(person.amount)}</td></tr>)}</tbody></table></div></>:null}
  {plan?.remarks?<details><summary>Recovery remarks</summary><p>{plan.remarks}</p></details>:null}
 </section>;
}
