"use client";

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import dynamic from 'next/dynamic';
import { Search, X } from 'lucide-react';
import { TrackingDetailModal } from './tracking-detail-modal';
import { LossCaseRow, LossCaseColumns } from './loss-case-row';
import { canEnableException } from '@/lib/ops-pulse/loss-exception-batch';
import { recoveryDetailsUpdated } from '@/lib/ops-pulse/loss-final-summary';
import { redisputeStatus } from '@/lib/ops-pulse/loss-redispute-queue';
import type { NlCase, LossSettings, RecoveryOutcome } from '@/lib/ops-pulse/nl-loss-policy';
import styles from './nl-loss.module.css';
import ui from './loss-tid-search.module.css';
const RecoveryForm=dynamic(()=>import('./nl-loss-cases').then(m=>m.RecoveryForm),{loading:()=> <p>Loading recovery…</p>});
const LossCaseResponse=dynamic(()=>import('./loss-case-response').then(m=>m.LossCaseResponse));
type Results={rows:NlCase[];settings?:LossSettings|null;outcomes?:RecoveryOutcome[];canEdit?:boolean;canRecovered?:boolean;canApprove?:boolean};
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
   <div className={styles.toolbar}><small>Open status to update recovery. Click Shipment ID for delivery tracking.</small><button type="button" className={styles.button} disabled={loading} onClick={()=>setRevision(n=>n+1)}>Refresh status</button></div>
   {loading?<p role="status">Checking loss and recovery records…</p>:null}
   {error?<p role="alert">{error}</p>:null}
   {results?.rows.length?<><LossCaseColumns/>{results.rows.map(c=>{
    const key=c.month+'|'+c.case_key,eligible=canEnableException(c,results.settings?.recoverable_statuses||[]);
    const updated=recoveryDetailsUpdated(c,c.recovery,c.report==='slp');
    return <article key={key} className={styles.case}>
     <LossCaseRow station={c.station_code} tid={c.details.tid||c.case_key} approximate={!!c.details.tid_approximate} reason={`${(c.report||"nl").toUpperCase()} · ${c.month} · ${c.details.category||c.source_status}`} value={new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'}).format(c.amount)} date={c.recovery?.updated_at} updatedBy={c.recovery?.updated_by_name} historyCase={{month:c.month,caseKey:c.case_key}} open={active===key} onTrack={()=>setTracking({id:c.details.tid||c.case_key,station:c.station_code})} onToggle={()=>setActive(active===key?'':key)} status={<><span>{c.source_status}</span><small>{c.redispute?.enabled?`Redispute · ${redisputeStatus({...c.redispute,followup_status:''})}`:c.recovery&&!c.recovery.is_deleted?`${updated?'Details updated':'Needs review'} · ${c.recovery.outcome_label}`:eligible?'Recovery update pending':'No recovery update required'}</small>{c.recovery?.deduction_month?<small>Salary month {c.recovery.deduction_month}</small>:null}</>}/>
     {active===key?(eligible?<RecoveryForm row={c} outcomes={results.outcomes||[]} settings={results.settings||null} canEdit={!!results.canEdit} canRecovered={!!results.canRecovered} canApprove={!!results.canApprove} onSaved={()=>setRevision(n=>n+1)}/>:c.redispute?.enabled?<LossCaseResponse month={c.month} caseKey={c.case_key} embedded/>:<p className={styles.hint}>{c.source_present?'Recovery changes are available only for final recoverable shipments.':'This shipment is no longer in the current source file. History remains available.'}</p>):null}
    </article>;
   })}</>:null}
   {!loading&&!error&&results&&!results.rows.length?<p>No loss records for this Shipment ID in your authorised locations.</p>:null}
  </div>
 </dialog>,document.body);
}
