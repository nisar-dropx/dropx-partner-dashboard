"use client";
import { Copy, ExternalLink, MapPin } from 'lucide-react';
import { useState } from 'react';
import type { GuidanceLanguage } from '../lib/beta-guidance';
import type { FlexGuideStep } from '../lib/beta-flex-guide';
import { personalGuideCopy, type PersonalGuideContext } from '../lib/beta-personal-guide';
import styles from './connect-beta-flex-guide.module.css';
export function BetaPersonalGuide({step,language,context,compact=false}:{step:FlexGuideStep;language:GuidanceLanguage;context:PersonalGuideContext;compact?:boolean}){
 const c=personalGuideCopy[language];const [copied,setCopied]=useState(false);
 const credential=(label:string,value?:string|null)=><div className={styles.personalCredential}><small>{label}</small><strong>{value||c.waiting}</strong>{value?<button type="button" aria-label={label} onClick={()=>void navigator.clipboard.writeText(value).then(()=>setCopied(true)).catch(()=>setCopied(false))}><Copy size={16}/>{copied?'✓':''}</button>:null}</div>;
 if(step==='signin')return credential(c.email,context.email);
 if(step==='about'||step==='bgc')return <aside className={styles.currentAddress}><MapPin size={20}/><p>{c.address}</p></aside>;
 if(step==='learning')return <section className={styles.personalGuide}><h3>{c.learning}</h3>{credential(c.driver,context.driverId)}{context.driverId?credential(c.password,context.learningPassword):null}{!compact?<ol>{c.learningSteps.map(s=><li key={s}>{s}</li>)}</ol>:null}</section>;
 if(step==='uan')return <section className={styles.personalGuide}><h3>{c.uan}</h3>{!compact?<><ol>{c.uanSteps.map(s=><li key={s}>{s}</li>)}</ol><a className={styles.download} href="https://register.eshram.gov.in/#/user/platform-worker-registration" target="_blank" rel="noopener noreferrer">e-Shram <ExternalLink size={16}/></a></>:null}</section>;
 return null;
}
