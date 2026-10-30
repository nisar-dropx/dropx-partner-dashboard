"use client";

import { useEffect, useState } from "react";
import type { RecoveryDetails, RecoveryPerson } from "@/lib/ops-pulse/nl-loss-policy";
import styles from "./loss-departed-person.module.css";

export type DepartedPayCheck = { loading: boolean; error: string; month: string; amount: number };
const money = (n: number) => n.toLocaleString("en-IN", {style:"currency",currency:"INR",maximumFractionDigits:2});
const date = (v: string) => new Date(v+"T00:00:00Z").toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric",timeZone:"UTC"});

export function LossDepartedPerson({month,caseKey,amount,details,onChange,onCheck,initialPayrollMonth}:{
  month:string;caseKey:string;amount:number;details:RecoveryDetails;
  onChange:(details:RecoveryDetails)=>void;onCheck:(check:DepartedPayCheck)=>void;initialPayrollMonth?:string|null;
}) {
  const [people,setPeople]=useState<RecoveryPerson[]>([]);
  const [ready,setReady]=useState(false);
  const [error,setError]=useState("");
  const [payrollMonth,setPayrollMonth]=useState(initialPayrollMonth || "");
  const [checked,setChecked]=useState<RecoveryPerson|null>(null);
  const [busy,setBusy]=useState(false);
  const [retry,setRetry]=useState(0);
  const person=people.find(p=>p.ref===details.employee_ref);
  const months=person?.open_payroll_months || [];
  const selectedMonth=months.includes(payrollMonth) ? payrollMonth : months[0] || "";

  useEffect(()=>{
    const controller=new AbortController();
    setReady(false);setError("");
    onCheck({loading:true,error:"",month:"",amount:0});
    const params=new URLSearchParams({month,case:caseKey,directory:"1",departed:"1"});
    fetch("/api/ops-pulse/losses/recovery?"+params,{cache:"no-store",signal:controller.signal})
      .then(async r=>{const j=await r.json();if(!r.ok)throw Error(j.error);return j;})
      .then(j=>{if(!controller.signal.aborted){setPeople(j.people);setReady(true);}})
      .catch(e=>{if(!controller.signal.aborted){setError(e.message);onCheck({loading:false,error:e.message,month:"",amount:0});}});
    return ()=>controller.abort();
  },[month,caseKey,retry,onCheck]);

  useEffect(()=>{
    const controller=new AbortController();
    setChecked(null);setBusy(false);
    if(!ready)return;
    if(!person){onCheck({loading:false,error:"Select a person from the departure list.",month:"",amount:0});return;}
    if(!selectedMonth){onCheck({loading:false,error:"",month:"",amount:0});return;}
    setBusy(true);setError("");onCheck({loading:true,error:"",month:selectedMonth,amount:0});
    const params=new URLSearchParams({month,case:caseKey,departed:"1",person:person.ref,payroll_month:selectedMonth});
    fetch("/api/ops-pulse/losses/recovery?"+params,{cache:"no-store",signal:controller.signal})
      .then(async r=>{const j=await r.json();if(!r.ok)throw Error(j.error);return j;})
      .then(j=>{
        if(controller.signal.aborted)return;
        const p=j.people.find((p:RecoveryPerson)=>p.ref===person.ref) as RecoveryPerson|undefined;
        if(!p || p.recovery_limit==null)throw Error("Unpaid salary could not be verified. Retry before saving.");
        setChecked(p);
        onCheck({loading:false,error:"",month:selectedMonth,amount:Math.min(amount,Math.max(0,Number(p.recovery_limit)))});
      })
      .catch(e=>{if(!controller.signal.aborted){setError(e.message);onCheck({loading:false,error:e.message,month:selectedMonth,amount:0});}})
      .finally(()=>{if(!controller.signal.aborted)setBusy(false);});
    return ()=>controller.abort();
  },[ready,person,selectedMonth,month,caseKey,amount,retry,onCheck]);

  const available=checked?.recovery_limit ?? 0;
  const adjustment=Math.min(amount,available);
  return <div className={styles.panel}>
    <div className={styles.fields}>
      <label>Person who left<select value={details.employee_ref || ""} disabled={!ready} onChange={e=>{
        const p=people.find(p=>p.ref===e.target.value);
        setPayrollMonth("");setChecked(null);
        onCheck({loading:true,error:"",month:"",amount:0});
        onChange({...details,employee_ref:p?.ref,employee_id:p?.employee_code,employee_name:p?.full_name,left_on:p?.left_on});
      }}>
        <option value="">{ready ? "Select a departed person" : "Loading departures…"}</option>
        {people.map(p=><option key={p.ref} value={p.ref}>{p.employee_code} · {p.full_name} · {p.designation} · {p.station_codes?.join(" / ")} · Left {p.left_on ? date(p.left_on) : "—"}</option>)}
      </select><small>Recorded exits in the previous two completed months · linked EDSP/XPT staff, Cluster Managers and AOMs.</small></label>
      {person && months.length>0 ? <label>Unpaid payroll<select value={selectedMonth} onChange={e=>{setChecked(null);setPayrollMonth(e.target.value);onCheck({loading:true,error:"",month:e.target.value,amount:0});}}>
        {months.map(m=><option key={m} value={m}>{new Date(m+"-01T00:00:00Z").toLocaleDateString("en-GB",{month:"long",year:"numeric",timeZone:"UTC"})}</option>)}
      </select></label> : null}
    </div>
    {ready && !people.length ? <p>No verified departures in this station’s scope for the previous two months.</p> : null}
    {person ? <div className={styles.balances} aria-live="polite">
      <div><small>Available unpaid salary</small><strong>{busy ? "Checking…" : money(available)}</strong></div>
      <div className={styles.funded}><small>Salary adjustment · approval required</small><strong>{busy ? "—" : money(adjustment)}</strong></div>
      <div className={styles.pending}><small>Remaining for follow-up</small><strong>{busy ? "—" : money(Math.max(0,Math.round((amount-adjustment)*100)/100))}</strong></div>
    </div> : null}
    {person && !months.length ? <small>No open unpaid payroll. The full loss stays outstanding.</small> : person ? <small>Saving proposes the adjustment; recovery is recorded only when payroll applies it.</small> : null}
    {person ? <div><button type="button" disabled={busy || !ready} onClick={()=>setRetry(n=>n+1)}>Refresh balance</button></div> : null}
    {Number(person?.held_salary)>0 ? <small>Salary on formal hold: {money(person!.held_salary!)}. Excluded from available pay until released through <a href="/attendance/salary-hold" target="_blank" rel="noreferrer">Salary holds</a>.</small> : null}
    {error ? <p role="alert">{error} <button type="button" onClick={()=>setRetry(n=>n+1)}>Retry</button></p> : null}
    <label>Recovery owner &amp; next step<textarea required rows={2} maxLength={1000} placeholder="Who will follow up, by when, and how will the remaining amount be recovered?" value={details.follow_up || ""} onChange={e=>onChange({...details,follow_up:e.target.value})}/></label>
  </div>;
}
