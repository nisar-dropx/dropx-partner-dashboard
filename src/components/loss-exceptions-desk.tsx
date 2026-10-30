"use client";
import { useRef, useState } from 'react';
import { LOSS_EXCEPTION_LABELS, type LossExceptionKind, type LossExceptionGrant } from '@/lib/ops-pulse/loss-exceptions';
import { canEnableException, exceptionKey, parseExceptionBatch, type ExceptionUpdate } from '@/lib/ops-pulse/loss-exception-batch';
import type { NlCase } from '@/lib/ops-pulse/nl-loss-policy';
import type { RedisputeWindow } from './loss-redispute-desk';
import { ListPager, usePaged } from './list-pager';
import styles from './nl-loss.module.css';
import ui from './loss-exceptions-desk.module.css';

type State = LossExceptionGrant | RedisputeWindow;
type Result = {month:string; case_key:string; kind:LossExceptionKind; ok:boolean; value?:State; current?:State; error?:string};
const kinds = Object.keys(LOSS_EXCEPTION_LABELS) as LossExceptionKind[];
const money = (n:number) => new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:2}).format(n);
export function LossExceptionsDesk({rows,grants,windows,canEdit,recoverableStatuses}:{rows:NlCase[];grants:LossExceptionGrant[];windows:RedisputeWindow[];canEdit:boolean;recoverableStatuses:string[]}) {
  const [query,setQuery] = useState(''), [kind,setKind] = useState<LossExceptionKind>('redispute');
  const [filter,setFilter] = useState('all'), [reason,setReason] = useState('');
  const [selected,setSelected] = useState<string[]>([]), [overrides,setOverrides] = useState<Record<string,State>>({});
  const [busy,setBusy] = useState(false), [message,setMessage] = useState(''), [failed,setFailed] = useState<Result[]>([]);
  const [preview,setPreview] = useState<ExceptionUpdate[]>([]);
  const applying = useRef(false);
  function current(r:{month:string;case_key:string},k:LossExceptionKind):State|undefined {
    return overrides[exceptionKey(r,k)] || (k==='redispute' ? windows.find(w=>exceptionKey(w)===exceptionKey(r)) : grants.find(g=>exceptionKey(g)===exceptionKey(r)&&g.kind===k));
  }
  const candidates = rows.filter(r=>canEnableException(r,recoverableStatuses)||kinds.some(k=>current(r,k)?.enabled));
  const shown = candidates.filter(r=>[r.month,r.station_code,r.case_key,r.details?.tid].join(' ').toLowerCase().includes(query.trim().toLowerCase()) &&
    (filter==='all'||!!current(r,kind)?.enabled===(filter==='enabled')));
  const paged = usePaged(shown,25,`${query}|${filter}|${kind}`);
  const chosen = candidates.filter(r=>selected.includes(exceptionKey(r)));
  const enableRows = chosen.filter(r=>canEnableException(r,recoverableStatuses)&&!current(r,kind)?.enabled);
  const disableRows = chosen.filter(r=>current(r,kind)?.enabled);
  const enabledCount = shown.filter(r=>current(r,kind)?.enabled).length;
  function update(r:NlCase,enabled:boolean):ExceptionUpdate {
    return {month:r.month,case_key:r.case_key,station:r.station_code,kind,enabled,version:current(r,kind)?.version||0,reason:reason.trim()};
  }
  function toggle(r:NlCase) {
    const key=exceptionKey(r);
    setSelected(prev=>prev.includes(key)?prev.filter(k=>k!==key):prev.length<100?[...prev,key]:prev);
  }
  async function apply(input:ExceptionUpdate[]) {
    if(!canEdit||applying.current||!input.length)return;
    applying.current=true;setBusy(true);setMessage('');setFailed([]);
    try {
      // A partial bulk retry uses the most recent confirmed version for each row.
      const updates=input.map(r=>({...r,version:current(r,r.kind)?.version||r.version}));
      const res=await fetch('/api/ops-pulse/losses/exceptions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rows:updates})});
      const body=await res.json();
      if(!res.ok)throw Error(body.error||'Could not save exceptions.');
      if(!Array.isArray(body.results)||body.results.length!==updates.length)throw Error('Unable to confirm the saved status. Reload before retrying.');
      const results:Result[]=body.results;
      setOverrides(prev=>{const next={...prev};for(const r of results){const value=r.ok?r.value:r.current;if(value)next[exceptionKey(r,r.kind)]=value;}return next;});
      const errors=results.filter(r=>!r.ok), successes=results.filter(r=>r.ok);
      setFailed(errors);
      setMessage(`${successes.length} saved${errors.length?` · ${errors.length} need attention`:''}.`);
      const failedKeys=new Set(errors.map(r=>exceptionKey(r,r.kind)));
      setPreview(updates.filter(r=>failedKeys.has(exceptionKey(r,r.kind))));
      setSelected(prev=>prev.filter(key=>!successes.some(r=>exceptionKey(r)===key)));
    } catch(e) {
      setMessage(e instanceof Error?e.message:'Could not save exceptions.');
      setPreview(input);
    } finally {applying.current=false;setBusy(false);}
  }
  async function template() {
    try {
      const XLSX=await import('xlsx'),book=XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Loss month','Shipment ID','Station','Exception','Action','Reason']]),'Exceptions');
      XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([
        ['Field','Instructions'],['Loss month','YYYY-MM'],['Shipment ID','Exact Shipment ID, formatted as text'],['Station','Station code'],
        ['Exception','Redispute / Deduct next month / Recurring debit / Write-off'],['Action','Enable / Disable'],['Reason','Optional manager note; up to 2,000 characters'],
        ['Limit','100 updates. One row per shipment, loss month and exception. Preview before applying.'],
        ['Example (illustrative)','2026-09 | SAMPLE-SHIPMENT | SAMPLE-STATION | Redispute | Enable |'],
        ['Redispute','Enable pauses eligible recovery for station evidence. Disable revokes access and resumes eligible recovery.'],
        ['Other exceptions','Enable permits a station plan within existing rules. Disable prevents new plans; approved schedules remain intact.']]),'Instructions');
      XLSX.writeFile(book,'loss-exceptions-template.xlsx');
    } catch {setMessage('Template could not be downloaded. Please retry.');}
  }
  async function upload(file:File) {
    setMessage('');setPreview([]);setFailed([]);
    try {
      if(file.size>2*1024*1024)throw Error('Use a workbook smaller than 2 MB.');
      const XLSX=await import('xlsx'),book=XLSX.read(await file.arrayBuffer(),{type:'array'});
      const input=XLSX.utils.sheet_to_json<Record<string,string>>(book.Sheets[book.SheetNames[0]],{raw:false});
      setPreview(parseExceptionBatch(input,rows,recoverableStatuses,current));
      setSelected([]);
    } catch(e) {setMessage(e instanceof Error?e.message:'Unable to read workbook.');}
  }
  return <section className={`${styles.panel} ${ui.desk}`} aria-busy={busy}>
    <div className={styles.panelHead}><div><h2>Shipment exceptions</h2><small>To disable: filter Enabled → select shipments → Disable selected. Excel supports both actions.</small></div>
      <div className={styles.toolbar}><button type="button" className={styles.button} disabled={busy} onClick={()=>void template()}>Download template</button>
        {canEdit?<label className={`${styles.button} ${ui.upload}`}>Upload Excel<input aria-label="Upload exception workbook" hidden type="file" accept=".xlsx,.csv" disabled={busy} onChange={e=>{const file=e.target.files?.[0];if(file)void upload(file);e.target.value='';}}/></label>:null}</div>
    </div>
    <div className={ui.controls}>
      <label className={ui.search}>Shipment / station<input aria-label="Search exception cases" placeholder="Search Shipment ID, station or loss month" value={query} disabled={busy} onChange={e=>{setQuery(e.target.value);setSelected([]);}}/></label>
      <label>Exception<select value={kind} disabled={busy} onChange={e=>{setKind(e.target.value as LossExceptionKind);setSelected([]);}}>{Object.entries(LOSS_EXCEPTION_LABELS).map(([k,l])=><option key={k} value={k}>{l}</option>)}</select></label>
      <label>Status<select value={filter} disabled={busy} onChange={e=>{setFilter(e.target.value);setSelected([]);}}><option value="all">All statuses</option><option value="disabled">Not enabled</option><option value="enabled">Enabled</option></select></label>
      <span className={ui.count}>{shown.length} shipments · {enabledCount} enabled</span>
    </div>
    <p className={ui.help}>{kind==='write_off'?'Allows an authorised approver to write off the remaining exit balance in Recovery after the salary adjustment is completed. Enabling this does not write off any amount.':kind==='redispute'?'Enable collects evidence from the station and pauses eligible recovery. Disable revokes that access.':kind==='next_month'?'Allows the next applicable payroll month. Approved schedules stay unchanged when disabled.':'Allows instalments within the recovery rules. Approved schedules stay unchanged when disabled.'}</p>
    {!canEdit?<p className={ui.help}>View only. An authorised loss manager with edit access can enable or disable exceptions.</p>:null}
    {chosen.length?<div className={ui.actions}>
      <strong>{chosen.length} selected</strong><input aria-label="Manager note (optional)" value={reason} maxLength={2000} disabled={busy} placeholder="Manager note (optional)" onChange={e=>setReason(e.target.value)}/>
      <button type="button" className={styles.primary} disabled={busy||!enableRows.length} onClick={()=>void apply(enableRows.map(r=>update(r,true)))}>{busy?'Saving…':`Enable ${LOSS_EXCEPTION_LABELS[kind]} (${enableRows.length})`}</button>
      <button type="button" className={styles.button} disabled={busy||!disableRows.length} onClick={()=>void apply(disableRows.map(r=>update(r,false)))}>Disable selected ({disableRows.length})</button>
      <button type="button" className={styles.button} disabled={busy} onClick={()=>setSelected([])}>Clear</button>
    </div>:null}
    {message?<div role="status" className={ui.result}>{message}{failed.length?<ul>{failed.map(r=><li key={exceptionKey(r,r.kind)}>{r.case_key} · {LOSS_EXCEPTION_LABELS[r.kind]}: {r.error}</li>)}</ul>:null}</div>:null}
    {preview.length?<div className={ui.preview}>
      <div className={ui.actions}><strong>Review {preview.length} updates</strong><button type="button" className={styles.primary} disabled={busy||!canEdit} onClick={()=>void apply(preview)}>{busy?'Saving…':`Apply ${preview.length} updates`}</button><button type="button" className={styles.button} disabled={busy} onClick={()=>setPreview([])}>Cancel</button></div>
      <div className={ui.previewScroll}><table className={styles.ledgerTable}><thead><tr><th>Shipment / station</th><th>Loss month</th><th>Exception</th><th>Action</th><th>Note</th></tr></thead><tbody>{preview.map(r=><tr key={exceptionKey(r,r.kind)}><td>{r.case_key}<small>{r.station}</small></td><td>{r.month}</td><td>{LOSS_EXCEPTION_LABELS[r.kind]}</td><td>{r.enabled?'Enable':'Disable'}</td><td>{r.reason||'—'}</td></tr>)}</tbody></table></div>
    </div>:null}
    <div className={styles.tableWrap}><table className={styles.ledgerTable}><thead><tr>
      <th>{canEdit?<input type="checkbox" aria-label="Select this page" disabled={busy||!paged.rows.length} checked={!!paged.rows.length&&paged.rows.every(r=>selected.includes(exceptionKey(r)))} onChange={e=>setSelected(e.target.checked?paged.rows.map(r=>exceptionKey(r)):[])}/>:null}</th>
      <th>Shipment ID / loss month</th><th>Station</th><th>Loss value</th><th>{LOSS_EXCEPTION_LABELS[kind]}</th><th>Other enabled options</th>
    </tr></thead><tbody>{paged.rows.map(r=>{const state=current(r,kind);return <tr key={exceptionKey(r)} className={selected.includes(exceptionKey(r))?ui.selected:undefined}>
      <td>{canEdit?<input type="checkbox" aria-label={`Select ${r.details?.tid||r.case_key}, ${r.month}, ${r.station_code}`} disabled={busy||(!selected.includes(exceptionKey(r))&&selected.length>=100)} checked={selected.includes(exceptionKey(r))} onChange={()=>toggle(r)}/>:null}</td>
      <td><strong>{r.details?.tid||r.case_key}</strong><small>{r.month}</small></td><td>{r.station_code}</td><td>{money(r.amount)}</td>
      <td><span className={state?.enabled?ui.enabled:ui.disabled}>{state?.enabled?'Enabled':'Not enabled'}</span>{state?.updated_by_name?<small>{state.updated_by_name}</small>:null}{state&&'deduction_month'in state&&state.deduction_month?<small>Payroll {state.deduction_month}</small>:null}{!canEnableException(r,recoverableStatuses)?<small>Source changed · disable only</small>:null}</td>
      <td>{kinds.filter(k=>k!==kind&&current(r,k)?.enabled).map(k=>LOSS_EXCEPTION_LABELS[k]).join(' · ')||'—'}</td>
    </tr>;})}</tbody></table></div>
    {!shown.length?<p className={styles.empty}>No matching final recoverable shipments. Check the Shipment ID and status filter.</p>:null}
    <ListPager page={paged.page} pages={paged.pages} size={paged.size} total={paged.total} onPage={paged.setPage} onSize={paged.setSize} label="shipments"/>
  </section>;
}
