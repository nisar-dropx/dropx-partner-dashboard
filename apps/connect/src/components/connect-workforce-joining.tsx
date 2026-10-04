"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, RefreshCw } from "lucide-react";
import type { AppAccount } from "./connect-profile-app";

type Data = {pilot?:boolean;stale?:boolean;syncDelayed?:boolean;reportDate?:string;driverId?:string|null;biometricId?:string;amazonAccountId?:string|null;registrationRequired?:boolean;registrationStatus?:string|null;actionOwner?:string;category?:string;amazonAction?:string;instruction?:string;reportUpdatedAt?:string|null;available:boolean;stage:string;stageLabel:string;configured:boolean;mode:string|null;firstPunch:string|null;mappingEffectiveFrom:string|null;providerStage:string|null;nextFollowUp:string|null;updatedAt:string|null;paymentHolds?:Array<{id:string;from:string;to:string;status:string;placedAt:string}>;tasks:Array<{code:string;label:string;status:string}>;training:null|{dailyRate:number|null;minimumMinutes:number;acceptedOn:string;eligibleDays:number;reviewDays:number;eligibleAmount:number|null;days:Array<{date:string;minutes:number;amount:number|null;holds:string[]}>}};
const money=(value:number)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:2}).format(value);
const date=(value:string|null)=>value ? new Intl.DateTimeFormat("en-IN",{day:"numeric",month:"short",year:"numeric",timeZone:"Asia/Kolkata"}).format(new Date(`${value.slice(0,10)}T00:00:00+05:30`)):"Not yet";

