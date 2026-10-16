"use client";
import {CheckCircle2,Clock3,ExternalLink,Mail,ShieldCheck,UserRound,Headphones,RefreshCw} from 'lucide-react';
import {useState} from 'react';
import type {GuidanceLanguage} from '../lib/beta-guidance';
import type {BetaUanProgress} from '../lib/beta-uan';
import {betaNextStepsCopy} from '../lib/beta-next-steps-copy';
import styles from './connect-beta-flex-guide.module.css';

export function BetaUanOptions({language,assistedUrl,submitUrl}:{language:GuidanceLanguage;assistedUrl?:string|null;submitUrl?:string|null}){
 const c=betaNextStepsCopy[language];
 return <div lang={language}>
  <div className={styles.uanOptions}>
   <section><b><UserRound size={17}/></b><h3>{c.selfTitle}</h3><p>{c.selfBody}</p><a className={styles.download} href="https://register.eshram.gov.in/#/user/platform-worker-registration" target="_blank" rel="noopener noreferrer">{c.selfCta}<ExternalLink size={16}/></a></section>
   <section><b><Headphones size={17}/></b><h3>{c.assistedTitle}</h3><p>{c.assistedBody}</p>{assistedUrl?<a className={styles.download} href={assistedUrl} target="_blank" rel="noopener noreferrer">{c.assistedCta}<ExternalLink size={16}/></a>:<small>{c.awaitLink}</small>}</section>
  </div>
  <p className={styles.uanSms}>{c.sms}</p>
  {submitUrl?<a className={styles.download} href={submitUrl} target="_blank" rel="noopener noreferrer">{c.submitCta}<ExternalLink size={16}/></a>:null}
 </div>;
}

export function ConnectBetaUan({language,progress,assistedUrl,submitUrl,inboxHref,accountId,profileType,onRefresh}:{language:GuidanceLanguage;progress?:BetaUanProgress;assistedUrl?:string|null;submitUrl?:string|null;inboxHref:string;accountId:string;profileType:string;onRefresh:()=>void}){
 const c=betaNextStepsCopy[language],status=progress?.status??'unknown';
 const [saving,setSaving]=useState(false),[error,setError]=useState('');
 const verified=status==='verified',submitted=status==='submitted';
 const report=async()=>{setSaving(true);setError('');try{const query=new URLSearchParams({accountId,profileType});const response=await fetch(`/api/connect/beta-uan?${query}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'submitted'})});if(!response.ok)throw new Error();onRefresh();}catch{setError(c.saveError);}finally{setSaving(false);}};
 const title=verified?c.verified:submitted?c.submitted:status==='action_required'?c.correction:status==='requested'?c.requested:c.unknown;
 const body=verified?c.verifiedBody:submitted?c.submittedBody:status==='action_required'?c.correctionBody:c.already;
 const options=<BetaUanOptions language={language} assistedUrl={assistedUrl} submitUrl={submitUrl}/>;
 return <section lang={language} className={styles.uanPanel}>
  <div className={styles.uanStatus} data-complete={verified}>{verified?<CheckCircle2/>:<Clock3/>}<div><h2>{title}</h2><p>{body}</p></div></div>
  {progress?.source?<p className={styles.confirmationSource}><ShieldCheck size={15}/>{c.source}: {progress.source==='You'?c.you:progress.source}{progress.updatedAt?<time dateTime={progress.updatedAt}>{new Intl.DateTimeFormat('en-IN',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit',timeZone:'Asia/Kolkata'}).format(new Date(progress.updatedAt))}</time>:null}</p>:null}
  {progress?.syncDelayed?<p role="status">{c.delayed}</p>:null}
  {verified||submitted||progress?.syncDelayed?<details className={styles.help}><summary>{c.options}</summary>{options}</details>:options}
  <div className={styles.actions}>{!verified&&!submitted?<button type="button" disabled={saving} onClick={()=>void report()}>{saving?c.saving:c.reportedCta}</button>:null}<a href={inboxHref}><Mail size={16}/>{c.viewMail}</a></div>
  {progress?.syncDelayed?<div className={styles.actions}><button type="button" onClick={onRefresh}><RefreshCw size={16}/>{c.retry}</button></div>:null}
  {error?<p role="alert">{error}</p>:null}
 </section>;
}
