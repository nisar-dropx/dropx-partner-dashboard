'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { queueAmazonInvitationFromOpsPulse } from '@/app/field-executive/actions';
import type { AmazonDaPerson, AmazonDaProfile, AmazonDaCommand } from '@/lib/amazon-da-desk-types';
import styles from './view.module.css';

type InviteData={people:Array<{id:string;full_name:string;dropx_id:string|null;email:string|null;onboarding_status:string}>;requests:Array<{id:string;workforce_id:string;status:string;requested_at:string;error_message:string|null}>};
const tabs=[['onboarding','Onboarding'],['associates','My associates'],['offboarded','Offboarded'],['invite','Invite'],['history','History']] as const;
const human=(s:string|null|undefined)=>s?s.replaceAll('_',' ').replace(/([a-z])([A-Z])/g,'$1 $2'):'—';
const date=(s:string)=>new Date(s).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:true});
async function api<T>(url:string,init?:RequestInit):Promise<T>{const res=await fetch(url,{...init,cache:'no-store'});const data=await res.json();if(!res.ok)throw new Error(data.error||'Could not load this view.');return data;}
export function AmazonDaDesk({stations,canEdit,initialView='onboarding',initialStation,notice,initialError}:{stations:Array<{id:string;code:string}>;canEdit:boolean;initialView?:string;initialStation?:string;notice?:string;initialError?:string}){
  const [station,setStation]=useState(stations.some(s=>s.id===initialStation)?initialStation!:stations[0]?.id||'');
  const [view,setView]=useState(initialView);const [query,setQuery]=useState('');const [statusFilter,setStatusFilter]=useState('');
  const [rows,setRows]=useState<AmazonDaPerson[]>([]);const [checked,setChecked]=useState('');
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [expanded,setExpanded]=useState('');
  const [invite,setInvite]=useState<InviteData>({people:[],requests:[]});const [history,setHistory]=useState<AmazonDaCommand[]>([]);
  const [revision,setRevision]=useState(0);const requestSeq=useRef(0);
  useEffect(()=>{setExpanded('');setStatusFilter('');setQuery('');},[station,view]);
  useEffect(()=>{
    if(!station)return;const seq=++requestSeq.current;setBusy(true);setError('');setRows([]);setInvite({people:[],requests:[]});setHistory([]);setChecked('');
    api<{rows?:AmazonDaPerson[];checkedAt?:string;people?:InviteData['people'];requests?:InviteData['requests'];commands?:AmazonDaCommand[]}>(`/api/ops-pulse/amazon-da?station=${station}&view=${view}`)
      .then(data=>{if(seq!==requestSeq.current)return;setRows(data.rows||[]);setChecked(data.checkedAt||'');setInvite({people:data.people||[],requests:data.requests||[]});setHistory(data.commands||[]);})
      .catch(e=>{if(seq===requestSeq.current)setError(e.message);}).finally(()=>{if(seq===requestSeq.current)setBusy(false);});
    return()=>{requestSeq.current++;};
  },[station,view,revision]);
  const filtered=rows.filter(r=>(!statusFilter||r.status===statusFilter)&&`${r.name} ${r.email||''} ${r.transporterId||''}`.toLowerCase().includes(query.toLowerCase()));
  return <section className={styles.desk}>
    {notice?<p role="status" className={styles.next}>{notice}</p>:null}{initialError?<p role="alert" className={styles.error}>{initialError}</p>:null}
    <div className={styles.toolbar}><label>Station<select value={station} onChange={e=>setStation(e.target.value)} aria-label="Amazon station">{stations.map(s=><option key={s.id} value={s.id}>{s.code}</option>)}</select></label>
      <div className={styles.tabs}>{tabs.map(([key,label])=><button key={key} type="button" aria-pressed={view===key} onClick={()=>setView(key)}>{label}</button>)}</div>
      <button type="button" onClick={()=>setRevision(n=>n+1)} disabled={busy||!station}>{busy?'Checking Amazon…':'↻ Refresh'}</button>
    </div>
    {!stations.length?<p className={styles.empty}>No Amazon stations are in your access.</p>:null}
    {error?<div role="alert" className={styles.error}>{error}<button onClick={()=>setRevision(n=>n+1)}>Retry</button></div>:null}
    {checked?<div className={styles.meta}>Checked {date(checked)} IST <span>Station changes are managed centrally</span></div>:null}
    {view==='invite'?<div className={styles.invite}>
      <div className={styles.split}><strong>Invite a registered associate</strong><Link href="/work-force-register">＋ Register new associate</Link></div>
      <p className={styles.meta}>Choose their DropX profile. Existing Amazon IDs are checked before sending.</p>
      <input aria-label="Find registered associate" placeholder="Search name or DropX ID" value={query} onChange={e=>setQuery(e.target.value)}/>
      {invite.people.filter(p=>`${p.full_name} ${p.dropx_id||''}`.toLowerCase().includes(query.toLowerCase())).map(p=>{const latest=invite.requests.find(r=>r.workforce_id===p.id);return <div className={styles.inviteRow} key={p.id}><div><strong>{p.full_name}</strong><small>{p.dropx_id||'DropX ID pending'} · {p.email||'Email missing'}</small>{latest?<small className={latest.status==='failed'?styles.danger:''}>{human(latest.status)} · {date(latest.requested_at)} {latest.error_message||''}</small>:null}</div>
        <form action={queueAmazonInvitationFromOpsPulse}><input type="hidden" name="workforce_id" value={p.id}/><input type="hidden" name="amazon_desk_return" value="1"/><input type="hidden" name="amazon_desk_station" value={station}/><button disabled={!canEdit||!p.email||['sent','processing','pending'].includes(latest?.status||'')} type="submit">{latest?.status==='sent'?'Sent':latest?.status==='failed'?'Retry invite':'Send invite'}</button></form></div>;})}
      {!busy&&!invite.people.length?<p className={styles.empty}>No registered associates at this station.</p>:null}
    </div>:view==='history'?<Audit commands={history} station={station} canEdit={canEdit} onChecked={()=>setRevision(n=>n+1)}/>:<>
      <div className={styles.filters}><input aria-label="Search associates" placeholder="Search name, Amazon ID or email" value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label="Filter associate status" value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}><option value="">All statuses</option>{[...new Set(rows.map(r=>r.status))].map(s=><option key={s} value={s}>{human(s)}</option>)}</select><span>{filtered.length} associates</span></div>
      <div className={styles.list}>{filtered.map(person=><article className={styles.card} key={person.providerId}>
        <button className={styles.row} aria-expanded={expanded===person.providerId} onClick={()=>setExpanded(expanded===person.providerId?'':person.providerId)}>
          <span className={styles.identity}><span className={styles.avatar}>{person.name.slice(0,1)}</span><span><strong>{person.name}</strong><small>{person.transporterId||'Amazon ID pending'}{person.stage?` · ${human(person.stage)}`:''}</small></span></span>
          {person.progress!==null?<span className={styles.progress}><span>{person.progress}%</span><progress max="100" value={person.progress}/></span>:null}
          <span className={`${styles.badge} ${person.status==='ACTIVE'?styles.good:person.status==='OFFBOARDED'?styles.muted:styles.warning}`}>{human(person.health||person.status)}</span><span>{expanded===person.providerId?'−':'＋'}</span>
        </button>
        {expanded===person.providerId?<Profile key={`${station}:${person.providerId}`} station={station} providerId={person.providerId} canEdit={canEdit} onChanged={()=>setRevision(n=>n+1)}/>:null}
      </article>)}</div>
      {!busy&&!error&&!filtered.length?<p className={styles.empty}>No associates match this view.</p>:null}
    </>}
  </section>;
}
function Audit({commands,station,canEdit,onChecked}:{commands:AmazonDaCommand[];station:string;canEdit:boolean;onChecked:()=>void}){
  const [checking,setChecking]=useState('');const [error,setError]=useState('');
  async function check(id:string){setChecking(id);setError('');try{await api('/api/ops-pulse/amazon-da',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'reconcile',id,stationId:station})});onChecked();}catch(e){setError((e as Error).message);}finally{setChecking('');}}
  return <div className={styles.audit}>{error?<p role="alert" className={styles.error}>{error}</p>:null}{!commands.length?<p className={styles.empty}>No OpsPulse actions recorded yet. Earlier changes in Amazon may not identify the user.</p>:commands.map(c=><details key={c.id} className={styles.auditRow}><summary><span><strong>{human(c.action)}</strong> · {c.associate_name}<small>{c.actor_name} · {c.actor_role} · {date(c.created_at)} IST</small></span><span className={`${styles.badge} ${c.status==='confirmed'?styles.good:c.status==='failed'?styles.danger:styles.warning}`}>{human(c.status)}</span></summary><div><p>{c.remarks}</p><p>{human(c.expected_status)} → {human(c.observed_status)} · {c.result_message||'Waiting to be checked'}</p>{c.events?.slice().sort((a,b)=>a.created_at.localeCompare(b.created_at)).map((e,i)=><small key={i}>{date(e.created_at)} · {human(e.status)} · {e.message}</small>)}<small>Last update {date(c.updated_at)} IST · Ref {c.id}</small>{canEdit&&['queued','checking','sending','unconfirmed'].includes(c.status)?<button onClick={()=>void check(c.id)} disabled={!!checking}>{checking===c.id?'Checking…':'Check Amazon result'}</button>:null}</div></details>)}</div>;
}
function Profile({station,providerId,canEdit,onChanged}:{station:string;providerId:string;canEdit:boolean;onChanged:()=>void}){
  const [data,setData]=useState<AmazonDaProfile|null>(null);const [error,setError]=useState('');const [busy,setBusy]=useState(true);
  const [history,setHistory]=useState<AmazonDaCommand[]>([]);const [showHistory,setShowHistory]=useState(false);
  const [action,setAction]=useState('');const [reason,setReason]=useState('');const [remarks,setRemarks]=useState('');const [confirmed,setConfirmed]=useState(false);const [saving,setSaving]=useState(false);const [notice,setNotice]=useState('');
  const commandId=useRef<string|null>(null);
  async function loadHistory(){try{const h=await api<{commands:AmazonDaCommand[]}>(`/api/ops-pulse/amazon-da?station=${station}&view=history&profile=${encodeURIComponent(providerId)}`);setHistory(h.commands);}catch(e){setError((e as Error).message);}}
  useEffect(()=>{let alive=true;api<AmazonDaProfile>(`/api/ops-pulse/amazon-da?station=${station}&profile=${encodeURIComponent(providerId)}`).then(d=>{if(alive)setData(d);}).catch(e=>{if(alive)setError(e.message);}).finally(()=>{if(alive)setBusy(false);});return()=>{alive=false;};},[station,providerId]);
  async function save(){if(!data)return;setSaving(true);setError('');commandId.current ||= crypto.randomUUID();try{
    const result=await api<{command?:AmazonDaCommand;pending?:boolean;message?:string}>('/api/ops-pulse/amazon-da',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:commandId.current,stationId:station,providerId,action,reasonCode:reason,remarks,confirmed,expectedStatus:data.person.status})});
    setNotice(result.message||result.command?.result_message||'Action recorded.');setShowHistory(true);await loadHistory();
    if(result.command?.status==='confirmed'){setAction('');setConfirmed(false);onChanged();}
  }catch(e){setError((e as Error).message);setShowHistory(true);await loadHistory();}finally{setSaving(false);}}
  function selectAction(value:string){setAction(value);setReason('');setRemarks('');setConfirmed(false);commandId.current=null;setNotice('');}
  const locked=Boolean(notice)||saving;
  return <div className={styles.profile}>
    <div className={styles.split}><strong>Associate profile</strong><button onClick={()=>{setShowHistory(!showHistory);if(!showHistory)void loadHistory();}}>◷ History</button></div>
    {busy?<p className={styles.meta}>Verifying current Amazon details…</p>:null}{error?<p className={styles.error} role="alert">{error}</p>:null}
    {data?<><div className={styles.details}><div><small>Amazon status</small><strong>{human(data.person.status)}</strong></div><div><small>Email</small><span>{data.person.email||'—'}</span></div><div><small>Phone</small><span>{data.person.phone||'—'}</span></div><div><small>Qualification</small><span>{human(data.person.qualifications)}</span></div></div>
      {data.person.stage?<div className={styles.next}><strong>{human(data.person.stage)}</strong><span>{human(data.person.nextAction)||'Awaiting Amazon update'}{data.person.totalSteps?` · ${data.person.completedSteps} of ${data.person.totalSteps} steps complete`:''}</span></div>:null}
      {canEdit?<div className={styles.actions}><select aria-label="Associate action" value={action} onChange={e=>selectAction(e.target.value)} disabled={locked}><option value="">Choose action…</option>{[...new Set(data.options.map(o=>o.action))].map(a=><option key={a} value={a}>{a==='OFFBOARD'?'Offboard from Amazon':'Set inactive in Amazon'}</option>)}{data.canResend?<option value="RESEND_INVITATION">Resend invitation</option>:null}</select></div>:null}
      {action?<div className={styles.actionForm}>{action!=='RESEND_INVITATION'?<label>Amazon reason<select value={reason} onChange={e=>{setReason(e.target.value);commandId.current=null;}} disabled={locked}><option value="">Choose reason…</option>{data.options.filter(o=>o.action===action).map(o=><option key={o.reasonCode} value={o.reasonCode}>{o.label}</option>)}</select></label>:null}
        <label>Remarks<textarea rows={2} maxLength={1000} placeholder="Why is this action needed?" value={remarks} disabled={locked} onChange={e=>{setRemarks(e.target.value);commandId.current=null;}}/></label>
        <label className={styles.confirm}><input type="checkbox" checked={confirmed} disabled={locked} onChange={e=>setConfirmed(e.target.checked)}/><span>{action==='RESEND_INVITATION'?`Resend the invitation to ${data.person.name}.`:`${action==='OFFBOARD'?'Offboard':'Set inactive'} ${data.person.name} in Amazon. This can stop delivery access.`}</span></label>
        {action!=='RESEND_INVITATION'?<small>DropX payroll, attendance and outstanding balances remain in their existing records.</small>:null}
        <button className={styles.primary} onClick={()=>void save()} disabled={locked||!confirmed||remarks.trim().length<3||(action!=='RESEND_INVITATION'&&!reason)}>{saving?'Sending…':'Confirm action'}</button>
      </div>:null}
    </>:null}
    {notice?<p className={styles.next} role="status">{notice}</p>:null}{showHistory?<Audit commands={history} station={station} canEdit={canEdit} onChecked={()=>void loadHistory()}/>:null}
  </div>;
}
