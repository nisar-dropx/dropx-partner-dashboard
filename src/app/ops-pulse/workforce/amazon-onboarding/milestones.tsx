'use client';
import {useEffect,useState} from 'react';
import {CheckCircle2,Clock3,Circle,AlertCircle,RefreshCw} from 'lucide-react';
import type {AmazonDaMilestone} from '@/lib/amazon-da-desk-types';
import styles from './view.module.css';
const labels:Record<string,string>={completed:'Done',in_progress:'In progress',pending:'Pending',blocked:'Needs attention',unknown:'Not reported'};
export function Milestones({station,providerId}:{station:string;providerId:string}){
 const [data,setData]=useState<{milestones:AmazonDaMilestone[];checkedAt:string}|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(true),[retry,setRetry]=useState(0),[filter,setFilter]=useState('all');
 useEffect(()=>{const controller=new AbortController();setBusy(true);setError('');
  fetch(`/api/ops-pulse/amazon-da?${new URLSearchParams({station,profile:providerId,view:'milestones',fresh:retry?'1':'0'})}`,{cache:'no-store',signal:controller.signal})
   .then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error||'Milestones unavailable.');return d;}).then(setData)
   .catch(e=>{if(e.name!=='AbortError')setError('Amazon milestone details could not be loaded. Retry to check the current status.');}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});
  return()=>controller.abort();},[station,providerId,retry]);
 const tasks=data?.milestones||[],done=tasks.filter(t=>t.status==='completed').length;
 function badge(status:string){const Icon=status==='completed'?CheckCircle2:status==='in_progress'?Clock3:status==='blocked'?AlertCircle:Circle;return <span className={`${styles.milestoneState} ${status==='completed'?styles.good:status==='blocked'?styles.danger:styles.warning}`}><Icon size={13}/>{labels[status]||'Not reported'}</span>;}
 return <section className={styles.milestones} aria-label="Amazon onboarding milestones" aria-busy={busy}>
  <div className={styles.split}><strong>Onboarding milestones</strong><button disabled={busy} onClick={()=>setRetry(n=>n+1)} aria-label="Refresh milestones"><RefreshCw size={13}/></button></div>
  {busy?<p className={styles.meta} role="status">Checking completed and pending milestones in Amazon…</p>:null}
  {error?<p role="alert" className={styles.error}>{error}<button onClick={()=>setRetry(n=>n+1)} disabled={busy}>Retry</button></p>:null}
  {data?<><div className={styles.milestoneFilters}>{[['all',`All ${tasks.length}`],['pending',`To do ${tasks.length-done}`],['done',`Done ${done}`]].map(([key,label])=><button key={key} aria-pressed={filter===key} onClick={()=>setFilter(key)}>{label}</button>)}<small>Checked {new Date(data.checkedAt).toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit'})} IST</small></div>
   <div className={styles.milestoneGrid}>{tasks.filter(t=>filter==='all'||(filter==='done'?t.status==='completed':t.status!=='completed')).map((task,i)=><details key={`${task.name}:${i}`} className={styles.milestone} open={task.status!=='completed'&&task.subtasks.length>0}><summary><span>{task.name}</span>{badge(task.status)}</summary>{task.subtasks.length?<ul>{task.subtasks.map((s,j)=><li key={j}><span>{s.name}</span>{badge(s.status)}</li>)}</ul>:<small>Amazon reports this milestone as {labels[task.status]?.toLowerCase()||'not reported'}.</small>}</details>)}</div>
   {tasks.every(t=>t.status==='completed')?<p className={styles.meta}>All reported milestones are complete. Amazon activation is shown separately above.</p>:null}
  </>:null}
 </section>;
}
