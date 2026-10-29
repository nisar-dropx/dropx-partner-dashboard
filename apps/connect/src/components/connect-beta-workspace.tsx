"use client";
import { useEffect,useState } from 'react';
import { ArrowRight, BadgeCheck, CalendarDays, Copy, Fingerprint, Mail, RefreshCw, ShieldCheck, WalletCards } from 'lucide-react';
import type { AppAccount } from './connect-profile-app';
import type { BetaOnboardingData } from './connect-beta-onboarding';
import type { BetaAttendance } from '../lib/beta-attendance';
import s from './connect-beta-workspace.module.css';
const date=(value?:string|null,time=false)=>value?new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',...(time?{hour:'numeric',minute:'2-digit'}:{day:'numeric',month:'short'})}).format(new Date(value)):'—';
const currentMonth=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit'}).format(new Date()).replace('/','-');
type View='home'|'work'|'payments';
export function ConnectBetaWorkspace({account,view,onOpen}:{account:AppAccount;view:View;onOpen:(step:'activation'|'profile'|'betaInbox'|'work'|'payments')=>void}) {
 const [data,setData]=useState<BetaOnboardingData|null>(null),[days,setDays]=useState<BetaAttendance[]>([]),[month,setMonth]=useState(currentMonth),[busy,setBusy]=useState(true),[error,setError]=useState(''),[attempt,setAttempt]=useState(0),[copied,setCopied]=useState(false),[truncated,setTruncated]=useState(false);
 useEffect(()=>{
  let disposed=false,inFlight=false;let requestController:AbortController|null=null;
  const load=async()=>{
   if(inFlight||document.visibilityState!=='visible')return;inFlight=true;setBusy(true);
   const controller=new AbortController();requestController=controller;const timeout=window.setTimeout(()=>controller.abort(),20000);
   const query=new URLSearchParams({accountId:account.id,profileType:account.profileType});
   try{
    const requests=[fetch(`/api/connect/workforce-joining?${query}`,{cache:'no-store',signal:controller.signal}),...(view==='work'?[fetch(`/api/connect/beta-workspace?${query}&month=${month}`,{cache:'no-store',signal:controller.signal})]:[])];
    const responses=await Promise.all(requests);if(responses.some(r=>!r.ok))throw new Error();
    const [status,history]=await Promise.all(responses.map(r=>r.json()));if(disposed)return;
    if(!status.available)throw new Error();setData(status);if(history){setDays(history.days);setTruncated(history.truncated);}setError('');
   }catch{if(!disposed)setError('Updates could not be loaded. Your last confirmed information is shown below.');}
   finally{window.clearTimeout(timeout);inFlight=false;if(!disposed)setBusy(false);}
  };
  void load();const timer=window.setInterval(load,60000);window.addEventListener('focus',load);
  return()=>{disposed=true;requestController?.abort();window.clearInterval(timer);window.removeEventListener('focus',load);};
 },[account.id,account.profileType,view,month,attempt]);
 const punch=data?.latestAttendance;
 const review=data?.registrationStatus==='confirmed'?'Reviewed':data?.registrationStatus==='returned'?'Update needed':'Review pending';
 const title=view==='work'?'Your work':view==='payments'?'Your payments':`Hi, ${account.name?.split(' ')[0]||'there'}`;
 const copy=async()=>{try{await navigator.clipboard.writeText(data?.driverId??'');setCopied(true);window.setTimeout(()=>setCopied(false),2000);}catch{setError('Could not copy. Select your Driver ID to copy it.');}};
 const record=(day:{date?:string;punch_date?:string;inTime?:string|null;outTime?:string|null;in_time?:string|null;out_time?:string|null;reviewRequired?:boolean})=><div className={s.punch}><strong>{date(`${day.date??day.punch_date}T12:00:00+05:30`)}</strong><span>IN <b>{date(day.inTime??day.in_time,true)}</b></span><span>OUT <b>{date(day.outTime??day.out_time,true)}</b></span><small className={day.reviewRequired?s.pending:s.good}>{day.reviewRequired?'Received · review pending':'Processed'}</small></div>;
 return <section className={s.workspace}>
  <header className={s.heading}><div><small>YOUR WORKSPACE · BETA</small><h1>{title}</h1><p>{view==='home'?'Your workday, updates and next steps.':view==='work'?'Biometric punches received for your beta ID.':'Payment setup and your rate card, in one place.'}</p></div><button className={s.icon} aria-label="Refresh workspace" disabled={busy} onClick={()=>setAttempt(x=>x+1)}><RefreshCw size={19} className={busy?s.spin:''}/></button></header>
  {error?<div className={s.warning} role="alert">{error} <button onClick={()=>setAttempt(x=>x+1)}>Retry</button></div>:null}
  {busy&&!data?<p role="status">Loading your workspace…</p>:null}
  {view==='home'?<>
   <section className={s.hero}><BadgeCheck size={30}/><div><small>AMAZON ID</small><h2>{data?.operationalStatus==='ACTIVE'?'Active':data?'Status updating':'Checking status…'}</h2><p>{data?.sourceStatus?.amazonUpdatedAt?`Last confirmed ${date(data.sourceStatus.amazonUpdatedAt)} · ${date(data.sourceStatus.amazonUpdatedAt,true)}`:'Waiting for the latest confirmation'}</p>{data?.sourceStatus?.amazonDelayed||data?.sourceStatus?.unavailable?<small>Amazon sync delayed · showing the last confirmation</small>:null}</div><button onClick={()=>onOpen('activation')}>Work status <ArrowRight size={16}/></button></section>
   <div className={s.identity}><div><small>Amazon Driver ID</small><strong>{data?.driverId||'Checking…'}</strong></div><button disabled={!data?.driverId} onClick={copy} aria-label="Copy Amazon Driver ID"><Copy size={16}/>{copied?'Copied':'Copy'}</button><div><small>Biometric ID</small><strong>{account.biometricId||'Not assigned'}</strong></div></div>
   <div className={s.grid}>
    <section className={s.card}><header><Fingerprint/><h2>Latest punch</h2></header>{data?.attendanceUnavailable?<p>Attendance sync is unavailable. Retry to check your latest punch.</p>:punch?record(punch):<p>No biometric punch received yet.</p>}{punch?.reviewRequired?<p className={s.note}>Your punch reached DropX. The station team needs to confirm the biometric mapping before attendance or pay is approved.</p>:null}<button className={s.link} onClick={()=>onOpen('work')}>View attendance <ArrowRight size={16}/></button></section>
    <section className={s.card}><header><WalletCards/><h2>Payment setup</h2></header><span className={s.pending}>ID & pay mapping pending</span><p>Your beta ID is separate from your existing profiles. Earnings will appear after the correct Workforce ID and rate card are linked.</p><button className={s.link} onClick={()=>onOpen('payments')}>View payment readiness <ArrowRight size={16}/></button></section>
   </div>
   <div className={s.actions}><button onClick={()=>onOpen('betaInbox')}><Mail/><span><strong>Your inbox</strong><small>Amazon and IDfy emails, codes & links</small></span><ArrowRight/></button><button onClick={()=>onOpen('profile')}><ShieldCheck/><span><strong>Registration</strong><small>{review}</small></span><ArrowRight/></button></div>
  </>:view==='work'?<section className={s.card}>
   <header className={s.month}><h2><CalendarDays size={20}/> Attendance history</h2><label>Month<input aria-label="Attendance month" type="month" value={month} max={currentMonth()} onChange={e=>{if(e.target.value){setDays([]);setMonth(e.target.value);}}}/></label></header>
   {days.length?days.map(day=><div key={day.punch_date}>{record(day)}</div>):!busy&&!error?<p>No punches received for this month.</p>:null}
   {truncated?<p role="status">This month has unusually many device records. Ask your station team to check the full log.</p>:null}
   <p className={s.note}>Times are in IST. “Received” confirms a device punch; attendance approval and payable days depend on the station’s mapping review. A missing OUT remains blank.</p>
  </section>:<>
   <section className={s.card}><header><WalletCards/><h2>Connect your payment profile</h2></header><span className={s.pending}>Awaiting Workforce mapping</span><p>Your Amazon ID is active. To calculate earnings, the Workforce team must confirm the correct DropX ID and effective payment scheme for this beta identity.</p><div className={s.checklist}><div><BadgeCheck/><span>Amazon activation</span><b>Confirmed</b></div><div><ShieldCheck/><span>Registration review</span><b>{review}</b></div><div><WalletCards/><span>DropX ID & pay mapping</span><b>Pending</b></div></div><button className={s.link} onClick={()=>onOpen('profile')}>View your registration <ArrowRight size={16}/></button></section>
   <section className={s.card}><h2>Your rate card</h2><p>No rate card is linked to this beta ID yet. Salary, delivery and fuel rates will be shown after mapping; no earnings have been calculated here.</p></section>
  </>}
  <footer className={s.footer}><span>Private beta · Your other accounts remain separate</span><button onClick={()=>onOpen('activation')}>Onboarding history <ArrowRight size={14}/></button></footer>
 </section>;
}
