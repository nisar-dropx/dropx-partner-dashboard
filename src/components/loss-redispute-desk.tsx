"use client";
import { useMemo, useRef, useState } from "react";
import { LossCaseResponse } from "./loss-case-response";
import { FleetMultiSelect } from "./fleet-multi-select";
import "./loss-list-controls.css";
import { useOpsReportExport } from "./ops-design-context";
import { redisputeStage, redisputeStatus, isLscFollowup, emptyQueueFilters, matchesQueueFilters, queueFacetOptions, type QueueDimension, type QueueFacts } from "@/lib/ops-pulse/loss-redispute-queue";
import { compareReportValues } from "@/lib/report-table-values";
import type { ExcelReport } from "@/lib/download-report-excel";
import type { NlCase } from "@/lib/ops-pulse/nl-loss-policy";
import type { StationEvidence } from "@/lib/ops-pulse/loss-station-evidence";
import { ListPager, usePaged } from "./list-pager";
import styles from "./nl-loss.module.css";
import ui from "./loss-exceptions-desk.module.css";
import cards from "./loss-redispute-desk.module.css";
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

type Station = { station: string; clusterKeys: string[]; region: string };
type SortKey = 'shipment' | 'value' | 'status' | 'evidence' | 'ticket' | 'updated' | 'station' | 'region' | 'cluster' | 'due';
export function LossRedisputeDesk({rows,windows,canActivate,stations=[],clusterOptions=[],queue='review'}:{queue?:'review'|'lsc';rows:NlCase[];windows:RedisputeWindow[];canActivate:boolean;stations?:Station[];clusterOptions?:{value:string;label:string}[]}) {
  const [overrides,setOverrides]=useState<Record<string,RedisputeWindow>>({});
  const [selected,setSelected]=useState<string[]>([]),[confirm,setConfirm]=useState(false);
  const [note,setNote]=useState('No longer required');
  const [active,setActive]=useState<{key:string;view:'case'|'history';action:''|'return';request:number}|null>(null);
  const [exporting,setExporting]=useState(false);
  const mayExport=useOpsReportExport();
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const [errors,setErrors]=useState<string[]>([]);
  const [query,setQuery]=useState('');
  const defaultFilters=()=>({...emptyQueueFilters(),status:queue==='lsc'?['with_vendor','filed']:['awaiting_station','returned','legacy','awaiting_review','approved','preparing']});
  const [filters,setFilters]=useState(defaultFilters);
  const title=queue==='lsc'?'LSC follow-up':'Redispute review';
  const [sorting,setSorting]=useState<{key:SortKey;direction:'asc'|'desc'}>({key:'updated',direction:'desc'});
  const stationByCode=useMemo(()=>new Map(stations.map(s=>[s.station,s])),[stations]);
  const clusterLabels=useMemo(()=>new Map(clusterOptions.map(c=>[c.value,c.label])),[clusterOptions]);
  const applying=useRef(false);
  const byKey=useMemo(()=>new Map(rows.map(r=>[keyOf(r),r])),[rows]);
  const current=useMemo(()=>windows.map(w=>overrides[keyOf(w)]||w),[windows,overrides]);
  const submitted=(w:RedisputeWindow)=>!!w.response_details?.reason;
  const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});
  const candidates=useMemo(()=>current.filter(w=>isLscFollowup(w)===(queue==='lsc')).filter(w=>{
    const row=byKey.get(keyOf(w));
    return [row?.details.tid,w.case_key,w.tt_reference,row?.station_code,w.response_details?.tt_reference,w.response_details?.reason].join(' ').toLowerCase().includes(query.trim().toLowerCase());
  }),[current,queue,byKey,query]);
  const facts=useMemo(()=>candidates.map(w=>{const row=byKey.get(keyOf(w)),meta=stationByCode.get(row?.station_code||'');return {
    station:[row?.station_code||'Unmapped'],cluster:meta?.clusterKeys.length?meta.clusterKeys:['Unmapped'],region:[meta?.region||'Unmapped'],
    status:[w.enabled?w.workflow_status||w.followup_status:['won','lost'].includes(w.workflow_status||w.followup_status)?w.workflow_status||w.followup_status:'cancelled'],
    month:[w.month],type:[row?.report?.toUpperCase()||'NL'],due:[!w.enabled?'Closed':!w.followup_on?'Not scheduled':w.followup_on<today?'Overdue':w.followup_on===today?'Due today':'Upcoming']
  } satisfies QueueFacts;}),[candidates,byKey,stationByCode,today]);
  const searched=useMemo(()=>candidates.filter((_,i)=>matchesQueueFilters(facts[i],filters)),[candidates,facts,filters]);
  const facets=useMemo(()=>Object.fromEntries((Object.keys(filters) as QueueDimension[]).map(key=>[key,queueFacetOptions(facts,filters,key)])) as Record<QueueDimension,string[]>,[facts,filters]);
  const sortValue=(w:RedisputeWindow,key:SortKey)=>{
    const row=byKey.get(keyOf(w));
    return key==='station'?row?.station_code||'':key==='region'?stationByCode.get(row?.station_code||'')?.region||'':key==='cluster'?stationByCode.get(row?.station_code||'')?.clusterKeys.map(k=>clusterLabels.get(k)||k).join(', ')||'':key==='due'?w.followup_on||'':key==='shipment'?String(row?.details.tid||w.case_key):key==='value'?String(row?.amount??''):key==='status'?redisputeStatus(w):key==='evidence'?w.response_details?.reason||'':key==='ticket'?w.tt_reference||'':w.updated_at;
  };
  const shown=[...searched].sort((a,b)=>compareReportValues(sortValue(a,sorting.key),sortValue(b,sorting.key),sorting.direction));
  const paged=usePaged(shown,25,`${query}|${JSON.stringify(filters)}|${sorting.key}|${sorting.direction}`);
  function exportReport():ExcelReport{return {
    title,scope:`All ${shown.length} matching records; filters: ${JSON.stringify(filters)}; search: ${query||'none'}`,
    headers:['Shipment ID','Station','Cluster / AOM','Region','Loss type','Loss month','Shipment value (INR)','Status','Station submission','Reason','Description','Cloak ticket ID','Supporting files','CCTV not required','CCTV link','LSC ticket ID','LSC ticket URL','Follow-up date','Updated by','Updated at (IST)','Recovery payroll month'],
    rows:shown.map(w=>{const row=byKey.get(keyOf(w)),meta=stationByCode.get(row?.station_code||''),e=w.response_details;return [String(row?.details.tid||w.case_key),row?.station_code||'',meta?.clusterKeys.map(k=>clusterLabels.get(k)||k).join(', ')||'',meta?.region||'',row?.report?.toUpperCase()||'',w.month,row?.amount??null,redisputeStatus(w),submitted(w)?'Submitted':'Pending',e?.reason||'',e?.note||'',e?.tt_reference||'',e?.evidence_url||'',e?.cctv_not_required?'Yes':'No',e?.cctv_url||'',isLscFollowup(w)?w.tt_reference||'':'',isLscFollowup(w)?w.tt_url||'':'',w.followup_on||'',w.updated_by_name||'',new Date(w.updated_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}),w.recovery_month||''];})
  };}
  const selectable=paged.rows.filter(w=>w.enabled);
  const chosen=shown.filter(w=>w.enabled&&selected.includes(keyOf(w)));
  function open(w:RedisputeWindow,view:'case'|'history'='case',action:''|'return'='') { setActive(previous=>({key:keyOf(w),view,action,request:(previous?.request||0)+1})); }
  async function download(){if(!mayExport||exporting)return;setExporting(true);try{const {downloadReportExcel}=await import('@/lib/download-report-excel');await downloadReportExcel(exportReport());}catch{setMessage('Export unavailable. Please retry.');}finally{setExporting(false);}}
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
      setMessage(`${succeeded.length} disabled. History retained; eligible recovery resumes.${body.payroll_sync?.message ? ` ${body.payroll_sync.message}` : ''}`);
      setConfirm(false);
    }catch(e){setMessage(e instanceof Error?e.message:'Unable to disable redisputes.');}
    finally{applying.current=false;setBusy(false);}
  }
  return <section className={`${styles.panel} ${ui.desk} ${cards.desk}`} aria-busy={busy}>
    <div className={styles.panelHead}><div><h2>{title}</h2><small>{shown.length} shipments · ₹{shown.reduce((sum,w)=>sum+(byKey.get(keyOf(w))?.amount||0),0).toLocaleString('en-IN',{maximumFractionDigits:2})}</small></div>
      <input className={cards.search} aria-label="Find redispute or Shipment ID" placeholder="Search Shipment ID, station or ticket" value={query} disabled={busy} onChange={e=>{setQuery(e.target.value);clearSelection();}}/>
      {mayExport?<button type="button" className={styles.button} disabled={exporting} onClick={()=>void download()}>{exporting?'Preparing…':'Excel · all results'}</button>:null}
    </div>
    <div className={`${ui.controls} ${cards.filters}`}>
      {([['status','Status'],['region','Region'],['cluster','Cluster / AOM'],['station','Station'],['type','Loss type'],['month','Loss period'],['due','Follow-up']] as [QueueDimension,string][]).map(([key,label])=><div className="loss-multi-filter" key={key}><FleetMultiSelect label={label} allLabel={`All ${label.toLowerCase()}`} alwaysSearch values={filters[key]} disabled={busy} options={facets[key].map(value=>({value,label:key==='cluster'?clusterLabels.get(value)||value:key==='status'?redisputeStatus({enabled:value!=='cancelled',workflow_status:value,followup_status:value}):value}))} onChange={values=>{setFilters(f=>({...f,[key]:values}));clearSelection();}}/></div>)}
      <button type="button" className={styles.button} disabled={busy} onClick={()=>{setFilters(defaultFilters());setQuery('');clearSelection();}}>Reset</button>
    </div>
    <div className={cards.listTools}>
      {canActivate?<label className={cards.selectAll}><input type="checkbox" aria-label="Select enabled redisputes on this page" disabled={busy||!selectable.length} checked={!!selectable.length&&selectable.every(w=>selected.includes(keyOf(w)))} onChange={e=>{setSelected(e.target.checked?selectable.slice(0,100).map(keyOf):[]);setConfirm(false);}}/>Select page</label>:null}
      {chosen.length?<><strong>{chosen.length} selected</strong><button type="button" className={styles.button} disabled={busy} onClick={()=>setConfirm(true)}>Disable selected</button><button type="button" className={styles.button} disabled={busy} onClick={clearSelection}>Clear</button></>:null}
      <label className={cards.sort}>Sort<select aria-label="Sort redisputes" value={sorting.key} onChange={e=>setSorting(s=>({...s,key:e.target.value as SortKey}))}>{[['updated','Last updated'],['station','Station'],['cluster','Cluster / AOM'],['region','Region'],['due','Follow-up date'],['value','Value'],['shipment','Shipment ID'],['status','Status'],['evidence','Station reason'],['ticket','LSC ticket ID']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      <button type="button" className={styles.button} aria-label={sorting.direction==='desc'?'Sort ascending':'Sort descending'} onClick={()=>setSorting(s=>({...s,direction:s.direction==='desc'?'asc':'desc'}))}>{sorting.direction==='desc'?'↓ Descending':'↑ Ascending'}</button>
    </div>
    {confirm&&chosen.length?<div className={styles.redisputeRemove}><strong>Disable {chosen.length} redisputes?</strong><select aria-label="Disable reason" value={note} disabled={busy} onChange={e=>setNote(e.target.value)}>{['No longer required','Enabled by mistake','Continue with recovery','Duplicate redispute'].map(n=><option key={n}>{n}</option>)}</select><button type="button" className={styles.primary} disabled={busy} onClick={()=>void disable()}>{busy?'Disabling…':'Confirm disable'}</button><button type="button" className={styles.button} disabled={busy} onClick={()=>setConfirm(false)}>Cancel</button><small>Station submissions close and eligible recovery resumes. Evidence and history remain available.</small></div>:null}
    {message?<div role="status" className={ui.result}>{message}{errors.length?<ul>{errors.map((e,i)=><li key={i}>{e}</li>)}</ul>:null}</div>:null}
    <div className={cards.list}>{paged.rows.map(w=>{const row=byKey.get(keyOf(w)),response=w.response_details,isOpen=active?.key===keyOf(w),id=`redispute-${encodeURIComponent(keyOf(w))}`;return <article key={keyOf(w)} className={cards.card} data-open={isOpen} aria-label={`${row?.station_code||''} ${row?.details.tid||w.case_key}`}>
      <div className={cards.cardHead}>
        {canActivate?<input type="checkbox" aria-label={`Select ${w.case_key}, ${w.month}`} checked={selected.includes(keyOf(w))&&w.enabled} disabled={busy||!w.enabled||(!selected.includes(keyOf(w))&&chosen.length>=100)} onChange={e=>{setSelected(prev=>e.target.checked?[...prev,keyOf(w)]:prev.filter(k=>k!==keyOf(w)));setConfirm(false);}}/>:null}
        <button type="button" className={cards.identity} aria-expanded={isOpen} aria-controls={id} onClick={()=>isOpen?setActive(null):open(w)}><strong>{row?.station_code} · {row?.details.tid||w.case_key}</strong><small>{row?.report?.toUpperCase()||'NL'} · {w.month}</small></button>
        <span className={cards.status} data-stage={redisputeStage(w)}>{redisputeStatus(w)}</span>
        <strong className={cards.amount}>₹{(row?.amount||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}</strong>
        <div className={cards.cardActions}><button type="button" className={styles.button} onClick={()=>isOpen?setActive(null):open(w)} aria-expanded={isOpen} aria-controls={id}>{isOpen?'Close ↑':redisputeStage(w)==='review'?'Review ↓':redisputeStage(w)==='ticket'?'Update ↓':'Details ↓'}</button><button type="button" className={styles.button} onClick={()=>open(w,'history')}>History</button></div>
      </div>
      <div className={cards.meta}>{isLscFollowup(w)?<strong>LSC: {w.tt_reference||'Not recorded'}</strong>:null}{w.recovery_month?<span>Recovery payroll: {w.recovery_month}</span>:null}<span className={cards.reason} title={response?.reason}>{response?.reason||'Station evidence pending'}</span>{w.followup_on?<span>Follow-up {w.followup_on}</span>:null}<span>{w.updated_by_name||'Updated'} · {new Date(w.updated_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',dateStyle:'medium',timeStyle:'short'})} IST</span></div>
      {isOpen?<div id={id} className={cards.expanded}>
        <div className={cards.files}>{isLscFollowup(w)&&w.tt_url&&/^https:\/\//i.test(w.tt_url)?<a href={w.tt_url} target="_blank" rel="noopener noreferrer">LSC ticket {w.tt_reference} ↗</a>:isLscFollowup(w)&&w.tt_reference?<small>LSC ticket {w.tt_reference}</small>:null}</div>
        <LossCaseResponse key={w.version} month={w.month} caseKey={w.case_key} inline initialView={active.view} viewRequest={active.request} initialAction={active.action} onSaved={saved=>{setOverrides(prev=>({...prev,[keyOf(w)]:saved}));setMessage(`${row?.details.tid||w.case_key}: ${queue==='review'&&isLscFollowup(saved)?'saved. Open the LSC follow-up tab to continue.':'update saved.'}`);}}/>
      </div>:null}
    </article>;})}</div>
    {!shown.length?<p className={styles.empty}>No redisputes match this view.</p>:null}
    <ListPager page={paged.page} pages={paged.pages} size={paged.size} total={paged.total} onPage={paged.setPage} onSize={paged.setSize} label="redisputes"/>
  </section>;
}
