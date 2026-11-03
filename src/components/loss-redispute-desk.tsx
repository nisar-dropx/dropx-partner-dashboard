"use client";
import { ReportTable } from "@/components/report-table";

import { LossCaseResponse } from "./loss-case-response";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { LossPidTimeline } from "./loss-pid-timeline";
import { redisputeFollowup, redisputeStage, redisputeStatus } from "@/lib/ops-pulse/loss-redispute-queue";
import { compareReportValues } from "@/lib/report-table-values";
import type { ExcelReport } from "@/lib/download-report-excel";
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
type Station = { station: string; clusterKeys: string[]; region: string };
type SortKey = 'shipment' | 'value' | 'status' | 'evidence' | 'ticket' | 'updated';
export function LossRedisputeDesk({rows,windows,canActivate,stations=[],clusterOptions=[]}:{rows:NlCase[];windows:RedisputeWindow[];canActivate:boolean;stations?:Station[];clusterOptions?:{value:string;label:string}[]}) {
  const [editing, setEditing] = useState<{ window: RedisputeWindow; action?: 'return' } | null>(null);
  const editor = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (editing) editor.current?.showModal(); }, [editing]);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [followup, setFollowup] = useState('');
  const [overrides,setOverrides]=useState<Record<string,RedisputeWindow>>({});
  const [selected,setSelected]=useState<string[]>([]),[confirm,setConfirm]=useState(false);
  const [note,setNote]=useState('No longer required');
  const [historyCase,setHistoryCase]=useState<RedisputeWindow|null>(null);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const [errors,setErrors]=useState<string[]>([]);
  const [query,setQuery]=useState(''),[stage,setStage]=useState('open');
  const [station,setStation]=useState(''),[cluster,setCluster]=useState(''),[region,setRegion]=useState(''),[submission,setSubmission]=useState('');
  const [sorting,setSorting]=useState<{key:SortKey;direction:'asc'|'desc'}>({key:'updated',direction:'desc'});
  const stationByCode=useMemo(()=>new Map(stations.map(s=>[s.station,s])),[stations]);
  const clusterLabels=useMemo(()=>new Map(clusterOptions.map(c=>[c.value,c.label])),[clusterOptions]);
  const applying=useRef(false);
  const byKey=useMemo(()=>new Map(rows.map(r=>[keyOf(r),r])),[rows]);
  const current=windows.map(w=>overrides[keyOf(w)]||w);
  const submitted=(w:RedisputeWindow)=>!!w.response_details?.reason;
  const searched=current.filter(w=>{
    const row=byKey.get(keyOf(w)),meta=stationByCode.get(row?.station_code||'');
    return [w.case_key,w.tt_reference,row?.station_code,w.response_details?.tt_reference].join(' ').toLowerCase().includes(query.trim().toLowerCase())
      && (!station||row?.station_code===station) && (!cluster||meta?.clusterKeys.includes(cluster)) && (!region||(meta?.region||'Unmapped')===region)
      && (!followup || redisputeFollowup(w, today) === followup)
      && (!submission||(submission==='submitted'?submitted(w):submission==='returned'?w.workflow_status==='returned':!submitted(w)));
  });
  const matches=(w:RedisputeWindow,s:string)=>s==='all'||(s==='open'?redisputeStage(w)!=='closed':redisputeStage(w)===s);
  const sortValue=(w:RedisputeWindow,key:SortKey)=>{
    const row=byKey.get(keyOf(w));
    return key==='shipment'?String(row?.details.tid||w.case_key):key==='value'?String(row?.amount??''):key==='status'?redisputeStatus(w):key==='evidence'?w.response_details?.reason||'':key==='ticket'?w.tt_reference||'':w.updated_at;
  };
  const shown=searched.filter(w=>matches(w,stage)).sort((a,b)=>compareReportValues(sortValue(a,sorting.key),sortValue(b,sorting.key),sorting.direction));
  const paged=usePaged(shown,25,`${stage}|${query}|${station}|${cluster}|${region}|${submission}|${sorting.key}|${sorting.direction}|${followup}`);
  function sortHeader(key:SortKey,label:string){const active=sorting.key===key;return <th aria-sort={active?(sorting.direction==='asc'?'ascending':'descending'):'none'}><button type="button" className={ui.sortHeader} onClick={()=>setSorting({key,direction:active&&sorting.direction==='asc'?'desc':'asc'})}>{label}<span aria-hidden="true">{active?(sorting.direction==='asc'?' ↑':' ↓'):' ↕'}</span></button></th>;}
  function exportReport():ExcelReport{return {
    title:'Redispute tracking',scope:`All ${shown.length} matching records; stage: ${stage}; station: ${station||'all'}; cluster: ${clusterLabels.get(cluster)||'all'}; region: ${region||'all'}; submission: ${submission||'all'}; search: ${query||'none'}; follow-up: ${followup||'all'}`,
    headers:['Shipment ID','Station','Cluster / AOM','Region','Loss type','Loss month','Shipment value (INR)','Status','Station submission','Reason','Description','Cloak ticket ID','Supporting files','CCTV not required','CCTV link','Vendor ticket reference','Vendor ticket URL','Follow-up date','Updated by','Updated at (IST)','Recovery payroll month'],
    rows:shown.map(w=>{const row=byKey.get(keyOf(w)),meta=stationByCode.get(row?.station_code||''),e=w.response_details;return [String(row?.details.tid||w.case_key),row?.station_code||'',meta?.clusterKeys.map(k=>clusterLabels.get(k)||k).join(', ')||'',meta?.region||'',row?.report?.toUpperCase()||'',w.month,row?.amount??null,redisputeStatus(w),submitted(w)?'Submitted':'Pending',e?.reason||'',e?.note||'',e?.tt_reference||'',e?.evidence_url||'',e?.cctv_not_required?'Yes':'No',e?.cctv_url||'',['approved','awaiting_station','awaiting_review','returned'].includes(w.workflow_status||'')?'':w.tt_reference||'',w.tt_url||'',w.followup_on||'',w.updated_by_name||'',new Date(w.updated_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}),w.recovery_month||''];})
  };}
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
    <div className={styles.panelHead}><div><h2>Redispute tracking</h2><small>{shown.length} shipments · ₹{shown.reduce((sum,w)=>sum+(byKey.get(keyOf(w))?.amount||0),0).toLocaleString('en-IN',{maximumFractionDigits:2})}</small></div>
      <input aria-label="Find redispute or Shipment ID" placeholder="Search Shipment ID, station or ticket" value={query} disabled={busy} onChange={e=>{setQuery(e.target.value);clearSelection();}}/>
    </div>
    <div className={ui.controls}>
      <label>Station<select value={station} disabled={busy} onChange={e=>{setStation(e.target.value);clearSelection();}}><option value="">All stations</option>{stations.map(s=><option key={s.station} value={s.station}>{s.station}</option>)}</select></label>
      <label>Cluster / AOM<select value={cluster} disabled={busy} onChange={e=>{setCluster(e.target.value);clearSelection();}}><option value="">All clusters / AOMs</option>{clusterOptions.map(c=><option key={c.value} value={c.value}>{c.label}</option>)}</select></label>
      <label>Region<select value={region} disabled={busy} onChange={e=>{setRegion(e.target.value);clearSelection();}}><option value="">All regions</option>{Array.from(new Set(stations.map(s=>s.region||'Unmapped'))).sort().map(r=><option key={r}>{r}</option>)}</select></label>
      <label>Station update<select value={submission} disabled={busy} onChange={e=>{setSubmission(e.target.value);clearSelection();}}><option value="">All updates</option><option value="pending">Not submitted</option><option value="submitted">Submitted</option><option value="returned">Returned for correction</option></select></label>
      <label>Follow-up<select value={followup} disabled={busy} onChange={e=>{setFollowup(e.target.value);clearSelection();}}><option value="">All dates</option><option value="overdue">Overdue</option><option value="today">Due today</option><option value="upcoming">Upcoming</option></select></label>
      <button type="button" className={styles.button} disabled={busy} onClick={()=>{setFollowup('');setStation('');setCluster('');setRegion('');setSubmission('');setQuery('');setStage('open');clearSelection();}}>Reset</button>
    </div>
    <div className={ui.controls}>{stages.map(([s,label])=><button type="button" key={s} className={stage===s?styles.primary:styles.button} aria-pressed={stage===s} disabled={busy} onClick={()=>{setStage(s);clearSelection();}}>{label} · {searched.filter(w=>matches(w,s)).length}</button>)}</div>
    <p className={ui.help}>Station evidence → SLP confirmation → Amazon ticket → follow-up → outcome.</p>
    {canActivate?<div className={ui.actions}><strong>{chosen.length} selected</strong><button type="button" className={styles.button} disabled={busy||!chosen.length} onClick={()=>setConfirm(true)}>Disable selected ({chosen.length})</button>{selected.length?<button type="button" className={styles.button} disabled={busy} onClick={clearSelection}>Clear</button>:null}<small>Select up to 100 enabled shipments.</small></div>:null}
    {confirm&&chosen.length?<div className={styles.redisputeRemove}><strong>Disable {chosen.length} redisputes?</strong><select aria-label="Disable reason" value={note} disabled={busy} onChange={e=>setNote(e.target.value)}>{['No longer required','Enabled by mistake','Continue with recovery','Duplicate redispute'].map(n=><option key={n}>{n}</option>)}</select><button type="button" className={styles.primary} disabled={busy} onClick={()=>void disable()}>{busy?'Disabling…':'Confirm disable'}</button><button type="button" className={styles.button} disabled={busy} onClick={()=>setConfirm(false)}>Cancel</button><small>Station submissions close and eligible recovery resumes. Evidence and history remain available.</small></div>:null}
    {message?<div role="status" className={ui.result}>{message}{errors.length?<ul>{errors.map((e,i)=><li key={i}>{e}</li>)}</ul>:null}</div>:null}
    <div className={styles.tableWrap}><ReportTable className={styles.ledgerTable} reportExport={exportReport}><thead><tr>
      {canActivate?<th><input type="checkbox" aria-label="Select enabled redisputes on this page" disabled={busy||!selectable.length} checked={!!selectable.length&&selectable.every(w=>selected.includes(keyOf(w)))} onChange={e=>{setSelected(e.target.checked?selectable.slice(0,100).map(keyOf):[]);setConfirm(false);}}/></th>:null}
      {sortHeader('shipment','Shipment / station')}{sortHeader('value','Value')}{sortHeader('status','Status')}<th>Action</th>{sortHeader('evidence','Station evidence')}{sortHeader('ticket','Ticket reference')}{sortHeader('updated','Last update / follow-up')}
    </tr></thead><tbody>{paged.rows.map(w=>{const row=byKey.get(keyOf(w)),response=w.response_details;return <tr key={keyOf(w)}>
      {canActivate?<td><input type="checkbox" aria-label={`Select ${w.case_key}, ${w.month}`} checked={selected.includes(keyOf(w))&&w.enabled} disabled={busy||!w.enabled||(!selected.includes(keyOf(w))&&chosen.length>=100)} onChange={e=>{setSelected(prev=>e.target.checked?[...prev,keyOf(w)]:prev.filter(k=>k!==keyOf(w)));setConfirm(false);}}/></td>:null}
      <td><Link href={href(w)}>{row?.details.tid||w.case_key}</Link><small>{row?.station_code} · {w.month}</small></td>
      <td>₹{(row?.amount||0).toLocaleString('en-IN',{maximumFractionDigits:2})}</td>
      <td>{redisputeStatus(w)}{w.recovery_month?<small>Payroll {w.recovery_month}</small>:null}</td>
      <td><button type="button" className={styles.button} onClick={()=>setEditing({window:w})}>{redisputeStage(w)==='review'?'Review evidence':redisputeStage(w)==='ticket'?'Update ticket / status':'View lifecycle'}</button> {canActivate && redisputeStage(w)==='review' ? <button type="button" className={styles.button} onClick={()=>setEditing({window:w,action:'return'})}>Return for correction</button> : null} <button type="button" className={styles.button} onClick={()=>setHistoryCase(w)}>History</button></td>
      <td className={ui.evidenceCell}>{response?.reason?<details><summary>{response.reason}</summary><p>{response.note}</p>{response.tt_reference?<small>Cloak ticket: {response.tt_reference}</small>:null}{response.evidence_url&&/^https:\/\//i.test(response.evidence_url)?<a href={response.evidence_url} target="_blank" rel="noreferrer">Supporting files ↗</a>:null}{response.cctv_not_required === true ? <small>CCTV not required</small> : response.cctv_url && /^https:\/\//i.test(response.cctv_url) ? <small><a href={response.cctv_url} target="_blank" rel="noreferrer">CCTV footage ↗</a></small> : null}</details>:<span>Not submitted</span>}</td>
      <td>{['approved','awaiting_station','awaiting_review','returned'].includes(w.workflow_status||'') ? 'Not raised' : w.tt_url&&/^https?:\/\//i.test(w.tt_url)?<a href={w.tt_url} target="_blank" rel="noreferrer">{w.tt_reference||'Open ticket'} ↗</a>:w.tt_reference||'Not raised'}</td>
      <td>{w.updated_by_name}<small>{new Date(w.updated_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})}</small>{w.enabled && redisputeStage(w)==='ticket' && w.followup_on?<small className={redisputeFollowup(w,today)==='overdue'?ui.overdue:undefined}>{redisputeFollowup(w,today)==='overdue'?'Overdue':redisputeFollowup(w,today)==='today'?'Due today':'Follow-up'} · {w.followup_on}</small>:null}</td>

    </tr>;})}</tbody></ReportTable></div>
    {editing ? <dialog ref={editor} className={ui.editor} aria-labelledby="redispute-editor-title" onClose={()=>setEditing(null)}>
      <header className={ui.editorHead}><h2 id="redispute-editor-title">Redispute lifecycle · {byKey.get(keyOf(editing.window))?.details.tid || editing.window.case_key}</h2><button type="button" className={styles.button} onClick={()=>editor.current?.close()} aria-label="Close redispute lifecycle">Close</button></header>
      <LossCaseResponse key={keyOf(editing.window)} month={editing.window.month} caseKey={editing.window.case_key} initialAction={editing.action} inlineManager onSaved={w=>setOverrides(prev=>({...prev,[keyOf(w)]:w}))}/>
    </dialog> : null}
    {!shown.length?<p className={styles.empty}>No redisputes match this view.</p>:null}
    {historyCase?<LossPidTimeline key={keyOf(historyCase)} month={historyCase.month} caseKey={historyCase.case_key} revision={current.find(w=>keyOf(w)===keyOf(historyCase))?.updated_at} initiallyOpen/>:null}
    <ListPager page={paged.page} pages={paged.pages} size={paged.size} total={paged.total} onPage={paged.setPage} onSize={paged.setSize} label="redisputes"/>
  </section>;
}
