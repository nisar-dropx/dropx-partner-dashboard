"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Gift, RefreshCw, Send, UsersRound } from "lucide-react";
import type { AppAccount } from "./connect-profile-app";

type Program={id:string;name:string;rewardAmount:number;qualificationSource:string;qualifyingDays:number;terms:string;stationId:string|null;stationName:string|null};
type Referral={id:string;name:string;mobile:string;stationName:string|null;status:string;progress:number;qualifyingDays:number;rewardAmount:number;submittedAt:string};
type Payload={programs:Program[];referrals:Referral[];stations:Array<{id:string;name:string}>};
const money=(value:number)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:0}).format(value);
const title=(value:string)=>value.replaceAll("_"," ").replace(/\b\w/g,letter=>letter.toUpperCase());

export function ConnectReferEarn({account}:{account:AppAccount}) {
  const [data,setData]=useState<Payload|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const load=()=>{setLoading(true);setError("");const query=new URLSearchParams({accountId:account.id,profileType:account.profileType});fetch(`/api/connect/refer-earn?${query}`,{cache:"no-store"}).then(async response=>{const payload=await response.json();if(!response.ok)throw new Error(payload.error||"Unable to load referrals.");setData(payload);}).catch(reason=>setError(reason instanceof Error?reason.message:"Unable to load referrals.")).finally(()=>setLoading(false));};
  useEffect(load,[account.id,account.profileType]);
  async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();setError("");setNotice("");const form=new FormData(event.currentTarget);const response=await fetch("/api/connect/refer-earn",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({accountId:account.id,profileType:account.profileType,programId:form.get("programId"),fullName:form.get("fullName"),countryCode:form.get("countryCode"),mobile:form.get("mobile"),stationId:form.get("stationId")})});const payload=await response.json();if(!response.ok){setError(payload.error||"Unable to submit referral.");return;}event.currentTarget.reset();setNotice("Referral submitted. You can track qualification and reward status here.");load();}
  return <section className="dx-workspace-screen dx-refer-earn">
    <header className="dx-page-intro"><small>Workforce benefit</small><h1>Refer &amp; Earn</h1><p>Refer someone for an eligible role and track the reward through approval and payout.</p><button aria-label="Refresh referrals" onClick={load}><RefreshCw size={17}/></button></header>
    {error?<div className="dx-alert error" role="alert">{error}</div>:null}{notice?<div className="dx-alert success" role="status">{notice}</div>:null}
    {loading?<div className="dx-loader"><span/><small>Loading referral programs…</small></div>:data?<>
      {data.programs.length?<div className="dx-settings-grid">
        <form className="dx-setting-card dx-referral-form" onSubmit={submit}>
          <i><Gift/></i><span><strong>New referral</strong><small>Use the candidate’s correct mobile number so Workforce can link the registration automatically.</small></span>
          <label>Program<select name="programId" required>{data.programs.map(program=><option key={program.id} value={program.id}>{program.name} · {money(program.rewardAmount)}</option>)}</select></label>
          <label>Full name<input name="fullName" minLength={2} maxLength={160} required/></label>
          <div className="dx-referral-mobile"><label>Country code<input name="countryCode" defaultValue="91" inputMode="numeric" required/></label><label>Mobile number<input name="mobile" inputMode="numeric" minLength={6} maxLength={15} required/></label></div>
          <label>Preferred station<select name="stationId" required><option value="">Select station</option>{data.stations.map(station=><option key={station.id} value={station.id}>{station.name}</option>)}</select></label>
          <button type="submit"><Send size={16}/>Submit referral</button>
        </form>
        <section className="dx-setting-card"><i><Gift/></i><span><strong>Current rules</strong><small>Rewards follow the active station program.</small></span>{data.programs.map(program=><div className="dx-referral-rule" key={program.id}><strong>{program.name} · {money(program.rewardAmount)}</strong><small>{program.qualifyingDays} {title(program.qualificationSource)} · {program.stationName||"All stations"}</small><p>{program.terms}</p></div>)}</section>
      </div>:<section className="dx-setting-card"><i><Gift/></i><span><strong>No active referral program</strong><small>Your Workforce team has not enabled a referral rule for your station.</small></span></section>}
      <section className="dx-setting-card dx-referral-history"><i><UsersRound/></i><span><strong>My referrals</strong><small>{data.referrals.length} submitted</small></span>{data.referrals.length?<div>{data.referrals.map(item=><article key={item.id}><div><strong>{item.name}</strong><small>{item.mobile} · {item.stationName||"Station pending"}</small></div><span><b>{title(item.status)}</b><small>{item.progress}/{item.qualifyingDays} days · {money(item.rewardAmount)}</small></span></article>)}</div>:<p>No referrals submitted yet.</p>}</section>
    </>:null}
  </section>;
}
