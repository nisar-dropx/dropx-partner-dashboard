"use client";

import {
  ArrowLeft, ArrowRight, BadgeCheck, Check, CheckCircle2, ChevronRight, CircleAlert,
  Clock3, Copy, ExternalLink, Fingerprint, Languages, LogOut, Mail, RefreshCw, ShieldCheck, Smartphone, TriangleAlert, UserRoundCheck, X
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { betaGuidance, betaJourneyCopy, guidanceLanguages, stationGuidanceLanguage } from "../lib/beta-guidance";
import { useBetaGuidanceLanguage } from "./connect-beta-journey-shell";
import { ConnectBetaVerification } from "./connect-beta-verification";
import type { BetaInboxAction } from "../lib/beta-verification";
import { betaExitNotice, betaExitNoticeVersion } from "../lib/beta-exit-notice";
import { betaJourney } from "../lib/beta-journey";
import compact from "./connect-beta-status.module.css";
import type { AppAccount } from "./connect-profile-app";
import { ConnectBetaAmazonOtp } from "./connect-beta-amazon-otp";
import { ConnectBetaFlexGuide, ConnectBetaFlexJourney } from "./connect-beta-flex-guide";
import { BetaPersonalGuide } from "./connect-beta-personal-guide";
import { ConnectBetaUan } from "./connect-beta-uan";
import { betaNextStepsCopy } from "../lib/beta-next-steps-copy";
import type { BetaUanProgress } from "../lib/beta-uan";
import guideStyles from "./connect-beta-flex-guide.module.css";
import { betaFlexGuide, betaFlexGuideEnabled } from "../lib/beta-flex-guide";

import { betaMilestones, type BetaStage as Stage, type CheckState } from "../lib/beta-onboarding-progress";
type BgcCheck = { code:string;label:string;status:CheckState;notRequested?:boolean;detail:string;owner:string;source:string;updatedAt:string|null;actionUrl?:string|null };
type ExitReason = { id:string;label:string;description?:string;requires_note:boolean };
export type BetaOnboardingData = {
  registeredMobile?:string|null;stationState?:string|null;available:boolean;pilot?:boolean;isolatedBeta?:boolean;stage:string;stageLabel:string;instruction?:string;actionOwner?:string;
  driverId?:string|null;biometricId?:string|null;amazonAccountId?:string|null;invitationEmail?:string|null;
  invitationUrl?:string|null;invitationAvailable?:boolean;invitationReceivedAt?:string|null;
  invitationStatus?:string|null;registrationReady?:boolean;registrationRequired?:boolean;registrationStatus?:string|null;registrationUpdatedAt?:string|null;
  continuationStatus?:"pending"|"continuing"|"not_continuing";continuationDecidedAt?:string|null;
  offboardingRequested?:boolean;offboardingRequestedAt?:string|null;offboardingStatus?:string|null;exitReasons?:ExitReason[];category?:string;amazonAction?:string;
  reportDate?:string|null;reportUpdatedAt?:string|null;updatedAt?:string|null;stale?:boolean;syncDelayed?:boolean;
  sourceStatus?:{amazonUpdatedAt:string|null;idfyUpdatedAt:string|null;lastAttemptAt:string|null;unavailable:boolean;delayed:boolean};invitationAccepted?:boolean;videoVerificationComplete?:boolean;amazonRegistrationStarted?:boolean;bgcSubmitted?:boolean;amazonRegistrationConfirmed?:boolean;accountSetupConfirmed?:boolean;verificationClosed?:boolean;uanStatus?:string|null;uan?:BetaUanProgress;uanLinks?:BetaInboxAction[];inboxActions?:BetaInboxAction[]; bgcStatus?:string|null; idfyProfileId?:string|null; operationalStatus?:string|null;
  verificationCases?:Array<{id:string;check_code:string;kind:string;label:string;reason:string;status:string;notified_at:string|null;failure_notified_at:string|null;response_at:string|null;mail_status:string;mail_sent_at:string|null}>;
  learning?:{status:string;dueAt:string|null;overdue:boolean;confirmedAt:string|null;bgcSubmitted:boolean};learningPassword?:string|null;
  bgcChecks?:BgcCheck[];latestAttendance?:{date:string;inTime:string|null;outTime:string|null;status:string|null;updatedAt:string|null}|null;
};
type Data = BetaOnboardingData;

const stateLabel:Record<CheckState,string>={complete:"Complete",action:"Action needed",in_progress:"In progress",pending:"Upcoming"};
const inbox=(email?:string|null)=>{const domain=String(email??"").split("@")[1]?.toLowerCase();if(domain?.includes("gmail"))return "https://mail.google.com/";if(domain?.includes("outlook")||domain?.includes("hotmail")||domain?.includes("live."))return "https://outlook.live.com/mail/";if(domain?.includes("yahoo"))return "https://mail.yahoo.com/";return null;};
const displayTime=(value?:string|null)=>value?new Intl.DateTimeFormat("en-IN",{day:"numeric",month:"short",hour:"numeric",minute:"2-digit",timeZone:"Asia/Kolkata"}).format(new Date(value)):"Not yet synced";


function StateBadge({state}:{state:CheckState}){return <span className={`dx-beta-state ${state}`}>{state==="complete"?<Check size={13}/>:state==="action"?<CircleAlert size={13}/>:<Clock3 size={13}/>} {stateLabel[state]}</span>;}
function Soc({children,updated}:{children:string;updated?:string|null}){return <p className="dx-beta-soc"><ShieldCheck size={13}/>Source of confirmation: {children}<span>{displayTime(updated)}</span></p>;}

export function ConnectBetaOnboarding({account,onRegister}:{account:AppAccount;onRegister:()=>void}){
  const [data,setData]=useState<Data|null>(null),[view,setView]=useState<Stage>("overview"),[loading,setLoading]=useState(true),[error,setError]=useState(""),[refreshing,setRefreshing]=useState(false),[refresh,setRefresh]=useState(0);
  const [useRegionalLanguage,setUseRegionalLanguage]=useBetaGuidanceLanguage();
  const [showAmazonGuide,setShowAmazonGuide]=useState(false);
  const [copied,setCopied]=useState<"email"|"link"|null>(null);
  const [exitOpen,setExitOpen]=useState(false),[reasonId,setReasonId]=useState(""),[exitNote,setExitNote]=useState(""),[exitError,setExitError]=useState(""),[exitSaving,setExitSaving]=useState(false),[decisionSaving,setDecisionSaving]=useState(false);
  const [exitAcknowledged,setExitAcknowledged]=useState(false);
  const exitFormRef=useRef<HTMLFormElement>(null);
  useEffect(()=>{
    if(!exitOpen)return;
    const previous=document.activeElement as HTMLElement|null;
    const originalOverflow=document.body.style.overflow;
    document.body.style.overflow="hidden";
    exitFormRef.current?.querySelector<HTMLElement>("select")?.focus();
    const keydown=(event:KeyboardEvent)=>{
      if(event.key==="Escape"&&!exitSaving){setExitOpen(false);return;}
      if(event.key!=="Tab")return;
      const controls=Array.from(exitFormRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input,select,textarea")??[]);
      const first=controls[0],last=controls[controls.length-1];
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    };
    document.addEventListener("keydown",keydown);
    return()=>{document.body.style.overflow=originalOverflow;document.removeEventListener("keydown",keydown);previous?.focus();};
  },[exitOpen,exitSaving]);
  const latest=useRef<Data|null>(null);
  const screenRef=useRef<HTMLElement>(null);
  const navigate=(stage:Stage)=>{setView(stage);requestAnimationFrame(()=>{screenRef.current?.scrollIntoView({block:"start"});screenRef.current?.focus({preventScroll:true});});};
  useEffect(()=>{let disposed=false;const controller=new AbortController();const timer=window.setTimeout(()=>controller.abort(),12000);const run=async()=>{setRefreshing(Boolean(latest.current));if(!latest.current)setLoading(true);try{const query=new URLSearchParams({accountId:account.id,profileType:account.profileType});const response=await fetch(`/api/connect/workforce-joining?${query}`,{cache:"no-store",signal:controller.signal});const payload=await response.json();if(!response.ok)throw new Error(payload.error||"Unable to load work setup.");if(!disposed){latest.current=payload;setData(payload);setError("");}}catch(reason){if(!disposed)setError(reason instanceof Error?reason.message:"Unable to load work setup.");}finally{window.clearTimeout(timer);if(!disposed){setLoading(false);setRefreshing(false);}}};void run();return()=>{disposed=true;controller.abort();window.clearTimeout(timer);};},[account.id,account.profileType,refresh]);
  useEffect(()=>{const timer=window.setInterval(()=>{if(document.visibilityState==="visible"&&navigator.onLine)setRefresh(value=>value+1);},30000);return()=>window.clearInterval(timer);},[]);

  const milestones=useMemo(()=>data?betaMilestones(data):[],[data]);
  const done=milestones.filter(item=>item.status==="complete").length;
  const next=milestones.find(item=>item.status==="action")??milestones.find(item=>item.status==="in_progress")??milestones.find(item=>item.status==="pending");
  const selected=view==="overview"?null:milestones.find(item=>item.id===view)??null;

  const submitExit=async(event:FormEvent)=>{event.preventDefault();setExitError("");const reason=data?.exitReasons?.find(item=>item.id===reasonId);if(!reason){setExitError("Choose why you are not continuing.");return;}if(reason.requires_note&&exitNote.trim().length<3){setExitError("Add a short note for this reason.");return;}if(!exitAcknowledged){setExitError("Read and acknowledge the training payout condition.");return;}setExitSaving(true);try{const response=await fetch("/api/connect/workforce-joining",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({accountId:account.id,profileType:account.profileType,action:"not_continuing",reasonId,note:exitNote.trim(),trainingPayoutAcknowledged:exitAcknowledged,trainingPayoutNoticeVersion:betaExitNoticeVersion})});const payload=await response.json();if(!response.ok)throw new Error(payload.error||"Unable to save your decision.");setExitOpen(false);setRefresh(value=>value+1);}catch(reason){setExitError(reason instanceof Error?reason.message:"Unable to save your decision.");}finally{setExitSaving(false);}};
  const continueRegistration=async()=>{setDecisionSaving(true);setError("");try{const response=await fetch("/api/connect/workforce-joining",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({accountId:account.id,profileType:account.profileType,action:"continue_amazon"})});const payload=await response.json();if(!response.ok)throw new Error(payload.error||"Unable to save your decision.");setRefresh(value=>value+1);onRegister();}catch(reason){setError(reason instanceof Error?reason.message:"Unable to save your decision.");}finally{setDecisionSaving(false);}};
  const copyValue=async(kind:"email"|"link",value:string)=>{try{await navigator.clipboard.writeText(value);setCopied(kind);window.setTimeout(()=>setCopied(current=>current===kind?null:current),1800);}catch{setError("Copy was blocked by the browser. Press and hold the value to copy it.");}};

  if(loading&&!data)return <section className="dx-main dx-beta-onboarding"><div className="dx-beta-loading" role="status"><span className="mini-spin"/>Loading your work setup…</div></section>;
  if(!data)return <section className="dx-main dx-beta-onboarding"><div className="dx-alert error">{error||"Work setup is unavailable."}<button onClick={()=>setRefresh(value=>value+1)}>Retry</button></div></section>;

  const journey=betaJourney({continuationStatus:data.verificationClosed?"not_continuing":data.continuationStatus,registrationStatus:data.registrationStatus});
  const workEmail=data.invitationEmail||account.email||"";
  const mailHref=inbox(workEmail);
  const regionalLanguage=stationGuidanceLanguage(data.stationState);
  const language=useRegionalLanguage?regionalLanguage:"en";
  const flexGuideEnabled=betaFlexGuideEnabled(account,data.isolatedBeta);
  const copy=betaJourneyCopy[language];
  const nextCopy=betaNextStepsCopy[language];
  const uanLinks=data.uanLinks??data.inboxActions??[];
  const guideContext={email:workEmail,driverId:data.driverId,learningPassword:data.learningPassword,uanAssistedUrl:uanLinks.find(a=>a.kind==="assisted")?.url,uanSubmitUrl:uanLinks.find(a=>a.kind==="uan")?.url};
  const inboxHref=`/beta-inbox?${new URLSearchParams({id:account.id,account:`${account.profileType}:${account.companyId}:${account.id}`})}`;
  const regionalLabel=guidanceLanguages.find(item=>item.code===regionalLanguage)?.label;
  const guideStage=view==="overview"?(next?.id??"attendance"):view;
  const guidance=!(flexGuideEnabled&&view==="amazon"&&journey.invitationUnlocked)&&["attendance","registration","amazon"].includes(guideStage)?betaGuidance[language][guideStage as "attendance"|"registration"|"amazon"]:null;
  const renderDetail=()=>{
    if(data.verificationClosed&&view!=="bgc")return <div className="dx-beta-empty"><ShieldCheck/><strong>Your onboarding has closed</strong><span>Amazon reports this profile as offboarded. Contact your team leader for help, or review your background-check history.</span><button className="dx-beta-primary" onClick={()=>navigate("bgc")}>View verification history<ArrowRight/></button></div>;
    if(view==="attendance")return <>
      <div className="dx-beta-focus"><i><Fingerprint/></i><div><small>Your biometric enrolment ID</small><strong>{data.biometricId||"Ask your station team"}</strong><p>Ask your station team to enrol this ID on the device. Punch IN when you arrive and OUT when you leave, every day.</p></div></div>
      <div className="dx-beta-punches"><div className={data.latestAttendance?.inTime?"done":""}><span>Latest IN punch</span><strong>{data.latestAttendance?.inTime?"Confirmed":"Not received yet"}</strong></div><div className={data.latestAttendance?.outTime?"done":""}><span>Latest OUT punch</span><strong>{data.latestAttendance?.outTime?"Confirmed":"Not received yet"}</strong></div></div>
      <div className="dx-beta-focus dx-beta-buddy" lang={language}><i><UserRoundCheck/></i><div><small>{copy.buddyLabel}</small><strong>{copy.buddyTitle}</strong><p>{copy.buddyBody}</p></div></div>
      {journey.stopped?null:journey.ready?<button className="dx-beta-primary" onClick={onRegister}>{journey.registered?"View DropX registration":"Continue to registration"}<ArrowRight/></button>:<button className="dx-beta-primary" disabled={decisionSaving} onClick={()=>void continueRegistration()}>{decisionSaving?"Saving…":"Continue to registration"}<ArrowRight/></button>}
      <Soc updated={data.continuationDecidedAt??data.latestAttendance?.updatedAt}>Station biometric punches and your readiness confirmation</Soc>
    </>;
    if(view==="registration")return <>
      <div className="dx-beta-focus"><i><UserRoundCheck/></i><div><small>DropX registration</small><strong>{journey.registered?"Registration submitted":journey.ready?"Complete your details":"Start with your station buddy"}</strong><p>{journey.ready?"Use your name exactly as shown on your driving licence and PAN card. If the names differ, ask your station team before submitting.":"Enrol your biometric ID and learn the role with your buddy. Continue here when you are ready."}</p></div></div>
      {journey.stopped?null:!journey.ready?<button className="dx-beta-primary" onClick={()=>navigate("attendance")}>Open first milestone<ArrowRight/></button>:data.registrationRequired?<button className="dx-beta-primary" type="button" onClick={onRegister}>Complete registration <ArrowRight size={16}/></button>:<div className="dx-beta-success"><CheckCircle2/>Registration submitted. Continue to Amazon registration.</div>}
      {journey.registered?<button className="dx-beta-primary" onClick={()=>navigate("amazon")}>Continue to Amazon registration<ArrowRight/></button>:null}
      <Soc updated={data.registrationUpdatedAt}>DropX registration and Workforce confirmation</Soc>
    </>;
    if(view==="amazon"&&data.isolatedBeta&&data.amazonRegistrationConfirmed&&!showAmazonGuide)return <div className={compact.confirmed}><CheckCircle2/><h2>Amazon registration complete</h2><p>Your submitted details are confirmed by Amazon. Continue with the remaining steps below.</p><div className={compact.actions}><button className="dx-beta-primary" onClick={()=>navigate("account")}>e-Shram UAN<ArrowRight size={16}/></button><button className="dx-beta-primary" onClick={()=>navigate("activation")}>Open training<ArrowRight size={16}/></button></div><button className={compact.guideToggle} onClick={()=>setShowAmazonGuide(true)}>View registration guide</button><Soc updated={data.sourceStatus?.amazonUpdatedAt}>Amazon LSC</Soc></div>;
    if(view==="amazon"&&flexGuideEnabled&&journey.invitationUnlocked)return <ConnectBetaFlexJourney key={`${account.companyId}:${account.id}`} accountId={account.id} companyId={account.companyId} language={language} email={workEmail} invitationUrl={data.invitationUrl??null} driverId={data.driverId} learningPassword={data.learningPassword} invitationAccepted={data.invitationAccepted}/>;
    if(view==="amazon")return <>
      {workEmail?<div className="dx-beta-email"><Mail/><span><small>Amazon Flex sign-in email</small><strong>{workEmail}</strong></span><button aria-label="Copy Amazon Flex sign-in email" onClick={()=>void copyValue("email",workEmail)}><Copy/>{copied==="email"?"Email copied":"Copy email"}</button></div>:null}
      {!journey.invitationUnlocked?<div className="dx-beta-empty"><UserRoundCheck/><strong>{journey.stopped?"Your station team will follow up":!journey.ready?"Start with biometric enrolment and buddy training":"Complete DropX registration first"}</strong><span>Your Amazon invitation is monitored from day one. The link is available after DropX registration.</span>{!journey.stopped?<button className="dx-beta-primary" onClick={()=>journey.ready?onRegister():navigate("attendance")}>{journey.ready?"Complete registration":"Open first milestone"}<ArrowRight/></button>:null}</div>:data.invitationUrl?<>
        <div className="dx-beta-invite-ready"><CheckCircle2/><span><strong>Your Amazon invitation is ready</strong><small>Received {displayTime(data.invitationReceivedAt)}</small></span></div>
        <div className="dx-beta-browser-safety"><TriangleAlert/><span><strong>Use the correct Amazon account</strong><small>Sign out of any Amazon account already open, or copy the link and paste it into a private/incognito window. “Open invitation” uses your normal browser.</small></span></div>
        <div className="dx-beta-action-row"><button type="button" className="dx-beta-primary" onClick={()=>void copyValue("link",data.invitationUrl!)}><Copy/>{copied==="link"?"Link copied":"Copy link"}</button><a className="dx-beta-primary" href={data.invitationUrl} target="_blank" rel="noopener noreferrer"><ExternalLink/>Open invitation</a></div>
        <details className="dx-beta-link-value"><summary>Show invitation link</summary><p>{data.invitationUrl}</p></details>
      </>:<div className="dx-beta-empty"><Clock3/><strong>Waiting for the invitation link</strong><span>DropX monitors your sign-in address. You do not need mailbox access. Refresh here when the invitation arrives.</span></div>}
      {data.isolatedBeta && journey.invitationUnlocked ? <ConnectBetaAmazonOtp key={`${account.companyId}:${account.id}`} accountId={account.id} companyId={account.companyId} language={language}/> : null}
      <div className="dx-beta-browser-safety"><ShieldCheck/><span><strong>Your password stays with you</strong><small>DropX does not create, read or store your Amazon password.</small></span></div>
      <a className="dx-beta-store-link" href="https://play.google.com/store/apps/details?id=com.amazon.flex.rabbit" target="_blank" rel="noopener noreferrer"><Smartphone/>Get Amazon Flex on Google Play <ArrowRight/></a>
      {!data.isolatedBeta&&mailHref?<a className="dx-beta-secondary-link" href={mailHref} target="_blank" rel="noreferrer">Open email inbox</a>:null}
      <Soc updated={data.invitationReceivedAt??data.updatedAt}>DropX monitored inbox and Amazon invitation queue</Soc>
    </>;
    if(view==="bgc"&&flexGuideEnabled)return <ConnectBetaVerification account={account} data={data} language={language} onRefresh={()=>setRefresh(value=>value+1)}/>;
    if(view==="bgc")return <>{data.bgcChecks?.length?<div className="dx-beta-checks">{data.bgcChecks.map(item=><article key={item.code}><i className={item.status}>{item.status==="complete"?<Check/>:item.status==="action"?<CircleAlert/>:<Clock3/>}</i><span><strong>{item.label}</strong><small>{item.detail}</small><em>Owner: {item.owner}</em>{item.actionUrl?<a className="dx-beta-secondary-link" href={item.actionUrl} target="_blank" rel="noopener noreferrer">Open IDfy action <ExternalLink size={14}/></a>:null}</span><StateBadge state={item.status}/></article>)}</div>:<div className="dx-beta-empty"><ShieldCheck/><strong>No IDfy action received</strong><span>DropX is monitoring the sign-in address. A safe IDfy link will appear here when received.</span></div>}<Soc updated={data.reportUpdatedAt}>DropX monitored inbox and IDfy worker; DA In-App onboarding as fallback</Soc></>;
    if(view==="account"&&flexGuideEnabled)return <ConnectBetaUan language={language} progress={data.uan} assistedUrl={guideContext.uanAssistedUrl} submitUrl={guideContext.uanSubmitUrl} inboxHref={inboxHref} accountId={account.id} profileType={account.profileType} onRefresh={()=>setRefresh(v=>v+1)}/>;
    if(view==="setup"&&flexGuideEnabled)return <div className={compact.confirmed} lang={language}>{data.accountSetupConfirmed?<CheckCircle2/>:<Clock3/>}<h2>{data.accountSetupConfirmed?nextCopy.setupComplete:nextCopy.setupPending}</h2>{!data.accountSetupConfirmed?<p>{nextCopy.setupBody}</p>:null}<Soc updated={data.sourceStatus?.amazonUpdatedAt}>Amazon LSC · Account Setup</Soc></div>;
    if(view==="activation"&&flexGuideEnabled)return <section lang={language}><div className={guideStyles.uanStatus} data-complete={data.learning?.status==="complete"}>{data.learning?.status==="complete"?<CheckCircle2/>:<Clock3/>}<div><h2>{data.learning?.status==="complete"?nextCopy.trainingComplete:nextCopy.trainingPending}</h2>{data.learning?.status!=="complete"?<p>{nextCopy.trainingBody}</p>:null}</div></div>{data.learning?.status!=="complete"?<><BetaPersonalGuide step="learning" language={language} context={guideContext}/><a className={guideStyles.download} href="https://play.google.com/store/apps/details?id=com.disprz.amazon" target="_blank" rel="noopener noreferrer"><Smartphone size={17}/>{betaFlexGuide[language].learningDownload}<ExternalLink size={15}/></a><p className={guideStyles.uanSms}>{nextCopy.courseHelp}</p><details className={guideStyles.help}><summary>{nextCopy.screens}</summary><figure className={guideStyles.courseExample}><a href="/guide/lm-learning-home.png" target="_blank" rel="noopener noreferrer"><img src="/guide/lm-learning-home.png" alt="LM Learning home after sign-in, with Notifications and My Courses" loading="lazy"/></a><figcaption><strong>My Courses → New Hiring</strong><p>{nextCopy.learningSteps[1]}</p></figcaption></figure></details></>:null}<Soc updated={data.learning?.confirmedAt??data.sourceStatus?.amazonUpdatedAt}>Amazon LSC · Videos/Training</Soc></section>;
    if(view==="account")return <><div className="dx-beta-focus"><i><BadgeCheck/></i><div><small>Amazon account setup</small><strong>{["scc_pending","scc_available","delivery_started"].includes(data.stage)?"Provisioning complete":"Setup in progress"}</strong><p>Complete your UAN details when Amazon asks. Your account status updates here.</p></div></div><div className="dx-beta-checks"><article><i className="in_progress"><Clock3/></i><span><strong>UAN update</strong><small>Complete or confirm UAN when Amazon requests it.</small><em>Owner: Associate / Amazon</em></span><StateBadge state={data.stage==="scc_pending"||data.driverId?"complete":"in_progress"}/></article><article><i className="in_progress"><Clock3/></i><span><strong>Account provisioning</strong><small>{data.amazonAction||data.instruction||"Amazon is processing the operational account."}</small><em>Owner: Amazon</em></span><StateBadge state={data.driverId?"complete":"in_progress"}/></article></div><Soc updated={data.reportUpdatedAt}>Amazon LSC profile; DA In-App onboarding fallback</Soc></>;
    return <>{data.learning?<div className="dx-beta-focus"><i><Clock3/></i><div><small>LM Learning · complete within 48 hours</small><strong>{data.learning.status==="complete"?"Training confirmed":data.learning.overdue?"Training overdue":data.learning.dueAt?`Due ${displayTime(data.learning.dueAt)}`:data.learning.status==="action"?"Complete your LM Learning course":"Waiting for Amazon training status"}</strong><p>{data.learning.bgcSubmitted?"BGC details received. Complete every assigned module and assessment.":"Submit your BGC details, then complete your assigned LM Learning course."} Training is confirmed only after Amazon reports completion.</p></div></div>:null}<div className="dx-beta-focus"><i><BadgeCheck/></i><div><small>LSC Driver ID</small><strong>{data.driverId||"Waiting for Amazon LSC"}</strong><p>{data.driverId?"This is your operational Driver ID. Your biometric ID remains attendance-only.":"Amazon will issue your Driver ID after setup is complete. It will appear here automatically."}</p></div></div><div className="dx-beta-checks"><article><i className={data.driverId?"complete":"pending"}>{data.driverId?<Check/>:<Clock3/>}</i><span><strong>Driver ID received</strong><small>{data.driverId?"Exact LSC identity connected.":"Waiting for exact LSC evidence."}</small><em>Owner: Amazon / station team</em></span><StateBadge state={data.driverId?"complete":"pending"}/></article><article><i className={data.stage==="delivery_started"?"complete":"pending"}>{data.stage==="delivery_started"?<Check/>:<Clock3/>}</i><span><strong>First delivery confirmed</strong><small>Confirmed only from Amazon daily shipment count.</small><em>Owner: System</em></span><StateBadge state={data.stage==="delivery_started"?"complete":"pending"}/></article></div><Soc updated={data.updatedAt}>Amazon LSC / SCC and Amazon daily shipment count</Soc></>;
  };

  const languageControl=regionalLanguage!=="en"?<button className="dx-beta-language-switch" type="button" aria-controls={guidance?"beta-guidance-content":undefined} onClick={()=>setUseRegionalLanguage(value=>!value)}><Languages size={17}/>{language==="en"?<span lang={regionalLanguage}>{regionalLabel}</span>:"English"}<span className="sr-only">{language==="en"?"Switch guidance language":"Read in English"}</span></button>:null;
  const guidanceCard=guidance?<section className="dx-beta-language" aria-labelledby="beta-guidance-title"><div className="dx-beta-language-header"><h2 id="beta-guidance-title" lang={language}>{copy.guidanceTitle}</h2></div><ol id="beta-guidance-content" lang={language}>{guidance.map((line,index)=><li key={line}><b aria-hidden="true">{index+1}</b><span>{line}</span></li>)}</ol></section>:null;
  return <section className={`dx-main dx-beta-onboarding ${data.isolatedBeta?compact.page:""}`} ref={screenRef} tabIndex={-1}>
    <div className="dx-beta-toolbar">{view!=="overview"?<button className="dx-beta-back" onClick={()=>navigate("overview")}><ArrowLeft size={17}/>Your journey</button>:<span className="dx-beta-private"><span/>Private beta</span>}<div>{languageControl}<button className="dx-beta-refresh" aria-label="Refresh work setup" disabled={refreshing} onClick={()=>setRefresh(value=>value+1)}><RefreshCw size={17} className={refreshing?"dx-spin":""}/></button></div></div>
    <header className="dx-beta-heading"><div>{view!=="overview"?<small>STEP {milestones.findIndex(item=>item.id===view)+1} OF {milestones.length}</small>:null}<h1>{view==="overview"?"Your work setup":selected?.label}</h1><p>{view==="overview"?"Your progress, your next action — in one place.":selected?.detail}</p></div></header>
    {error?<div className="dx-joining-error" role="alert"><strong>Status refresh paused</strong><span>{error}</span></div>:null}
    {data.verificationClosed?<div className="dx-setup-stopped"><ShieldCheck/><div><strong>Your onboarding has closed</strong><span>Amazon reports this profile as offboarded. Your team leader can help you review the outcome.</span></div></div>:null}
    {data.offboardingRequested?<div className="dx-setup-stopped"><LogOut/><div><strong>You told us you are not continuing</strong><span>{data.offboardingStatus==="manual_review"?"Workforce will verify the exact Amazon profile before any offboarding action.":"Your request is queued against this exact beta profile."}</span></div></div>:null}
    {view==="overview"?<>
      <div className={compact.identity}>
        <div><small>Amazon Driver ID</small><strong>{data.driverId||"Awaiting Amazon sync"}</strong>{data.driverId?<button aria-label="Copy Driver ID" onClick={()=>void navigator.clipboard.writeText(data.driverId!).catch(()=>setError("Press and hold your Driver ID to copy it."))}><Copy size={16}/></button>:null}</div>
        <div><small>Biometric · attendance only</small><strong>{data.biometricId||"Pending"}</strong></div>
        <div className={compact.email}><small>Amazon Flex sign-in email</small><strong>{workEmail||"Waiting for invitation"}</strong><button aria-label="Copy email" onClick={()=>void copyValue("email",workEmail)}><Copy size={16}/>{copied==="email"?"Copied":"Copy"}</button></div>
      </div>
      <div className={compact.statusLine}><span><i/>Refreshes automatically</span><span>Amazon: {displayTime(data.sourceStatus?.amazonUpdatedAt)} · IDfy: {displayTime(data.sourceStatus?.idfyUpdatedAt)}</span></div>
      {data.sourceStatus?.unavailable?<div className="dx-joining-error" role="status">Status sync is temporarily unavailable. Your completed work is retained in Amazon and IDfy; contact your team leader if you need help.</div>:data.sourceStatus?.delayed?<p className={compact.syncNotice}>Some source updates are delayed. Showing the last confirmed progress.</p>:null}
      <div className={compact.overview}>
        <section className={compact.todo}><header><small>UP NEXT</small><span>{done} / {milestones.length} complete</span></header><h2>{data.verificationClosed?"Speak with your team leader":next?.label||"You’re all set"}</h2><p>{data.verificationClosed?"Your team leader can help you review your onboarding.":next?.detail}</p>{next&&!data.verificationClosed?<button className="dx-beta-primary" onClick={()=>navigate(next.id)}>Continue<ArrowRight size={18}/></button>:null}
        {milestones.filter(m=>m.status==="action"&&m.id!==next?.id).map(m=><button key={m.id} className={compact.alsoPending} onClick={()=>navigate(m.id)}><span>{m.label}<small>Also needs your action</small></span><ArrowRight size={17}/></button>)}
        </section>
        <section className={compact.steps}><header><h2>Progress tracker</h2><span>{done} complete</span></header>{milestones.map((item,index)=><button key={item.id} onClick={()=>navigate(item.id)}><i data-state={item.status}>{item.status==="complete"?<Check size={17}/>:index+1}</i><span><strong>{item.label}</strong><small>{item.status==="complete"?"Completed":item.detail}</small></span><StateBadge state={item.status}/><ChevronRight size={16}/></button>)}</section>
      </div>
      {guidanceCard}

    </>:<>
      <nav className="dx-beta-stage-nav" aria-label="Work setup milestones">{milestones.map((item,index)=><button aria-label={`Step ${index+1}: ${item.label}`} aria-current={view===item.id?"step":undefined} className={`${item.status}${view===item.id?" active":""}`} key={item.id} onClick={()=>navigate(item.id)}><b>{item.status==="complete"?<Check size={15}/>:index+1}</b><span>{item.label}</span></button>)}</nav>
      <section className="dx-beta-card dx-beta-detail">{renderDetail()}</section>

      {guidanceCard}
    </>}
    {!data.offboardingRequested&&!data.verificationClosed?<section className="dx-beta-support" lang={language} aria-labelledby="beta-support-title"><div><h2 id="beta-support-title">{copy.helpTitle}</h2><p>{copy.helpBody}</p></div><button type="button" onClick={()=>{setExitAcknowledged(false);setExitError("");setExitOpen(true);}}>{copy.leaveAction}<ArrowRight size={18}/></button></section>:null}
    {exitOpen?<div className="dx-exit-dialog" role="dialog" aria-modal="true" aria-labelledby="beta-exit-title"><button className="dx-exit-close" type="button" aria-label="Close" onClick={()=>setExitOpen(false)}><X/></button><form onSubmit={submitExit} ref={exitFormRef}><small>LEAVE ONBOARDING</small><h3 id="beta-exit-title" lang={language}>{copy.leaveTitle}</h3><p lang={language}>{copy.leaveBody}</p><label>Reason<select required value={reasonId} onChange={event=>setReasonId(event.target.value)}><option value="">Choose a reason</option>{data.exitReasons?.map(reason=><option value={reason.id} key={reason.id}>{reason.label}</option>)}</select></label><label>Additional detail <span>optional unless requested</span><textarea value={exitNote} maxLength={700} onChange={event=>setExitNote(event.target.value)}/></label><aside className="dx-beta-exit-policy" lang={language}><strong>{betaExitNotice[language].title}</strong><p>{betaExitNotice[language].body}</p></aside><label className="dx-beta-exit-ack" lang={language}><input type="checkbox" required checked={exitAcknowledged} onChange={event=>setExitAcknowledged(event.target.checked)}/><span>{betaExitNotice[language].acknowledgement}</span></label>{exitError?<div className="dx-joining-error" role="alert">{exitError}</div>:null}<footer><button type="button" onClick={()=>setExitOpen(false)}>Go back</button><button className="danger" disabled={exitSaving||!data.exitReasons?.length||!exitAcknowledged}>{exitSaving?"Saving…":"Confirm change of plans"}</button></footer></form></div>:null}
  </section>;
}
