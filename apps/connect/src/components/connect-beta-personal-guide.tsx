"use client";
import { Copy, MapPin } from 'lucide-react';
import { useState } from 'react';
import type { GuidanceLanguage } from '../lib/beta-guidance';
import type { FlexGuideStep } from '../lib/beta-flex-guide';
import { personalGuideCopy, type PersonalGuideContext } from '../lib/beta-personal-guide';
import styles from './connect-beta-flex-guide.module.css';
import { betaNextStepsCopy } from '../lib/beta-next-steps-copy';
import { BetaUanOptions } from './connect-beta-uan';
export function BetaPersonalGuide({step,language,context,compact=false}:{step:FlexGuideStep;language:GuidanceLanguage;context:PersonalGuideContext;compact?:boolean}){
 const c=personalGuideCopy[language];const [copied,setCopied]=useState<string|null>(null);
 const credential=(label:string,value?:string|null)=><div className={styles.personalCredential}><small>{label}</small><strong>{value||c.waiting}</strong>{value?<button type="button" aria-label={label} onClick={()=>void navigator.clipboard.writeText(value).then(()=>{setCopied(label);window.setTimeout(()=>setCopied(null),2000);}).catch(()=>setCopied(null))}><Copy size={16}/>{copied===label?'✓':''}</button>:null}</div>;
 if(step==='signin')return credential(c.email,context.email);
 if(step==='about'||step==='bgc')return <aside className={styles.currentAddress}><MapPin size={20}/><p>{c.address}</p></aside>;
 if(step==='learning')return <section className={styles.personalGuide}>{credential(c.driver,context.driverId)}{context.driverId?credential(c.password,context.learningPassword):null}{!compact?<ol>{betaNextStepsCopy[language].learningSteps.map(s=><li key={s}>{s}</li>)}</ol>:null}</section>;
 if(step==='uan'&&context.uanVerified)return <p className={styles.uanSms}>{betaNextStepsCopy[language].verifiedBody}</p>;
 if(step==='uan')return compact?<h3>{c.uan}</h3>:<BetaUanOptions language={language} assistedUrl={context.uanAssistedUrl} submitUrl={context.uanSubmitUrl}/>;
 return null;
}
