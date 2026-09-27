"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Check, Gift, RefreshCw, Send, UsersRound } from "lucide-react";
import type { AppAccount } from "./connect-profile-app";

type Program={id:string;name:string;rewardAmount:number;qualificationSource:string;qualificationSourceName:string;qualifyingDays:number;terms:string;stationId:string|null;stationName:string|null};
type Referral={id:string;name:string;mobile:string;stationName:string|null;status:string;progress:number;qualifyingDays:number;rewardAmount:number;qualificationSourceName:string;submittedAt:string;qualifiedAt:string|null;approvedAt:string|null;paidAt:string|null;adjustmentStatus:string|null;inPayroll:boolean};
type Payload={programs:Program[];referrals:Referral[];stations:Array<{id:string;name:string}>};
const money=(value:number)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:0}).format(value);
const title=(value:string)=>value.replaceAll("_"," ").replace(/\b\w/g,letter=>letter.toUpperCase());

function ReferralJourney({item}:{item:Referral}){
  const linked=item.status!=="submitted";
  const steps=[
    ["Referred",true],
    ["Registered",linked],
    ["Qualified",Boolean(item.qualifiedAt||["qualified","approved","paid"].includes(item.status))],
    ["Approved",Boolean(item.approvedAt||["approved","paid"].includes(item.status))],
    ["Payroll",item.inPayroll],
    ["Paid",Boolean(item.paidAt||item.status==="paid")]
  ] as const;
  return <div className="dx-referral-journey">{steps.map(([label,done])=><span className={done?"done":""} key={label}><i>{done?<Check/>:null}</i><small>{label}</small></span>)}</div>;
}

export function ConnectReferEarn({account}:{account:AppAccount}) {
  const [data,setData]=useState<Payload|null>(null);
  const [loading,setLoading]=useState(true);
  const [submitting,setSubmitting]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [stationId,setStationId]=useState("");
  const load=()=>{setLoading(true);setError("");const query=new URLSearchParams({accountId:account.id,profileType:account.profileType});fetch(`/api/connect/refer-earn?${query}`,{cache:"no-store"}).then(async response=>{const payload=await response.json();if(!response.ok)throw new Error(payload.error||"Unable to load referrals.");setData(payload);}).catch(reason=>setError(reason instanceof Error?reason.message:"Unable to load referrals.")).finally(()=>setLoading(false));};
  useEffect(load,[account.id,account.profileType]);
  const programs=useMemo(()=>data?.programs.filter(program=>!program.stationId||program.stationId===stationId)??[],[data,stationId]);

  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();setError("");setNotice("");setSubmitting(true);
    const form=new FormData(event.currentTarget);
    try{
      const response=await fetch("/api/connect/refer-earn",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({accountId:account.id,profileType:account.profileType,programId:form.get("programId"),fullName:form.get("fullName"),countryCode:form.get("countryCode"),mobile:form.get("mobile"),stationId:form.get("stationId")})});
      const payload=await response.json();
      if(!response.ok)throw new Error(payload.error||"Unable to submit referral.");
      event.currentTarget.reset();setStationId("");setNotice("Referral submitted. The journey will update when the candidate registers with this mobile number.");load();
    }catch(reason){setError(reason instanceof Error?reason.message:"Unable to submit referral.");}
    finally{setSubmitting(false);}
  }
  return <section className="dx-workspace-screen dx-refer-earn">
    <header className="dx-page-intro"><small>Workforce benefit</small><h1>Refer &amp; Earn</h1><p>Refer a candidate and follow the same record through registration, qualifying days, approval and payout.</p><button aria-label="Refresh referrals" onClick={load}><RefreshCw size={17}/></button></header>
    {error?<div className="dx-alert error" role="alert">{error}</div>:null}{notice?<div className="dx-alert success" role="status">{notice}</div>:null}
    {loading?<div className="dx-loader"><span/><small>Loading referral programs…</small></div>:data?<>
      {data.programs.length?<div className="dx-settings-grid dx-referral-grid">
        <form className="dx-setting-card dx-referral-form" onSubmit={submit}>
          <i><Gift/></i><span><strong>Refer a candidate</strong><small>Use the mobile number the candidate will use during registration. Workforce links the journey automatically.</small></span>
          <label>Preferred work location<select name="stationId" onChange={event=>setStationId(event.target.value)} required value={stationId}><option value="">Select location</option>{data.stations.map(station=><option key={station.id} value={station.id}>{station.name}</option>)}</select></label>
          <label>Reward program<select disabled={!stationId||!programs.length} name="programId" required><option value="">{stationId?(programs.length?"Select program":"No active program for this location"):"Choose location first"}</option>{programs.map(program=><option key={program.id} value={program.id}>{program.name} · {money(program.rewardAmount)}</option>)}</select></label>
          <label>Candidate full name<input name="fullName" minLength={2} maxLength={160} required/></label>
          <div className="dx-referral-mobile"><label>Country code<input name="countryCode" defaultValue="91" inputMode="numeric" required/></label><label>Mobile number<input name="mobile" inputMode="numeric" minLength={6} maxLength={15} required/></label></div>
          <button disabled={submitting||!programs.length} type="submit"><Send size={16}/>{submitting?"Submitting…":"Submit referral"}</button>
        </form>
        <section className="dx-setting-card dx-referral-rules"><i><Gift/></i><span><strong>Available rewards</strong><small>Amount and qualifying rule are set by Workforce for each location.</small></span>{data.programs.map(program=><div className="dx-referral-rule" key={program.id}><strong>{program.name} · {money(program.rewardAmount)}</strong><small>{program.qualifyingDays} {program.qualificationSourceName} · {program.stationName||"All locations"}</small><p>{program.terms}</p></div>)}</section>
      </div>:<section className="dx-setting-card"><i><Gift/></i><span><strong>No active referral program</strong><small>Your Workforce team has not enabled a referral rule for your location.</small></span></section>}
      <section className="dx-setting-card dx-referral-history"><i><UsersRound/></i><span><strong>My referrals</strong><small>{data.referrals.length} submitted</small></span>{data.referrals.length?<div>{data.referrals.map(item=><article key={item.id}><header><div><strong>{item.name}</strong><small>{item.mobile} · {item.stationName||"Location pending"}</small></div><b>{title(item.status)}</b></header><ReferralJourney item={item}/><footer><span>{item.progress}/{item.qualifyingDays} qualifying days · {item.qualificationSourceName}</span><strong>{money(item.rewardAmount)}</strong></footer></article>)}</div>:<p>No referrals submitted yet.</p>}</section>
    </>:null}
  </section>;
}
