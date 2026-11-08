'use client';
import {useEffect,useState} from 'react';
import {CheckCircle2,Clock3,Circle,RefreshCw} from 'lucide-react';
import type {AmazonDaMilestone} from '@/lib/amazon-da-desk-types';
import {BgcPanel,type BgcStatus} from './bgc';
import styles from './view.module.css';
const labels:Record<string,string>={completed:'Done',in_progress:'In progress',pending:'Pending',blocked:'Needs attention',unknown:'Not reported'};
type Snapshot={milestones:AmazonDaMilestone[];checkedAt:string|null;pending:boolean;error:string|null;idfy:BgcStatus|null;idfyError:string|null};
export function Milestones({station,providerId,canEdit}:{station:string;providerId:string;canEdit:boolean}){
 const [data,setData]=useState<Snapshot|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(true),[retry,setRetry]=useState(0),[filter,setFilter]=useState('pending'),[showBgc,setShowBgc]=useState(false);
 useEffect(()=>{const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,attempt=0;setBusy(true);setError('');
  async function read(){try{const r=await fetch(`/api/ops-pulse/amazon-da?${new URLSearchParams({station,profile:providerId,view:'milestones',fresh:retry&&attempt===0?'1':'0'})}`,{cache:'no-store',signal:controller.signal});const d=await r.json();if(!r.ok)throw Error(d.error||'Saved milestones unavailable.');if(controller.signal.aborted)return;setData(d);if(d.pending&&attempt++<24)timer=setTimeout(read,5000);}
   catch(e){if(!controller.signal.aborted)setError((e as Error).message);}finally{if(!controller.signal.aborted)setBusy(false);}}
  void read();return()=>{controller.abort();clearTimeout(timer);};},[station,providerId,retry]);
 const tasks=data?.milestones||[],done=tasks.filter(t=>t.status==='completed').length;
 function badge(status:string){const Icon=status==='completed'?CheckCircle2:status==='in_progress'?Clock3:Circle;return <span className={`${styles.milestoneState} ${status==='completed'?styles.good:styles.warning}`}><Icon size={13}/>{labels[status]||'Not reported'}</span>;}
 return <section className={styles.milestones} aria-label="Amazon onboarding milestones" aria-busy={busy}>
  <div className={styles.split}><strong>Onboarding milestones</strong><button disabled={busy} onClick={()=>setRetry(n=>n+1)} aria-label="Refresh milestones"><RefreshCw size={13}/></button></div>
  {busy&&!data?<p className={styles.meta} role="status">Loading saved details…</p>:null}
  {error||data?.error?<p role="alert" className={styles.error}>{error||data?.error}<button onClick={()=>setRetry(n=>n+1)} disabled={busy}>Retry sync</button></p>:null}
  {data?.pending?<p className={styles.meta} role="status">{tasks.length?'Showing last confirmed details · refresh queued.':'Preparing the first sync. You can continue working; details update here automatically.'}</p>:null}
  {tasks.length?<><div className={styles.milestoneFilters}>{[['all',`All ${tasks.length}`],['pending',`To do ${tasks.length-done}`],['done',`Done ${done}`]].map(([key,label])=><button key={key} aria-pressed={filter===key} onClick={()=>setFilter(key)}>{label}</button>)}<small>Synced {data?.checkedAt?new Date(data.checkedAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}):'—'} IST</small></div>
   <div className={styles.milestoneGrid}>{tasks.filter(t=>filter==='all'||(filter==='done'?t.status==='completed':t.status!=='completed')).map((task,i)=><details key={`${task.name}:${i}`} className={styles.milestone} open={task.status!=='completed'&&task.subtasks.length>0}><summary><span>{task.name}</span>{badge(task.status)}</summary>{task.subtasks.length?<ul>{task.subtasks.map((s,j)=><li key={j}><span>{s.name}</span>{badge(s.status)}</li>)}</ul>:<small>Amazon reports this milestone as {labels[task.status]?.toLowerCase()||'not reported'}.</small>}{/background|bgc/i.test(task.name)?<button onClick={()=>setShowBgc(true)}>View IDfy details</button>:null}</details>)}</div>
   {filter==='pending'&&done===tasks.length?<p className={styles.meta}>No pending milestones reported.</p>:null}</>:null}
  <div className={styles.split}><button onClick={()=>setShowBgc(v=>!v)}>{showBgc?'Close BGC details':'BGC / IDfy details'}</button><span className={styles.meta}>{data?.idfy?.status||'Status available inside'}</span></div>
  {showBgc?<BgcPanel station={station} providerId={providerId} canEdit={canEdit} initial={data?.idfy||null}/>:null}
 </section>;
}
