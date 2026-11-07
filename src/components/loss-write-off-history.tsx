"use client";
import {useEffect,useId,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {DisputeHistory} from './dispute-history';
import type {LossFact} from '@/lib/ops-pulse/loss-station-summary';
import s from './dispute-history.module.css';
const money=(v:number)=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'}).format(v);
export function LossWriteOffHistory({facts,count,amount}:{facts:LossFact[];count:number;amount:number}){
 const ref=useRef<HTMLDialogElement>(null),id=useId();
 const [mounted,setMounted]=useState(false),[rows,setRows]=useState<any[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState('');
 useEffect(()=>setMounted(true),[]);
 async function open(){ref.current?.showModal();setLoading(true);setError('');setRows([]);try{
  const cases=facts.filter(f=>f.waived>0).map(f=>({month:f.month,caseKey:f.key.split('|').slice(3).join('|')}));
  const all:any[]=[];
  for(let i=0;i<cases.length;i+=100){const response=await fetch('/api/ops-pulse/losses/write-offs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cases:cases.slice(i,i+100)})});const data=await response.json();if(!response.ok)throw Error(data.error);all.push(...data.rows);}
  setRows(all.sort((a,b)=>b.created_at.localeCompare(a.created_at)));
 }catch(e){setError(e instanceof Error?e.message:'History unavailable.');}finally{setLoading(false);}}
 if(!amount)return <span>0 · {money(0)}</span>;
 return <><button type="button" className={s.trigger} style={{flexDirection:"column",gap:1,padding:"3px 5px",fontSize:11}} title="View write-off decisions and history" onClick={()=>void open()}><b>{count}</b><span>{money(amount)}</span></button>{mounted?createPortal(<dialog ref={ref} className={s.dialog} aria-labelledby={id} onClick={e=>{if(e.target===e.currentTarget)ref.current?.close();}}><header><div><h2 id={id}>Write-off history</h2><small>Recorded against the original loss month</small></div><button type="button" aria-label="Close write-off history" onClick={()=>ref.current?.close()}>×</button></header><div className={s.body}>{loading?<p role="status">Loading history…</p>:error?<p role="alert">{error}</p>:<ol>{rows.map((r,i)=><li key={`${r.dispute_id||r.employee_ref}-${r.recovery_key||r.case_key}-${i}`}><div className={s.top}><b>{r.station} · {r.tid}</b><b>{money(Number(r.amount))}</b></div><small>Loss month {r.month} · {r.decided_by_name||'Recorded approver'} · {new Date(r.created_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',dateStyle:'medium',timeStyle:'short'})} IST</small><p>{r.reason}</p>{r.source==='dispute'?<><small>Deduction {money(Number(r.before_amount))} → {money(Number(r.after_amount))}</small><DisputeHistory events={r.events} ticket={r.dispute_id} worker={r.tid}/></>:null}</li>)}</ol>}</div></dialog>,document.body):null}</>;
}
