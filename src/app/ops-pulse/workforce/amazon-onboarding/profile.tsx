'use client';
import {useEffect,useRef,useState} from 'react';
import type {AmazonDaPerson,AmazonDaProfile,AmazonDaCommand} from '@/lib/amazon-da-desk-types';
import styles from './view.module.css';
import {Milestones} from './milestones';
const human=(s:string|null|undefined)=>s?s.replaceAll('_',' ').replace(/([a-z])([A-Z])/g,'$1 $2'):'—';
const date=(s:string)=>new Date(s).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:true});
async function api<T>(url:string,init?:RequestInit):Promise<T>{const res=await fetch(url,{...init,cache:'no-store'});const data=await res.json();if(!res.ok)throw new Error(data.error||'Could not load this view.');return data;}
export function Audit({commands,station,canEdit,onChecked}:{commands:AmazonDaCommand[];station:string;canEdit:boolean;onChecked:()=>void}){
  const [checking,setChecking]=useState('');const [error,setError]=useState('');
  async function check(id:string,stationId:string){setChecking(id);setError('');try{await api('/api/ops-pulse/amazon-da',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'reconcile',id,stationId})});onChecked();}catch(e){setError((e as Error).message);}finally{setChecking('');}}
  return <div className={styles.audit}>{error?<p role="alert" className={styles.error}>{error}</p>:null}{!commands.length?<p className={styles.empty}>No OpsPulse actions recorded yet. Earlier changes in Amazon may not identify the user.</p>:commands.map(c=><details key={c.id} className={styles.auditRow}><summary><span><strong>{human(c.action)}</strong> · {c.associate_name}<small>{c.actor_name} · {c.actor_role} · {date(c.created_at)} IST</small></span><span className={`${styles.badge} ${c.status==='confirmed'?styles.good:c.status==='failed'?styles.danger:styles.warning}`}>{human(c.status)}</span></summary><div><p>{c.remarks}</p>{c.reviewer_name?<p><strong>{c.review_decision==='approved'?'Approved':'Rejected'}</strong> by {c.reviewer_name} · {c.reviewer_role} · {c.reviewed_at?date(c.reviewed_at):''} IST<br/>{c.review_remarks}</p>:null}<p>{human(c.expected_status)} → {human(c.observed_status)} · {c.result_message||'Waiting to be checked'}</p>{c.events?.slice().sort((a,b)=>a.created_at.localeCompare(b.created_at)).map((e,i)=><small key={i}>{date(e.created_at)} · {human(e.status)} · {e.message}</small>)}<small>Last update {date(c.updated_at)} IST · Ref {c.id}</small>{canEdit&&['queued','checking','sending','unconfirmed'].includes(c.status)?<button onClick={()=>void check(c.id,c.station_id||station)} disabled={!!checking}>{checking===c.id?'Checking…':'Check Amazon result'}</button>:null}</div></details>)}</div>;
}
export function Profile({station,providerId,initialPerson,canEdit,onChanged}:{station:string;providerId:string;initialPerson:AmazonDaPerson;canEdit:boolean;onChanged:()=>void}){
  const [data,setData]=useState<AmazonDaProfile|null>(null);const [error,setError]=useState('');const [busy,setBusy]=useState(true);
  const [history,setHistory]=useState<AmazonDaCommand[]>([]);const [showHistory,setShowHistory]=useState(false);
  const [action,setAction]=useState('');const [reason,setReason]=useState('');const [remarks,setRemarks]=useState('');const [confirmed,setConfirmed]=useState(false);const [saving,setSaving]=useState(false);const [notice,setNotice]=useState('');
  const commandId=useRef<string|null>(null);
  async function loadHistory(){try{const h=await api<{commands:AmazonDaCommand[]}>(`/api/ops-pulse/amazon-da?station=${station}&view=history&profile=${encodeURIComponent(providerId)}`);setHistory(h.commands);}catch(e){setError((e as Error).message);}}
  useEffect(()=>{let alive=true;api<AmazonDaProfile>(`/api/ops-pulse/amazon-da?station=${station}&profile=${encodeURIComponent(providerId)}`).then(d=>{if(alive)setData(d);}).catch(e=>{if(alive)setError(e.message);}).finally(()=>{if(alive)setBusy(false);});return()=>{alive=false;};},[station,providerId]);
  useEffect(()=>{void loadHistory();},[station,providerId]);
  async function save(){if(!data)return;setSaving(true);setError('');commandId.current ||= crypto.randomUUID();try{
    const result=await api<{command?:AmazonDaCommand;pending?:boolean;message?:string}>('/api/ops-pulse/amazon-da',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:commandId.current,stationId:station,providerId,action,reasonCode:reason,remarks,confirmed,expectedStatus:data.person.status})});
    setNotice(result.message||result.command?.result_message||'Action recorded.');setShowHistory(true);await loadHistory();
    if(result.command?.status==='confirmed'){setAction('');setConfirmed(false);onChanged();}
  }catch(e){setError((e as Error).message);setShowHistory(true);await loadHistory();}finally{setSaving(false);}}
  function selectAction(value:string){setAction(value);setReason('');setRemarks('');setConfirmed(false);commandId.current=null;setNotice('');}
  const pending=history.find(c=>['pending_approval','queued','checking','sending','unconfirmed'].includes(c.status));
  const locked=Boolean(notice)||saving||!!pending; const person=data?.person||initialPerson;
  return <div className={styles.profile}>
    <div className={styles.split}><strong>Associate profile</strong><button onClick={()=>{setShowHistory(!showHistory);if(!showHistory)void loadHistory();}}>◷ History</button></div>
    {busy?<p className={styles.meta}>Checking available actions…</p>:null}{error?<p className={styles.error} role="alert">{error}</p>:null}
    {pending?<div className={styles.next}><strong>{pending.status==='pending_approval'?'Awaiting approval':pending.status==='unconfirmed'?'Amazon confirmation pending':'Approved · processing'}</strong><span>{human(pending.action)} · requested by {pending.actor_name}</span>{pending.reviewer_name?<span>Approved by {pending.reviewer_name}</span>:null}</div>:null}
    {person?<><div className={styles.details}><div><small>Amazon status</small><strong>{human(person.status)}</strong></div><div><small>Email</small><span>{person.email||'—'}</span></div><div><small>Phone</small><span>{person.phone||'—'}</span></div><div><small>Qualification</small><span>{human(person.qualifications)}</span></div></div>
      {person.stage?<div className={styles.next}><strong>{human(person.stage)}</strong><span>{person.nextAction?human(person.nextAction):'In progress with Amazon'}{person.totalSteps?` · ${person.completedSteps} of ${person.totalSteps} steps complete`:''}</span></div>:null}
      <Milestones station={station} providerId={providerId} canEdit={canEdit}/>
      {canEdit&&data?<div className={styles.actions}><select aria-label="Associate action" value={action} onChange={e=>selectAction(e.target.value)} disabled={locked}><option value="">Choose action…</option>{[...new Set(data.options.map(o=>o.action))].map(a=><option key={a} value={a}>{a==='OFFBOARD'?'Request ID offboarding':'Request inactive status'}</option>)}{data.canResend?<option value="RESEND_INVITATION">Resend invitation</option>:null}</select></div>:null}
      {action&&data?<div className={styles.actionForm}>{action!=='RESEND_INVITATION'?<label>Amazon reason<select value={reason} onChange={e=>{setReason(e.target.value);commandId.current=null;}} disabled={locked}><option value="">Choose reason…</option>{data.options.filter(o=>o.action===action).map(o=><option key={o.reasonCode} value={o.reasonCode}>{o.label}</option>)}</select></label>:null}
        <label>Remarks<textarea rows={2} maxLength={1000} placeholder="Why is this action needed?" value={remarks} disabled={locked} onChange={e=>{setRemarks(e.target.value);commandId.current=null;}}/></label>
        <label className={styles.confirm}><input type="checkbox" checked={confirmed} disabled={locked} onChange={e=>setConfirmed(e.target.checked)}/><span>{action==='RESEND_INVITATION'?`Resend the invitation to ${person.name}.`:`Request ${action==='OFFBOARD'?'offboarding':'inactive status'} for ${person.name}. Delivery access changes only after approval.`}</span></label>
        {action!=='RESEND_INVITATION'?<small>DropX payroll, attendance and outstanding balances remain in their existing records.</small>:null}
        <button className={styles.primary} onClick={()=>void save()} disabled={locked||!confirmed||remarks.trim().length<3||(action!=='RESEND_INVITATION'&&!reason)}>{saving?'Sending…':action==='RESEND_INVITATION'?'Resend invitation':'Submit for approval'}</button>
      </div>:null}
    </>:null}
    {notice?<p className={styles.next} role="status">{notice}</p>:null}{showHistory?<Audit commands={history} station={station} canEdit={canEdit} onChecked={()=>void loadHistory()}/>:null}
  </div>;
}
