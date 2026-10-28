"use client";
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LOSS_EXCEPTION_LABELS, type LossExceptionKind, type LossExceptionGrant } from '@/lib/ops-pulse/loss-exceptions';
import { hasFinalLossOutcome } from '@/lib/ops-pulse/loss-recovery-controls';
import { isRecoverable, type NlCase } from '@/lib/ops-pulse/nl-loss-policy';
import type { RedisputeWindow } from './loss-redispute-desk';
import { ListPager, usePaged } from './list-pager';
import styles from './nl-loss.module.css';
type Update = { month:string; case_key:string; station:string; kind:LossExceptionKind; enabled:boolean; version:number; reason:string };
export function LossExceptionsDesk({rows,grants,windows,canEdit,recoverableStatuses}:{rows:NlCase[];grants:LossExceptionGrant[];windows:RedisputeWindow[];canEdit:boolean;recoverableStatuses:string[]}) {
 const router=useRouter();
 const [query,setQuery]=useState(''),[kind,setKind]=useState<LossExceptionKind>('redispute'),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[preview,setPreview]=useState<Update[]>([]);
 const eligible=rows.filter(r=>r.source_present && (r.report==='slp'?!!r.final_seen_at:r.report==='station'?r.source_status==='Approved':isRecoverable(r.source_status,recoverableStatuses)&&hasFinalLossOutcome(true,r.source_status,r.details?.case_status,r.details?.extra?.current_sla_stage)));
 const shown=eligible.filter(r=>[r.month,r.station_code,r.case_key,r.details.tid].join(' ').toLowerCase().includes(query.trim().toLowerCase()));
 const paged=usePaged(shown,25,query);
 function current(r:NlCase,k:LossExceptionKind) { return k==='redispute'?windows.find(w=>w.month===r.month&&w.case_key===r.case_key):grants.find(g=>g.month===r.month&&g.case_key===r.case_key&&g.kind===k); }
 function update(r:NlCase,k:LossExceptionKind,enabled:boolean,note:string):Update {return {month:r.month,case_key:r.case_key,station:r.station_code,kind:k,enabled,version:current(r,k)?.version||0,reason:note.trim()};}
 async function apply(input:Update[]) {
  if(!canEdit||busy)return; setBusy(true);setMessage('');
  try {
   const res=await fetch('/api/ops-pulse/losses/exceptions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rows:input})});
   const body=await res.json();if(!res.ok)throw Error(body.error);
   const failed=body.results.filter((r:{ok:boolean})=>!r.ok);
   setMessage(`${body.results.length-failed.length} updated.${failed.length?' '+failed.map((r:{case_key:string;error:string})=>`${r.case_key}: ${r.error}`).join('; '):''}`);
   setPreview([]);router.refresh();
  } catch(e){setMessage(e instanceof Error?e.message:'Could not save exceptions.');}finally{setBusy(false);}
 }
 async function template(){
  const XLSX=await import('xlsx'),book=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Loss month','Shipment ID','Station','Exception','Action','Reason']]),'Exceptions');
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([
   ['Field','Instructions'],['Loss month','YYYY-MM'],['Shipment ID','Exact TID; format as text'],['Station','Station code'],
   ['Exception','Redispute / Deduct next month / Recurring debit'],['Action','Enable / Disable'],['Reason','Required: 10–2000 characters'],
   ['Limit','100 updates. One row per TID and exception. Review before applying.'],['Deduct next month','Enables the next applicable payroll month at the time of saving; not an unrestricted future date.'],
   ['Recurring debit','Enables a station to create a schedule within the amount and salary limits. It does not itself create a deduction.'],['Redispute','Pauses eligible recovery while the station submits evidence. Disabling resumes eligible recovery.']]),'Instructions');
  XLSX.writeFile(book,'loss-exceptions-template.xlsx');
 }
 async function upload(file:File){
  setMessage('');setPreview([]);
  try{
   if(file.size>2*1024*1024)throw Error('Use a workbook smaller than 2 MB.');
   const XLSX=await import('xlsx'),book=XLSX.read(await file.arrayBuffer(),{type:'array'});
   const input=XLSX.utils.sheet_to_json<Record<string,string>>(book.Sheets[book.SheetNames[0]],{raw:false});
   if(!input.length||input.length>100)throw Error('Provide 1–100 exception updates.');
   const parsed:Update[]=[],seen=new Set<string>();
   for(const [i,v]of input.entries()){
    const month=String(v['Loss month']||'').trim(),id=String(v['Shipment ID']||'').trim(),station=String(v.Station||'').trim().toUpperCase();
    const match=eligible.filter(r=>r.month===month&&(r.case_key===id||r.details.tid===id)&&r.station_code.toUpperCase()===station);
    if(match.length!==1)throw Error(`Row ${i+2}: final recoverable TID not found uniquely in your permitted stations.`);
    const k=(Object.keys(LOSS_EXCEPTION_LABELS) as LossExceptionKind[]).find(k=>LOSS_EXCEPTION_LABELS[k].toLowerCase()===String(v.Exception||'').trim().toLowerCase());
    const action=String(v.Action||'').trim().toLowerCase(),note=String(v.Reason||'').trim();
    if(!k||!['enable','disable'].includes(action)||note.length<10||note.length>2000)throw Error(`Row ${i+2}: choose a supported exception, Enable/Disable and a reason (10–2000 characters).`);
    const key=`${month}|${match[0].case_key}|${k}`;if(seen.has(key))throw Error(`Row ${i+2}: duplicate TID and exception.`);seen.add(key);
    parsed.push(update(match[0],k,action==='enable',note));
   }setPreview(parsed);
  }catch(e){setMessage(e instanceof Error?e.message:'Unable to read workbook.');}
 }
 return <section className={styles.panel}>
  <div className={styles.panelHead}><div><h2>Enable exceptions</h2><small>Choose a final TID or upload a bulk list. Stations can use only enabled options.</small></div></div>
  <p className={styles.notice}>Redispute pauses recovery for station evidence. Deduct next month permits one specific payroll month. Recurring debit permits instalments within amount and salary limits. Disabling an option prevents new plans; existing approved payroll schedules remain intact.</p>
  <div className={styles.toolbar} style={{padding:16}}>
   <input aria-label="Search exception cases" placeholder="TID, station or loss month" value={query} onChange={e=>setQuery(e.target.value)}/>
   <label>Exception<select value={kind} onChange={e=>setKind(e.target.value as LossExceptionKind)}>{Object.entries(LOSS_EXCEPTION_LABELS).map(([k,l])=><option key={k} value={k}>{l}</option>)}</select></label>
   <label>Reason<input value={reason} minLength={10} maxLength={2000} placeholder="Why this exception is needed" onChange={e=>setReason(e.target.value)}/></label>
   <button className={styles.button} onClick={()=>void template()}>Download template</button>
   {canEdit?<label className={styles.button}>Upload TIDs<input hidden type="file" accept=".xlsx,.csv" disabled={busy} onChange={e=>{const f=e.target.files?.[0];if(f)void upload(f);e.target.value='';}}/></label>:null}
  </div>
  {message?<p role="status" className={styles.notice}>{message}</p>:null}
  {preview.length?<details open className={styles.compactDetails}><summary>Review {preview.length} updates</summary>{preview.map(r=><p key={`${r.month}|${r.case_key}|${r.kind}`}>{r.station} · {r.case_key} · {r.month} · {LOSS_EXCEPTION_LABELS[r.kind]} · {r.enabled?'Enable':'Disable'} · {r.reason}</p>)}<button className={styles.primary} disabled={busy||!canEdit} onClick={()=>void apply(preview)}>Apply {preview.length} updates</button><button className={styles.button} disabled={busy} onClick={()=>setPreview([])}>Cancel</button></details>:null}
  <div className={styles.tableWrap}><table className={styles.ledgerTable}><thead><tr><th>TID / loss month</th><th>Station</th><th>Enabled options</th><th>Action</th></tr></thead><tbody>
   {paged.rows.map(r=>{const state=current(r,kind);return <tr key={`${r.month}|${r.case_key}`}><td>{r.details.tid||r.case_key}<small>{r.month}</small></td><td>{r.station_code}</td><td>{(Object.keys(LOSS_EXCEPTION_LABELS) as LossExceptionKind[]).map(k=>{const g=current(r,k);return g?.enabled?<div key={k}>{LOSS_EXCEPTION_LABELS[k]}{'deduction_month'in g&&g.deduction_month?` · ${g.deduction_month}`:''}<small>{g.updated_by_name}{'reason'in g?` · ${g.reason}`:''}</small></div>:null;})}</td><td><button className={styles.button} disabled={!canEdit||busy||(reason.trim().length<10 && !(kind==='redispute'&&state?.enabled))} onClick={()=>void apply([update(r,kind,!state?.enabled,reason.trim().length>=10 ? reason : 'No longer required')])}>{state?.enabled?'Disable':'Enable'} {LOSS_EXCEPTION_LABELS[kind]}</button></td></tr>;})}
  </tbody></table></div>{!shown.length?<p className={styles.empty}>No final recoverable TIDs match your search.</p>:null}
  <ListPager page={paged.page} pages={paged.pages} size={paged.size} total={paged.total} onPage={paged.setPage} onSize={paged.setSize} label="TIDs"/>
 </section>;
}
