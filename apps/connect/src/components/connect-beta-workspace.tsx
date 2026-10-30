"use client";
import { useEffect,useState } from 'react';
import { ArrowRight, BadgeCheck, CalendarDays, Fingerprint, Mail, RefreshCw, ShieldCheck, WalletCards } from 'lucide-react';
import type { AppAccount } from './connect-profile-app';
import type { BetaOnboardingData } from './connect-beta-onboarding';
import type { BetaWorkforceIdentity } from '../lib/beta-workforce-identity';
import type { BetaAttendance } from '../lib/beta-attendance';
import s from './connect-beta-workspace.module.css';
const date=(value?:string|null,time=false)=>value?new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',...(time?{hour:'numeric',minute:'2-digit'}:{day:'numeric',month:'short'})}).format(new Date(value)):'—';
const currentMonth=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit'}).format(new Date()).replace('/','-');
type View='home'|'work'|'payments';
export function ConnectBetaWorkspace({account,view,onOpen}:{account:AppAccount;view:View;onOpen:(step:'activation'|'profile'|'betaInbox'|'work'|'payments')=>void}) {
 const [identity,setIdentity]=useState<BetaWorkforceIdentity|null>(null);
 const [data,setData]=useState<BetaOnboardingData|null>(null),[days,setDays]=useState<BetaAttendance[]>([]),[month,setMonth]=useState(currentMonth),[busy,setBusy]=useState(true),[error,setError]=useState(''),[attempt,setAttempt]=useState(0),[truncated,setTruncated]=useState(false);
 useEffect(()=>{
  let disposed=false,inFlight=false;let requestController:AbortController|null=null;
  const load=async()=>{
   if(inFlight||document.visibilityState!=='visible')return;inFlight=true;setBusy(true);
   const controller=new AbortController();requestController=controller;const timeout=window.setTimeout(()=>controller.abort(),20000);
   const query=new URLSearchParams({accountId:account.id,profileType:account.profileType});
   try{
    const requests=[fetch(`/api/connect/workforce-joining?${query}`,{cache:'no-store',signal:controller.signal}),fetch(`/api/connect/beta-workspace?${query}&month=${month}&attendance=${view==='work'?'1':'0'}`,{cache:'no-store',signal:controller.signal})];
    const responses=await Promise.all(requests);if(responses.some(r=>!r.ok))throw new Error();
    const [status,history]=await Promise.all(responses.map(r=>r.json()));if(disposed)return;
    if(!status.available)throw new Error();setData(status);if(history){setDays(history.days);setTruncated(history.truncated);setIdentity(history.identity);}setError('');
   }catch{if(!disposed)setError('Updates could not be loaded. Your last confirmed information is shown below.');}
   finally{window.clearTimeout(timeout);inFlight=false;if(!disposed)setBusy(false);}
  };
  void load();const timer=window.setInterval(load,60000);window.addEventListener('focus',load);
  return()=>{disposed=true;requestController?.abort();window.clearInterval(timer);window.removeEventListener('focus',load);};
 },[account.id,account.profileType,view,month,attempt]);
 const punch=data?.latestAttendance;
 const review=data?.registrationStatus==='confirmed'?'Reviewed':data?.registrationStatus==='returned'?'Update needed':'Review pending';
 const title=view==='work'?'Your work':view==='payments'?'Your payments':`Hi, ${account.name?.split(' ')[0]||'there'}`;

 const record=(day:{date?:string;punch_date?:string;inTime?:string|null;outTime?:string|null;in_time?:string|null;out_time?:string|null;reviewRequired?:boolean})=><div className={s.punch}><strong>{date(`${day.date??day.punch_date}T12:00:00+05:30`)}</strong><span>IN <b>{date(day.inTime??day.in_time,true)}</b></span><span>OUT <b>{date(day.outTime??day.out_time,true)}</b></span><small className={day.reviewRequired?s.pending:s.good}>{day.reviewRequired?'Received · review pending':'Processed'}</small></div>;
 return <section className={s.workspace}>
  <header className={s.heading}><div><small>YOUR WORKSPACE</small><h1>{title}</h1><p>{view==='home'?'Your attendance and earnings, in one place.':view==='work'?'Biometric punches received for your beta ID.':'Payment setup and your rate card, in one place.'}</p></div><button className={s.icon} aria-label="Refresh workspace" disabled={busy} onClick={()=>setAttempt(x=>x+1)}><RefreshCw size={19} className={busy?s.spin:''}/></button></header>
  {error?<div className={s.warning} role="alert">{error} <button onClick={()=>setAttempt(x=>x+1)}>Retry</button></div>:null}
  {busy&&!data?<p role="status">Loading your workspace…</p>:null}
  {view==='home'?<>

   <div className={s.grid}>
    <section className={s.card}><header><Fingerprint/><h2>Latest punch</h2></header>{data?.attendanceUnavailable?<p>Attendance sync is unavailable. Retry to check your latest punch.</p>:punch?record(punch):<p>No biometric punch received yet.</p>}{punch?.reviewRequired?<p className={s.note}>Punch saved. Your station team is reviewing attendance.</p>:null}<button className={s.link} onClick={()=>onOpen('work')}>View attendance <ArrowRight size={16}/></button></section>
    <section className={s.card}><header><WalletCards/><h2>Earnings</h2></header><h3 className={s.amount}>Not available yet</h3><p>{identity?.paymentConfigured?'Your payment scheme is linked. Earnings are awaiting review.':'Your station team needs to add your payment rate.'}</p><button className={s.link} onClick={()=>onOpen('payments')}>View payments <ArrowRight size={16}/></button></section>
   </div>
   <div className={s.actions}><button onClick={()=>onOpen('betaInbox')}><Mail/><span><strong>Your inbox</strong><small>Your Amazon email, codes & links</small></span><ArrowRight/></button><button onClick={()=>onOpen('profile')}><ShieldCheck/><span><strong>My profile</strong><small>{identity?.dropxId || "Your personal details"}</small></span><ArrowRight/></button></div>
  </>:view==='work'?<section className={s.card}>
   <header className={s.month}><h2><CalendarDays size={20}/> Attendance history</h2><label>Month<input aria-label="Attendance month" type="month" value={month} max={currentMonth()} onChange={e=>{if(e.target.value){setDays([]);setMonth(e.target.value);}}}/></label></header>
   {days.length?days.map(day=><div key={day.punch_date}>{record(day)}</div>):!busy&&!error?<p>No punches received for this month.</p>:null}
   {truncated?<p role="status">This month has unusually many device records. Ask your station team to check the full log.</p>:null}
   <p className={s.note}>Times are in IST. “Received” confirms a device punch; attendance approval and payable days depend on the station’s mapping review. A missing OUT remains blank.</p>
  </section>:<>
   <section className={s.card}><header><WalletCards/><h2>Your payment profile</h2></header><span className={identity?s.good:s.pending}>{identity?'Employee identity linked':'Awaiting employee identity'}</span><p>{identity?`${identity.dropxId} is linked to Amazon payout ID ${identity.providerId}. ${identity.paymentConfigured?'A payment scheme is configured. Published earnings will follow the payout review.':'Add the payment scheme and effective dates in OpsPulse to configure earnings.'}`:'Your Amazon ID is active. Your permanent DropX identity is still pending.'}</p><div className={s.checklist}><div><BadgeCheck/><span>Amazon activation</span><b>Confirmed</b></div><div><ShieldCheck/><span>Registration review</span><b>{review}</b></div><div><WalletCards/><span>DropX employee ID</span><b>{identity?.dropxId||'Pending'}</b></div><div><WalletCards/><span>Payment scheme</span><b>{identity?.paymentConfigured?'Configured':'Not configured'}</b></div></div><button className={s.link} onClick={()=>onOpen('profile')}>View your registration <ArrowRight size={16}/></button></section>
   <section className={s.card}><h2>Your rate card</h2><p>{identity?.paymentConfigured?'Your payment scheme is linked. Detailed rates and earnings will be available after the payout handover.':'No payment scheme is configured yet. Salary, delivery and fuel rates remain pending; a missing rate is not treated as ₹0.'}</p></section>
  </>}
  <footer className={s.footer}><button onClick={()=>onOpen('activation')}>Onboarding history <ArrowRight size={14}/></button></footer>
 </section>;
}
