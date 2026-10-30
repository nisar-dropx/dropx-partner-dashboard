"use client";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { LossPidTimeline } from "./loss-pid-timeline";
import { redisputeStage, redisputeStatus } from "@/lib/ops-pulse/loss-redispute-queue";
import type { NlCase } from "@/lib/ops-pulse/nl-loss-policy";
import type { StationEvidence } from "@/lib/ops-pulse/loss-station-evidence";
import { ListPager, usePaged } from "./list-pager";
import styles from "./nl-loss.module.css";
import ui from "./loss-exceptions-desk.module.css";
export type RedisputeWindow = {
  submitted_by?: string | null;
  response_details?: Partial<StationEvidence>;
  version: number;
  workflow_status?: string;
  recovery_month?: string;
  month: string;
  case_key: string;
  enabled: boolean;
  tt_reference: string | null;
  tt_url: string | null;
  followup_status: string;
  followup_on: string | null;
  updated_by_name: string | null;
  updated_at: string;
};

const keyOf=(w:{month:string;case_key:string})=>`${w.month}|${w.case_key}`;
const stages=[['open','Active'],['station','Awaiting station'],['review','Awaiting review'],['ticket','Ticket follow-up'],['closed','Closed / disabled'],['all','All']] as const;
export function LossRedisputeDesk({rows,windows,canActivate}:{rows:NlCase[];windows:RedisputeWindow[];canActivate:boolean}) {
  const [overrides,setOverrides]=useState<Record<string,RedisputeWindow>>({});
  const [selected,setSelected]=useState<string[]>([]),[confirm,setConfirm]=useState(false);
  const [note,setNote]=useState('No longer required');
  const [historyCase,setHistoryCase]=useState<RedisputeWindow|null>(null);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const [errors,setErrors]=useState<string[]>([]);
  const [query,setQuery]=useState(''),[stage,setStage]=useState('open');
  const applying=useRef(false);
  const byKey=useMemo(()=>new Map(rows.map(r=>[keyOf(r),r])),[rows]);
  const current=windows.map(w=>overrides[keyOf(w)]||w);
  const searched=current.filter(w=>[w.case_key,w.tt_reference,byKey.get(keyOf(w))?.station_code].join(' ').toLowerCase().includes(query.trim().toLowerCase()));
  const matches=(w:RedisputeWindow,s:string)=>s==='all'||(s==='open'?redisputeStage(w)!=='closed':redisputeStage(w)===s);
  const shown=searched.filter(w=>matches(w,stage));
  const paged=usePaged(shown,25,`${stage}|${query}`);
  const selectable=paged.rows.filter(w=>w.enabled);
  const chosen=current.filter(w=>w.enabled&&selected.includes(keyOf(w)));
  const href=(w:RedisputeWindow)=>'/team-ops/losses/vendor-response?'+new URLSearchParams({month:w.month,case:w.case_key});
  function clearSelection(){setSelected([]);setConfirm(false);}
  async function disable(){
    if(!canActivate||!chosen.length||applying.current)return;
    applying.current=true;setBusy(true);setMessage('');setErrors([]);
    try{
      const res=await fetch('/api/ops-pulse/losses/exceptions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rows:chosen.map(w=>({month:w.month,case_key:w.case_key,kind:'redispute',enabled:false,version:w.version,reason:note}))})});
      const body=await res.json();
      if(!res.ok)throw Error(body.error||'Unable to disable redisputes.');
      type Result={month:string;case_key:string;ok:boolean;value?:RedisputeWindow;current?:RedisputeWindow;error?:string};
      if(!Array.isArray(body.results)||body.results.length!==chosen.length)throw Error('Unable to confirm saved status. Reopen this view before retrying.');
      const results:Result[]=body.results;
      setOverrides(prev=>{const next={...prev};for(const r of results){const w=r.ok?r.value:r.current;if(w)next[keyOf(r)]=w;}return next;});
      const succeeded=results.filter(r=>r.ok);
      setSelected(prev=>prev.filter(k=>!succeeded.some(r=>keyOf(r)===k)));
      setErrors(results.filter(r=>!r.ok).map(r=>`${r.case_key}: ${r.error||'Could not save.'}`));
      setMessage(`${succeeded.length} disabled. History retained; eligible recovery resumes.`);
      setConfirm(false);
    }catch(e){setMessage(e instanceof Error?e.message:'Unable to disable redisputes.');}
    finally{applying.current=false;setBusy(false);}
  }
  return <section className={`${styles.panel} ${ui.desk}`} aria-busy={busy}>
    <div className={styles.panelHead}><div><h2>Redispute tracking</h2><small>Station evidence → authorised review → vendor ticket → final outcome</small></div>
      <input aria-label="Find redispute or Shipment ID" placeholder="Search Shipment ID, station or ticket" value={query} disabled={busy} onChange={e=>{setQuery(e.target.value);clearSelection();}}/>
    </div>
    <div className={ui.controls}>{stages.map(([s,label])=><button type="button" key={s} className={stage===s?styles.primary:styles.button} aria-pressed={stage===s} disabled={busy} onClick={()=>{setStage(s);clearSelection();}}>{label} · {searched.filter(w=>matches(w,s)).length}</button>)}</div>
    <p className={ui.help}>Stations submit from NL / SLP Final → shipment → Recovery action → Redispute. Review the evidence here, then file the ticket in the vendor portal and record its reference.</p>
    {canActivate?<div className={ui.actions}><strong>{chosen.length} selected</strong><button type="button" className={styles.button} disabled={busy||!chosen.length} onClick={()=>setConfirm(true)}>Disable selected ({chosen.length})</button>{selected.length?<button type="button" className={styles.button} disabled={busy} onClick={clearSelection}>Clear</button>:null}<small>Select up to 100 enabled shipments.</small></div>:null}
    {confirm&&chosen.length?<div className={styles.redisputeRemove}><strong>Disable {chosen.length} redisputes?</strong><select aria-label="Disable reason" value={note} disabled={busy} onChange={e=>setNote(e.target.value)}>{['No longer required','Enabled by mistake','Continue with recovery','Duplicate redispute'].map(n=><option key={n}>{n}</option>)}</select><button type="button" className={styles.primary} disabled={busy} onClick={()=>void disable()}>{busy?'Disabling…':'Confirm disable'}</button><button type="button" className={styles.button} disabled={busy} onClick={()=>setConfirm(false)}>Cancel</button><small>Station submissions close and eligible recovery resumes. Evidence and history remain available.</small></div>:null}
    {message?<div role="status" className={ui.result}>{message}{errors.length?<ul>{errors.map((e,i)=><li key={i}>{e}</li>)}</ul>:null}</div>:null}
    <div className={styles.tableWrap}><table className={styles.ledgerTable}><thead><tr>
      {canActivate?<th><input type="checkbox" aria-label="Select enabled redisputes on this page" disabled={busy||!selectable.length} checked={!!selectable.length&&selectable.every(w=>selected.includes(keyOf(w)))} onChange={e=>{setSelected(e.target.checked?selectable.slice(0,100).map(keyOf):[]);setConfirm(false);}}/></th>:null}
      <th>Shipment / station</th><th>Status</th><th>Station evidence</th><th>Ticket reference</th><th>Last update / follow-up</th><th>Action</th>
    </tr></thead><tbody>{paged.rows.map(w=>{const row=byKey.get(keyOf(w)),response=w.response_details;return <tr key={keyOf(w)}>
      {canActivate?<td><input type="checkbox" aria-label={`Select ${w.case_key}, ${w.month}`} checked={selected.includes(keyOf(w))&&w.enabled} disabled={busy||!w.enabled||(!selected.includes(keyOf(w))&&chosen.length>=100)} onChange={e=>{setSelected(prev=>e.target.checked?[...prev,keyOf(w)]:prev.filter(k=>k!==keyOf(w)));setConfirm(false);}}/></td>:null}
      <td><Link href={href(w)}>{row?.details.tid||w.case_key}</Link><small>{row?.station_code} · {w.month}</small></td>
      <td>{redisputeStatus(w)}{w.recovery_month?<small>Payroll {w.recovery_month}</small>:null}</td>
      <td>{response?.reason?<details><summary>{response.reason}</summary><p>{response.note}</p>{response.tt_reference?<small>Cloak ticket: {response.tt_reference}</small>:null}{response.evidence_url&&/^https:\/\//i.test(response.evidence_url)?<a href={response.evidence_url} target="_blank" rel="noreferrer">Supporting files ↗</a>:null}{response.cctv_not_required === true ? <small>CCTV not required</small> : response.cctv_url && /^https:\/\//i.test(response.cctv_url) ? <small><a href={response.cctv_url} target="_blank" rel="noreferrer">CCTV footage ↗</a></small> : null}</details>:<span>Not submitted</span>}</td>
      <td>{w.tt_url&&/^https?:\/\//i.test(w.tt_url)?<a href={w.tt_url} target="_blank" rel="noreferrer">{w.tt_reference||'Open ticket'} ↗</a>:w.tt_reference||'Not filed'}</td>
      <td>{w.updated_by_name}<small>{new Date(w.updated_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})}</small>{w.followup_on?<small>Follow-up {w.followup_on}</small>:null}</td>
      <td><Link className={styles.button} href={href(w)}>{redisputeStage(w)==='review'?'Review evidence':redisputeStage(w)==='ticket'?'Ticket / outcome':'View details'}</Link> {canActivate && redisputeStage(w)==='review' ? <Link className={styles.button} href={`${href(w)}&action=return`}>Return for correction</Link> : null} <button type="button" className={styles.button} onClick={()=>setHistoryCase(w)}>History</button></td>
    </tr>;})}</tbody></table></div>
    {!shown.length?<p className={styles.empty}>No redisputes match this view.</p>:null}
    {historyCase?<LossPidTimeline key={keyOf(historyCase)} month={historyCase.month} caseKey={historyCase.case_key} revision={current.find(w=>keyOf(w)===keyOf(historyCase))?.updated_at} initiallyOpen/>:null}
    <ListPager page={paged.page} pages={paged.pages} size={paged.size} total={paged.total} onPage={paged.setPage} onSize={paged.setSize} label="redisputes"/>
  </section>;
}
