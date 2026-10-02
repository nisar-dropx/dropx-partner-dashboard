"use client";
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { AppAccount } from "./connect-profile-app";

type Data = {pilot?:boolean;stale?:boolean;syncDelayed?:boolean;reportDate?:string;driverId?:string;biometricId?:string;actionOwner?:string;category?:string;amazonAction?:string;instruction?:string;reportUpdatedAt?:string|null;available:boolean;stage:string;stageLabel:string;configured:boolean;mode:string|null;firstPunch:string|null;mappingEffectiveFrom:string|null;providerStage:string|null;nextFollowUp:string|null;updatedAt:string|null;paymentHolds?:Array<{id:string;from:string;to:string;status:string;placedAt:string}>;tasks:Array<{code:string;label:string;status:string}>;training:null|{dailyRate:number|null;minimumMinutes:number;acceptedOn:string;eligibleDays:number;reviewDays:number;eligibleAmount:number|null;days:Array<{date:string;minutes:number;amount:number|null;holds:string[]}>}};
const money=(value:number)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:2}).format(value);
const date=(value:string|null)=>value ? new Intl.DateTimeFormat("en-IN",{day:"numeric",month:"short",year:"numeric",timeZone:"Asia/Kolkata"}).format(new Date(`${value.slice(0,10)}T00:00:00+05:30`)):"Not yet";

