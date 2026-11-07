"use client";
import { useCallback,useEffect,useState } from "react";
import {DisputeProgress,DisputeCorrection,DisputePayment} from "./associate-payouts";
import s from "../../../../src/components/guided-dispute.module.css";
import { decodePayoutDisputeReason } from "../lib/payout-dispute";
const money=(v:number)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR"}).format(v);
const when=(v:string)=>new Date(v).toLocaleString("en-IN",{timeZone:"Asia/Kolkata",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});
export function AssociateDisputeCenter({accountId,profileType,readOnly=false}:{accountId:string;profileType:string;readOnly?:boolean}){
  const [rows,setRows]=useState<any[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(""),[filter,setFilter]=useState("pending"),[period,setPeriod]=useState(""),[busy,setBusy]=useState("");
  const query=new URLSearchParams({accountId,profileType,view:"disputes"}).toString();
  const load=useCallback(async()=>{setLoading(true);setError("");try{const r=await fetch(`/api/connect/payout-review?${query}`,{cache:"no-store"});const b=await r.json();if(!r.ok)throw new Error(b.error);setRows(b.disputes);}catch(e){setError(e instanceof Error?e.message:"History unavailable.");}finally{setLoading(false);}},[query]);
  useEffect(()=>{void load();},[load]);
  async function reply(e:React.FormEvent<HTMLFormElement>,d:any){e.preventDefault();if(readOnly)return;setBusy(d.id);setError("");const message=new FormData(e.currentTarget).get("message");try{const r=await fetch(`/api/connect/payout-review?${query}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({operation:"reply",disputeId:d.id,version:d.version,message})});const b=await r.json();if(!r.ok)throw new Error(b.error);await load();}catch(e){setError(e instanceof Error?e.message:"Reply failed.");}finally{setBusy("");}}
  const shown=rows.filter(d=>(!period||d.month===period)&&(filter==="all"||(filter==="pending"?!["resolved","rejected"].includes(d.status):["resolved","rejected"].includes(d.status))));
  return <section className={s.panel}><div className={s.toolbar}><div><b>Your disputes</b><div className={s.muted}>Track requests and reply to the reviewer</div></div><button onClick={()=>void load()} disabled={loading}>{loading?"Loading…":"Refresh"}</button></div>
    <div className={s.historyTabs}>{[["pending","Pending"],["closed","History"],["all","All"]].map(([v,label])=><button key={v} aria-pressed={filter===v} onClick={()=>setFilter(v)}>{label} ({rows.filter(d=>v==="all"||(v==="pending"?!["resolved","rejected"].includes(d.status):["resolved","rejected"].includes(d.status))).length})</button>)}</div>
    <label className={s.muted}>Pay month <select value={period} onChange={e=>setPeriod(e.target.value)}><option value="">All months</option>{[...new Set(rows.map(d=>d.month))].map(m=><option key={m}>{m}</option>)}</select></label>
    {error?<p className={s.error} role="alert">{error}</p>:null}
    {!loading&&!shown.length?<p>No {filter==="pending"?"pending requests":"requests in this view"}.</p>:null}
    {shown.map(d=><details key={d.id} className={s.panel}><summary><b>{decodePayoutDisputeReason(d.reason).areas.join(" · ")||d.category}</b> · {d.month}<br/><span className={d.details?.awaiting_reply?s.warn:s.ok}>{d.details?.awaiting_reply?"Your reply is needed":d.workflow.label}</span><small className={s.muted}> · {d.station} · {when(d.updated_at)}</small></summary>
      <p>{decodePayoutDisputeReason(d.reason).reason}</p>
      {d.details?.awaiting_reply?<form onSubmit={e=>void reply(e,d)}><p className={s.error}>{d.details.question}</p><textarea name="message" required minLength={3} maxLength={1000} rows={2} placeholder="Write your reply"/><div className={s.actions}><button type="submit" disabled={busy===d.id||readOnly}>Send reply</button></div></form>:null}
      <DisputeProgress dispute={d}/><DisputeCorrection dispute={d}/><DisputePayment dispute={d}/>
      {d.legacyResolutionUnverified?<p className={s.muted}>Historical closure · no verified revised payout linked.</p>:null}
      {d.resolution?<p aria-label="Final dispute decision"><b>Decision:</b> {d.resolution}</p>:null}
      <ol>{d.timeline.map((t:any,i:number)=><li key={i}><b>{t.label}</b> <small>{when(t.createdAt)}</small><p>{t.comment}</p></li>)}</ol>
      <small className={s.muted}>Ticket {d.id.slice(0,8).toUpperCase()}</small>
    </details>)}
  </section>;
}
