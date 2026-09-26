"use client";
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { AppAccount } from "./connect-profile-app";

type Data = {available:boolean;stage:string;stageLabel:string;configured:boolean;mode:string|null;firstPunch:string|null;mappingEffectiveFrom:string|null;providerStage:string|null;nextFollowUp:string|null;updatedAt:string|null;paymentHolds?:Array<{id:string;from:string;to:string;status:string;placedAt:string}>;tasks:Array<{code:string;label:string;status:string}>;training:null|{dailyRate:number|null;minimumMinutes:number;acceptedOn:string;eligibleDays:number;reviewDays:number;eligibleAmount:number|null;days:Array<{date:string;minutes:number;amount:number|null;holds:string[]}>}};
const money=(value:number)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:2}).format(value);
const date=(value:string|null)=>value ? new Intl.DateTimeFormat("en-IN",{day:"numeric",month:"short",year:"numeric",timeZone:"Asia/Kolkata"}).format(new Date(`${value.slice(0,10)}T00:00:00+05:30`)):"Not yet";

export function ConnectWorkforceJoining({account,compact=false,activationOnly=false}:{account:AppAccount;compact?:boolean;activationOnly?:boolean}) {
  const [data,setData]=useState<Data|null>(null),[error,setError]=useState(false),[loading,setLoading]=useState(true),[refresh,setRefresh]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError(false);setData(null);
    const query=new URLSearchParams({accountId:account.id,profileType:account.profileType});
    fetch(`/api/connect/workforce-joining?${query}`,{cache:"no-store",signal:controller.signal}).then(async response=>{
      if(!response.ok) throw new Error("Unavailable");
      const payload=await response.json();if(!controller.signal.aborted) setData(payload);
    }).catch(()=>{if(!controller.signal.aborted)setError(true);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[account.id,account.profileType,refresh]);
  if(!loading && !error && !data?.available) return null;
  return <section className="dx-dashboard-card dx-joining-card" aria-label={activationOnly?"Amazon ID status":"Joining status"}>
    <header><div><small>{activationOnly?"Activation journey":"My journey"}</small><h2>{activationOnly?"Amazon ID status":"Joining status"}</h2></div><button type="button" aria-label="Refresh joining status" disabled={loading} onClick={()=>setRefresh(value=>value+1)}><RefreshCw size={17}/></button></header>
    {loading ? <p role="status">Loading your joining status…</p>:error ? <p role="alert">Joining details are unavailable. Use refresh to retry; your saved records are unchanged.</p>:data ? <>
      <div className="dx-joining-status"><strong>{data.stageLabel}</strong><span>{data.mappingEffectiveFrom ? `Provider mapping effective ${date(data.mappingEffectiveFrom)}`:data.configured ? "Provider mapping pending":"Your station team will confirm your joining plan."}</span></div>
      {!activationOnly&&data.paymentHolds?.length ? <div role="status" className="dx-joining-note"><strong>Payment on hold</strong><p>Your earnings are retained—not deducted. Contact your station team for review.</p><ul>{data.paymentHolds.map(hold=><li key={hold.id}>{date(hold.from)} – {date(hold.to)} · {hold.status==='release_requested'?'Release awaiting review':'Active hold'}</li>)}</ul></div> : null}
      {!activationOnly&&data.training ? <><div className="dx-joining-metrics"><div><small>Eligible training days</small><strong>{data.training.eligibleDays}</strong></div><div><small>Days needing review</small><strong>{data.training.reviewDays}</strong></div>{data.training.eligibleAmount !== null ? <div><small>Training estimate · to date</small><strong>{money(data.training.eligibleAmount)}</strong></div>:null}</div>
        <p>{data.training.dailyRate !== null ? `${money(data.training.dailyRate)} / eligible day · `:""}{data.training.minimumMinutes} minimum biometric minutes · terms accepted {date(data.training.acceptedOn)}.</p>
        <p className="dx-joining-note">Training stops before the effective provider-mapping date. These are attendance-based estimates, not a payment confirmation. Training and delivery estimates are shown separately.</p>
        {!compact ? <details><summary>Training attendance and review reasons</summary>{data.training.days.length ? <ul className="dx-joining-days">{data.training.days.map(day=><li key={day.date}><div><strong>{date(day.date)}</strong><span>{day.minutes} minutes · {day.holds.length ? "Review required":"Eligible for payroll review"}{day.amount!==null ? ` · ${money(day.amount)}`:""}</span></div>{day.holds.length ? <ul>{day.holds.map(reason=><li key={reason}>{reason}</li>)}</ul>:null}</li>)}</ul>:<p>No training attendance recorded yet.</p>}</details>:null}
      </>:!activationOnly&&data.mode==="direct" ? <p>Regular earnings start under your effective provider and rate mapping.</p>:null}
      {data.providerStage ? <p><strong>Provider onboarding:</strong> {data.providerStage}{data.nextFollowUp ? ` · next team follow-up ${date(data.nextFollowUp)}`:""}</p>:null}
      {data.tasks.length && !["active","offboarded","closed"].includes(data.stage) ? <details open={activationOnly||undefined}><summary>Your DA In-App Onboarding checklist</summary><ul className="dx-joining-tasks">{data.tasks.map(task=><li key={task.code}><span>{task.label}</span><strong>{task.status}</strong></li>)}</ul><p>Complete consent, account verification and courses in Amazon’s app. If background check or video verification is pending, keep your documents ready and check the message or email from the verification partner.</p></details>:null}
      {data.updatedAt ? <small>Team update: {new Intl.DateTimeFormat("en-IN",{dateStyle:"medium",timeStyle:"short",timeZone:"Asia/Kolkata"}).format(new Date(data.updatedAt))} IST</small>:null}
    </>:null}
  </section>;
}