export function ConnectWorkforceJoining({account,compact=false,activationOnly=false}:{account:AppAccount;compact?:boolean;activationOnly?:boolean}) {
  const [data,setData]=useState<Data|null>(null),[error,setError]=useState(false),[loading,setLoading]=useState(true),[refresh,setRefresh]=useState(0);
  useEffect(()=>{setData(null);},[account.id,account.profileType]);
  useEffect(()=>{
    const controller=new AbortController();let inFlight=false;
    const query=new URLSearchParams({accountId:account.id,profileType:account.profileType});
    const load=async()=>{
      if(inFlight||controller.signal.aborted)return;
      inFlight=true;setLoading(true);
      try {
        const response=await fetch(`/api/connect/workforce-joining?${query}`,{cache:"no-store",signal:controller.signal});
        if(!response.ok)throw new Error("Unavailable");
        const payload=await response.json();
        if(!controller.signal.aborted){setData(payload);setError(false);}
      }catch{if(!controller.signal.aborted)setError(true);}
      finally{inFlight=false;if(!controller.signal.aborted)setLoading(false);}
    };
    void load();
    const poll=()=>{if(document.visibilityState==='visible'&&navigator.onLine)void load();};
    const timer=window.setInterval(poll,30000);
    document.addEventListener('visibilitychange',poll);window.addEventListener('online',poll);
    return ()=>{controller.abort();window.clearInterval(timer);document.removeEventListener('visibilitychange',poll);window.removeEventListener('online',poll);};
  },[account.id,account.profileType,refresh]);
  if(!loading && !error && !data?.available) return null;
  return <section className="dx-dashboard-card dx-joining-card" aria-label={activationOnly?"Work setup status":"Joining status"}>
    <header><div><small>{activationOnly?"Joining journey":"My journey"}</small><h2>{activationOnly?"Work setup status":"Joining status"}</h2></div><button type="button" aria-label="Refresh joining status" disabled={loading} onClick={()=>setRefresh(value=>value+1)}><RefreshCw size={17}/></button></header>
    {error ? <p role="alert">Status could not be refreshed. Last available details are shown; use refresh to retry.</p>:null}
    {loading && !data ? <p role="status">Loading your joining status…</p>:data ? <>
      {data.pilot ? <div className="dx-amazon-pilot-banner"><small>AMAZON ONBOARDING</small><p>Your invitation and registration progress, in one place.</p></div> : null}
      <div className="dx-joining-status"><strong>{data.stageLabel}</strong><span>{data.instruction || (data.mappingEffectiveFrom ? `Work assignment effective ${date(data.mappingEffectiveFrom)}`:data.configured ? "Partner ID or commercial terms pending":"Your station team will confirm your joining plan.")}</span></div>
      {data.pilot ? <div className="dx-amazon-pilot-next">
        <strong>{data.actionOwner === 'Associate' ? 'Your next step' : `Next action: ${data.actionOwner}`}</strong>
        {data.category ? <p>{data.category}</p> : null}
        {data.stage==='registration_pending'?<p>Open the invitation in your registered Amazon email and complete the pending registration steps.</p>:null}
        {data.driverId ? <div><small>DRIVER ID</small><b>{data.driverId}</b></div> : null}
        {data.biometricId ? <div><small>YOUR BIOMETRIC ENROLMENT ID</small><b>{data.biometricId}</b></div> : null}
        {data.stale || data.syncDelayed ? <p role="status">The latest sync is delayed. The status shown is based on the last available report.</p> : null}
        <small>Updates automatically every 30 seconds.</small>
      </div> : null}
      {activationOnly&&data.reportUpdatedAt?<p className="dx-joining-note">Latest partner report: {new Date(data.reportUpdatedAt).toLocaleString("en-IN")}</p>:null}
      {!activationOnly&&data.paymentHolds?.length ? <div role="status" className="dx-joining-note"><strong>Payment on hold</strong><p>Your earnings are retained—not deducted. Contact your station team for review.</p><ul>{data.paymentHolds.map(hold=><li key={hold.id}>{date(hold.from)} – {date(hold.to)} · {hold.status==='release_requested'?'Release awaiting review':'Active hold'}</li>)}</ul></div> : null}
      {!activationOnly&&data.training ? <><div className="dx-joining-metrics"><div><small>Eligible training days</small><strong>{data.training.eligibleDays}</strong></div><div><small>Days needing review</small><strong>{data.training.reviewDays}</strong></div>{data.training.eligibleAmount !== null ? <div><small>Training estimate · to date</small><strong>{money(data.training.eligibleAmount)}</strong></div>:null}</div>
        <p>{data.training.dailyRate !== null ? `${money(data.training.dailyRate)} / eligible day · `:""}{data.training.minimumMinutes} minimum biometric minutes · terms accepted {date(data.training.acceptedOn)}.</p>
        <p className="dx-joining-note">Training stops before the effective provider-mapping date. These are attendance-based estimates, not a payment confirmation. Training and delivery estimates are shown separately.</p>
        {!compact ? <details><summary>Training attendance and review reasons</summary>{data.training.days.length ? <ul className="dx-joining-days">{data.training.days.map(day=><li key={day.date}><div><strong>{date(day.date)}</strong><span>{day.minutes} minutes · {day.holds.length ? "Review required":"Eligible for payroll review"}{day.amount!==null ? ` · ${money(day.amount)}`:""}</span></div>{day.holds.length ? <ul>{day.holds.map(reason=><li key={reason}>{reason}</li>)}</ul>:null}</li>)}</ul>:<p>No training attendance recorded yet.</p>}</details>:null}
      </>:!activationOnly&&data.mode==="direct" ? <p>Regular earnings start under your effective provider and rate mapping.</p>:null}
      {data.providerStage ? <p><strong>Partner-account setup:</strong> {data.providerStage}{data.nextFollowUp ? ` · next team follow-up ${date(data.nextFollowUp)}`:""}</p>:null}
      {data.tasks.length && !["active","offboarded","closed"].includes(data.stage) ? <details open={activationOnly||undefined}><summary>Your DA In-App Onboarding checklist</summary><ul className="dx-joining-tasks">{data.tasks.map(task=><li key={task.code}><span>{task.label}</span><strong>{task.status}</strong></li>)}</ul><p>Complete consent, account verification and courses in Amazon’s app. If background check or video verification is pending, keep your documents ready and check the message or email from the verification partner.</p></details>:null}
      {data.updatedAt ? <small>Team update: {new Intl.DateTimeFormat("en-IN",{dateStyle:"medium",timeStyle:"short",timeZone:"Asia/Kolkata"}).format(new Date(data.updatedAt))} IST</small>:null}
    </>:null}
  </section>;
}
