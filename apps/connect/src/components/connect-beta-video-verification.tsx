"use client";
import { useState } from 'react';
import { Video, ExternalLink, Copy, Check, MessageCircle } from 'lucide-react';
import type { BetaInboxAction } from '../lib/beta-verification';
import type { GuidanceLanguage } from '../lib/beta-guidance';
import { betaVideoGuidance } from '../lib/beta-video-guidance';
import { betaIdfyMessageExamples } from '../lib/beta-idfy-message-examples';
import styles from './connect-beta-verification.module.css';

export function ConnectBetaVideoVerification({action,language='en',mobile}:{action?:BetaInboxAction;language?:GuidanceLanguage;mobile?:string|null}) {
 const [copied,setCopied]=useState(false),[error,setError]=useState(false),[channel,setChannel]=useState<'sms'|'whatsapp'>('sms');
 const copy=betaVideoGuidance[language];
 const example=betaIdfyMessageExamples[language];
 return <section className={styles.video} lang={language} aria-labelledby="beta-video-title">
  <div className={styles.videoHeading}><i>{action?<Video/>:<MessageCircle/>}</i><div><small>{copy.title}</small><h2 id="beta-video-title">{action?copy.ready:copy.waiting}</h2></div></div>
  <p>{action?copy.instruction:copy.mobile}</p>
  {!action&&mobile?<strong className={styles.phone}>{mobile}</strong>:null}
  {action?<><div className={styles.videoActions}><a className={styles.primary} href={action.url} target="_blank" rel="noopener noreferrer">{copy.open}<ExternalLink size={18}/></a><button type="button" className={styles.copy} onClick={async()=>{try{await navigator.clipboard.writeText(action.url);setCopied(true);setError(false);}catch{setError(true);}}}>{copied?<Check size={17}/>:<Copy size={17}/>} {copied?copy.copied:copy.copy}</button></div><p className={styles.freshness} role="status">{error?copy.copyFailed:copy.received}</p></>:null}
  <details className={styles.messageExample}>
   <summary>{example.title}</summary>
   <header><div aria-label="Message format"><button type="button" aria-pressed={channel==='sms'} onClick={()=>setChannel('sms')}>SMS</button><button type="button" aria-pressed={channel==='whatsapp'} onClick={()=>setChannel('whatsapp')}>WhatsApp</button></div></header>
   <div className={styles.messageFrame} data-channel={channel}><strong>{channel==='sms'?'IDFYIN-S':'IDfy'}</strong><blockquote><p>{example.greeting}</p><p>{example.body}</p><span className={styles.exampleLink}>{example.link}</span><p>{example.address}</p><small>{example.hours}</small></blockquote></div>
   <p className={styles.freshness}>{example.note}</p>
  </details>
 </section>;
}
