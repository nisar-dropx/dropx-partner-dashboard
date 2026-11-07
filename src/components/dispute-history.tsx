"use client";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import s from "./dispute-history.module.css";
type Event = { id: string; actor_name?: string; created_at: string; event_type?: string; from_status?: string; to_status?: string; message?: string; metadata?: Record<string, any> };
const labels: Record<string,string> = {open:"Initial review",pending_final_approval:"Final approval",in_review:"Final approval",approved_for_processing:"Ready for correction",processing:"Applying correction",processing_blocked:"Correction blocked",resolved:"Corrected",rejected:"Rejected",propose_correction:"Correction proposed",propose_rejection:"Rejection proposed",approve_final:"Final decision",send_back:"Sent back",request_clarification:"Clarification requested",associate_reply:"Associate replied",return_review:"Returned for review",claim_processing:"Correction started",block_processing:"Correction blocked",complete_processing:"Correction verified"};
const label=(v?:string)=>v?labels[v]||v.replaceAll("_"," "):"Update";
export function DisputeHistory({events,ticket,worker}:{events:Event[];ticket:string;worker:string}){
  const ref=useRef<HTMLDialogElement>(null),id=useId();const [mounted,setMounted]=useState(false);
  useEffect(()=>setMounted(true),[]);
  return <><button type="button" className={s.trigger} aria-label={`History for ${worker}`} onClick={e=>{e.preventDefault();e.stopPropagation();ref.current?.showModal();}}>History <span>{events.length}</span></button>
    {mounted?createPortal(<dialog ref={ref} className={s.dialog} aria-labelledby={id} onClick={e=>{if(e.target===e.currentTarget)ref.current?.close();}}>
      <header><div><h2 id={id}>Dispute history</h2><small>{worker} · {ticket.slice(0,8).toUpperCase()}</small></div><button type="button" aria-label="Close dispute history" onClick={()=>ref.current?.close()}>×</button></header>
      <div className={s.body}>{events.length?<ol>{events.map(e=>{const plan=e.metadata?.correction_plan;return <li key={e.id}><div className={s.top}><b>{label(e.event_type)}</b><time>{new Date(e.created_at).toLocaleString("en-IN",{timeZone:"Asia/Kolkata",day:"numeric",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"})} IST</time></div><small>{e.actor_name||"System"}{e.from_status||e.to_status?` · ${label(e.from_status)} → ${label(e.to_status)}`:""}</small>{e.message?<p>{e.message}</p>:null}{Array.isArray(plan?.items)?<details><summary>Changed values</summary><table><thead><tr><th>Item / day</th><th>Before</th><th>Proposed</th></tr></thead><tbody>{plan.items.map((item:any,i:number)=><tr key={i}><td>{item.target_field}</td><td>{item.current_value}</td><td>{item.proposed_value}</td></tr>)}</tbody></table></details>:null}</li>;})}</ol>:<p>No recorded updates.</p>}</div>
    </dialog>,document.body):null}
  </>;
}
