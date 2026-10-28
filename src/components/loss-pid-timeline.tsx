'use client';
import {useEffect,useState} from 'react';
import type {PidEvent} from '@/lib/ops-pulse/loss-pid-history';
import {historyColumns,historyRows} from '@/lib/ops-pulse/loss-pid-history';
import styles from './nl-loss.module.css';
export function LossPidTimeline({month,caseKey,revision=0,initiallyOpen=false}:{month:string;caseKey:string;revision?:number|string;initiallyOpen?:boolean}) {
  const [open,setOpen]=useState(initiallyOpen),[events,setEvents]=useState<PidEvent[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(false),[retry,setRetry]=useState(0),[shown,setShown]=useState(10),[tid,setTid]=useState(caseKey);
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();setLoading(true);setError('');
    fetch(`/api/ops-pulse/losses/history?${new URLSearchParams({month,case:caseKey})}`,{cache:'no-store',signal:controller.signal})
      .then(async r=>{const j=await r.json();if(!r.ok)throw Error(j.error);return j;})
      .then(j=>{if(!controller.signal.aborted){setEvents(j.events);setTid(j.tid);setShown(10);}})
      .catch(e=>{if(!controller.signal.aborted)setError(e.message);})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[open,month,caseKey,revision,retry]);
  async function download(){try{const XLSX=await import('xlsx');const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([historyColumns,...historyRows(events,new Map(events.map(e=>[`${e.month}|${e.case_key}`,tid])))]),'PID history');XLSX.writeFile(book,'pid-history.xlsx');}catch{setError('History export failed. Retry.');}}
  return <details className={styles.pidTimeline} open={open} onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary>PID history{open&&!loading&&!error?` · ${events.length} updates`:''}</summary>
    {open?<>{loading?<small role="status">Loading timeline…</small>:error?<p role="alert">{error} <button className={styles.button} onClick={()=>setRetry(n=>n+1)}>Retry</button></p>:<>
      <div className={styles.timelineTools}><small>All recorded sources · times in IST</small><button className={styles.button} onClick={()=>void download()} disabled={!events.length}>Export history</button></div>
      <ol>{events.slice(0,shown).map((e,i)=><li key={e.id}><details><summary><strong>History {events.length-i} · {e.action.replaceAll('_',' ')}</strong><span>{e.source} · {e.month} · {e.actor}</span><time dateTime={e.at}>{new Date(e.at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST</time></summary>
        {e.note?<p>{e.note}</p>:null}<dl>{e.changes.map((c,j)=><div key={j}><dt>{c.field}</dt><dd><del>{c.before}</del> → {c.after}</dd></div>)}</dl>
      </details></li>)}</ol>
      {!events.length?<small>No recorded updates yet.</small>:null}{shown<events.length?<button className={styles.button} onClick={()=>setShown(n=>n+20)}>Show older updates ({events.length-shown})</button>:null}
    </>}</>:null}
  </details>;
}