export function ConnectWorkforceJoining({account,compact=false,activationOnly=false,onRegister}:{account:AppAccount;compact?:boolean;activationOnly?:boolean;onRegister?:()=>void}) {
  const [data,setData]=useState<Data|null>(null),[error,setError]=useState(false),[loading,setLoading]=useState(true),[refreshing,setRefreshing]=useState(false),[refresh,setRefresh]=useState(0);
  const dataRef=useRef<Data|null>(null);
  useEffect(()=>{dataRef.current=null;setData(null);},[account.id,account.profileType]);
  useEffect(()=>{
    let disposed=false,inFlight=false,activeController:AbortController|null=null;
    const query=new URLSearchParams({accountId:account.id,profileType:account.profileType});
    const load=async(initial=false)=>{
      if(inFlight||disposed)return;
      inFlight=true;
      if(initial&&!dataRef.current)setLoading(true);else setRefreshing(true);
      const controller=new AbortController();activeController=controller;
      const timeout=window.setTimeout(()=>controller.abort(),12000);
      try {
        const response=await fetch(`/api/connect/workforce-joining?${query}`,{cache:"no-store",signal:controller.signal});
        if(!response.ok)throw new Error("Unavailable");
        const payload=await response.json();
        if(!disposed){dataRef.current=payload;setData(payload);setError(false);}
      }catch{if(!disposed)setError(true);}
      finally{
        window.clearTimeout(timeout);inFlight=false;
        if(!disposed){setLoading(false);setRefreshing(false);}
      }
    };
    void load(true);
    const poll=()=>{if(document.visibilityState==="visible"&&navigator.onLine)void load(false);};
    const timer=window.setInterval(poll,30000);
    document.addEventListener("visibilitychange",poll);window.addEventListener("online",poll);
    return ()=>{disposed=true;activeController?.abort();window.clearInterval(timer);document.removeEventListener("visibilitychange",poll);window.removeEventListener("online",poll);};
  },[account.id,account.profileType,refresh]);
  const accountNeedsRegistration=["pending","returned"].includes(String(account.status??"").toLowerCase());
  const registrationRequired=Boolean(onRegister&&(data?.registrationRequired||(!data&&accountNeedsRegistration)));
  if(!loading && !error && !data?.available && !registrationRequired) return null;
  return <section className="dx-dashboard-card dx-joining-card" aria-label={activationOnly?"Work setup status":"Joining status"}>
    <header><div><small>{activationOnly?"BETA ONBOARDING":"My journey"}</small><h2>{activationOnly?"Work setup":"Joining status"}</h2></div><button type="button" aria-label="Refresh joining status" disabled={refreshing} onClick={()=>setRefresh(value=>value+1)}><RefreshCw className={refreshing?"dx-spin":""} size={17}/></button></header>
    {error ? <div className="dx-joining-error" role="alert"><strong>Status refresh paused</strong><span>{data?"Showing the last available update.":"Use refresh to try again."}</span></div>:null}
    {loading && !data ? <p role="status">Loading your joining status…</p>:data ? <>
      <div className="dx-joining-status"><strong>{data.stageLabel}</strong><span>{data.instruction || (data.mappingEffectiveFrom ? `Work assignment effective ${date(data.mappingEffectiveFrom)}`:data.configured ? "Partner ID or commercial terms pending":"Your station team will confirm your joining plan.")}</span></div>
      {registrationRequired?<button className="dx-registration-cta" type="button" onClick={onRegister}><span><strong>Complete DropX registration</strong><small>Confirm your details and submit them for Workforce review.</small></span><ArrowRight size={18}/></button>:null}
      {data.pilot ? <div className="dx-amazon-pilot-next">
        <div className="dx-pilot-next-line"><span><small>NEXT ACTION</small><strong>{data.actionOwner === "Associate" ? "Complete the step shown above" : data.actionOwner}</strong></span>{data.updatedAt?<time>Updated {new Intl.DateTimeFormat("en-IN",{day:"numeric",month:"short",hour:"numeric",minute:"2-digit",timeZone:"Asia/Kolkata"}).format(new Date(data.updatedAt))}</time>:null}</div>
        <dl className="dx-pilot-identifiers">
          <div><dt>LSC Driver ID</dt><dd>{data.driverId||"Awaiting LSC"}</dd></div>
          <div><dt>DropX registration</dt><dd>{data.registrationStatus==="submitted"?"Submitted for review":"Pending"}</dd></div>
          {data.biometricId?<div><dt>Biometric ID</dt><dd>{data.biometricId} · attendance only</dd></div>:null}
          {data.amazonAccountId?<div><dt>Amazon account</dt><dd title={data.amazonAccountId}>{data.amazonAccountId}</dd></div>:null}
        </dl>
        {data.stale || data.syncDelayed ? <p role="status">Partner report sync is delayed; the invitation status above is live.</p> : null}
      </div> : null}
      {activationOnly&&(data.reportDate||data.reportUpdatedAt)?<p className="dx-joining-note">Latest partner report: {data.reportDate?date(data.reportDate):new Intl.DateTimeFormat("en-IN",{dateStyle:"medium",timeStyle:"short",timeZone:"Asia/Kolkata"}).format(new Date(data.reportUpdatedAt!))}</p>:null}
      {!activationOnly&&data.paymentHolds?.length ? <div role="status" className="dx-joining-note"><strong>Payment on hold</strong><p>Your earnings are retained—not deducted. Contact your station team for review.</p><ul>{data.paymentHolds.map(hold=><li key={hold.id}>{date(hold.from)} – {date(hold.to)} · {hold.status==='release_requested'?'Release awaiting review':'Active hold'}</li>)}</ul></div> : null}
      {!activationOnly&&data.training ? <><div className="dx-joining-metrics"><div><small>Eligible training days</small><strong>{data.training.eligibleDays}</strong></div><div><small>Days needing review</small><strong>{data.training.reviewDays}</strong></div>{data.training.eligibleAmount !== null ? <div><small>Training estimate · to date</small><strong>{money(data.training.eligibleAmount)}</strong></div>:null}</div>
        <p>{data.training.dailyRate !== null ? `${money(data.training.dailyRate)} / eligible day · `:""}{data.training.minimumMinutes} minimum biometric minutes · terms accepted {date(data.training.acceptedOn)}.</p>
        {!compact ? <details><summary>Training attendance and review reasons</summary>{data.training.days.length ? <ul className="dx-joining-days">{data.training.days.map(day=><li key={day.date}><div><strong>{date(day.date)}</strong><span>{day.minutes} minutes · {day.holds.length ? "Review required":"Eligible for payroll review"}{day.amount!==null ? ` · ${money(day.amount)}`:""}</span></div>{day.holds.length ? <ul>{day.holds.map(reason=><li key={reason}>{reason}</li>)}</ul>:null}</li>)}</ul>:<p>No training attendance recorded yet.</p>}</details>:null}
      </>:!activationOnly&&data.mode==="direct" ? <p>Regular earnings start under your effective provider and rate mapping.</p>:null}
      {data.tasks.length && !["active","offboarded","closed"].includes(data.stage) ? <details><summary>DA In-App checklist</summary><ul className="dx-joining-tasks">{data.tasks.map(task=><li key={task.code}><span>{task.label}</span><strong>{task.status}</strong></li>)}</ul></details>:null}
    </>:registrationRequired?<button className="dx-registration-cta" type="button" onClick={onRegister}><span><strong>Complete DropX registration</strong><small>Confirm your details and submit them for Workforce review.</small></span><ArrowRight size={18}/></button>:null}
  </section>;
}
