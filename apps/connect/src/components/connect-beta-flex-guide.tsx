"use client";

import { ArrowLeft, ArrowRight, BookOpen, ChevronDown, Copy, ExternalLink, Info, Mail, ShieldCheck, Smartphone } from "lucide-react";
import { useId, useRef, useState } from "react";
import { betaFlexGuide, flexGuideSteps, flexInvitationWaiting, type FlexGuideStep } from "../lib/beta-flex-guide";
import type { GuidanceLanguage } from "../lib/beta-guidance";
import { ConnectBetaAmazonOtp } from "./connect-beta-amazon-otp";
import { ConnectBetaFlexScreens } from "./connect-beta-flex-screens";
import { BetaPersonalGuide } from "./connect-beta-personal-guide";
import type { PersonalGuideContext } from "../lib/beta-personal-guide";
import styles from "./connect-beta-flex-guide.module.css";
import { betaNextStepsCopy } from "../lib/beta-next-steps-copy";

export function ConnectBetaFlexGuide({ language, initialStep = "signin", onInvitation, context = {} }: {
  language: GuidanceLanguage; initialStep?: FlexGuideStep; onInvitation?: () => void; context?: PersonalGuideContext;
}) {
  const [step, setStep] = useState<FlexGuideStep>(initialStep);
  const copy = betaFlexGuide[language], item = copy.steps[step];
  const index = flexGuideSteps.findIndex(item => item.id === step), meta = flexGuideSteps[index];
  const titleId = useId(), selectId = useId();
  const stepTitle = (id: FlexGuideStep) => id === "uan" && context.uanVerified ? betaNextStepsCopy[language].verified : copy.steps[id].title;
  const panel = useRef<HTMLElement>(null);
  const open = (value: FlexGuideStep) => {
    setStep(value);
    requestAnimationFrame(() => { panel.current?.scrollIntoView({ block: "nearest" }); panel.current?.focus({ preventScroll: true }); });
  };
  return <section className={styles.guide} lang={language} aria-labelledby={titleId}>
    <header className={styles.guideHeader}><span><BookOpen size={19}/>{copy.guide}</span><span>{index + 1} / {flexGuideSteps.length}</span></header>
    <div className={styles.layout}>
      <nav className={styles.desktopNav} aria-label={copy.choose}>{flexGuideSteps.map((entry, i) => <button key={entry.id} type="button" aria-current={step === entry.id ? "step" : undefined} onClick={() => open(entry.id)}><b>{i + 1}</b><span>{stepTitle(entry.id)}</span></button>)}</nav>
      <div className={styles.mobileSelect}><label htmlFor={selectId}>{copy.choose}</label><select id={selectId} value={step} onChange={event => open(event.target.value as FlexGuideStep)}>{flexGuideSteps.map((entry, i) => <option key={entry.id} value={entry.id}>{i + 1}. {stepTitle(entry.id)}</option>)}</select></div>
      <article className={styles.panel} ref={panel} tabIndex={-1} aria-labelledby={titleId}>
        <div className={styles.stepTitle}><span className={styles.stepNumber}>{index + 1}</span><div><small>{copy.step} {index + 1}</small><h2 id={titleId}>{stepTitle(step)}</h2></div></div>
        <div className={styles.screen}><Smartphone size={18}/><span><small>{copy.screen}</small><strong lang="en">{meta.screen}</strong></span></div>
        <BetaPersonalGuide step={step} language={language} context={context}/>
        {!["learning","uan"].includes(step)?<ol className={styles.instructions}>{item.actions.map((line,i)=><li key={i}>{line}</li>)}</ol>:null}
        <details className={styles.help} key={`screens-${step}`}><summary>{betaNextStepsCopy[language].screens}<ChevronDown size={16}/></summary><ConnectBetaFlexScreens step={step} language={language} title={item.title} context={context}/></details>
        {step === "signin" || step === "learning" ? <a className={styles.download} href={step === "signin" ? "https://play.google.com/store/apps/details?id=com.amazon.flex.rabbit" : "https://play.google.com/store/apps/details?id=com.disprz.amazon"} target="_blank" rel="noopener noreferrer"><Smartphone size={17}/>{step === "signin" ? copy.flexDownload : copy.learningDownload}<ExternalLink size={15}/></a> : null}
        {!(step==="uan"&&context.uanVerified)?<div className={styles.expect}><Info size={18}/><div><strong>{copy.expect}</strong><p>{item.expect}</p></div></div>:null}
        <details className={styles.help} key={step}><summary>{copy.help}<ChevronDown size={16}/></summary><p>{item.help}</p></details>
        <footer className={styles.controls}><button type="button" disabled={index === 0} onClick={() => open(flexGuideSteps[index - 1].id)}><ArrowLeft size={17}/>{copy.back}</button>{index < flexGuideSteps.length - 1 ? <button className={styles.primary} type="button" onClick={() => open(flexGuideSteps[index + 1].id)}>{copy.next}<ArrowRight size={17}/></button> : onInvitation ? <button className={styles.primary} type="button" onClick={onInvitation}>{copy.finish}<ArrowRight size={17}/></button> : null}</footer>
        <small className={styles.source}>{copy.source}: {meta.source === "amazon" ? copy.amazonSource : copy.dropxSource} · {copy.pages} {meta.pages}</small>
      </article>
    </div>
    <p className={styles.evidence}><ShieldCheck size={16}/>{copy.evidence}</p>
  </section>;
}

export function ConnectBetaFlexJourney({ accountId, companyId, language, email, invitationUrl, driverId, learningPassword, guideContext, invitationAccepted = false }: {
  accountId: string; companyId: string; language: GuidanceLanguage; email: string; invitationUrl: string | null; driverId?:string|null; learningPassword?:string|null; guideContext?:PersonalGuideContext; invitationAccepted?:boolean;
}) {
  const [view, setView] = useState<"invitation" | "guide">(invitationAccepted?"guide":"invitation");
  const [copied, setCopied] = useState<"email" | "link" | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const top = useRef<HTMLDivElement>(null), titleId = useId();
  const copy = betaFlexGuide[language];
  const changeView = (value: "invitation" | "guide") => { setView(value); requestAnimationFrame(() => { top.current?.scrollIntoView({ block: "start" }); top.current?.focus({ preventScroll: true }); }); };
  const copyValue = async (kind: "email" | "link", value: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(kind); setCopyFailed(false); window.setTimeout(() => setCopied(null), 2000); }
    catch { setCopyFailed(true); }
  };
  return <div className={styles.journey} lang={language} ref={top} tabIndex={-1}>
    {view==="invitation"?<div className={styles.email}><Mail size={20}/><div><small>{copy.email}</small><strong>{email}</strong></div><button type="button" onClick={() => void copyValue("email", email)}><Copy size={16}/>{copied === "email" ? copy.emailCopied : copy.copyEmail}</button></div>:null}
    {copyFailed ? <p role="alert" className={styles.copyFallback}>{copy.email}: <input aria-label={copy.email} readOnly value={email} onFocus={event => event.target.select()}/>{invitationUrl ? <><span>{copy.copyLink}</span><input aria-label={copy.copyLink} readOnly value={invitationUrl} onFocus={event => event.target.select()}/></> : null}</p> : null}
    <div className={styles.tabs} role="group" aria-label={copy.guide}><button type="button" aria-pressed={view === "invitation"} onClick={() => changeView("invitation")}>{copy.invitation}</button><button type="button" aria-pressed={view === "guide"} onClick={() => changeView("guide")}>{copy.guide}<ArrowRight size={16}/></button></div>
    {view === "invitation" ? <>
      <section className={styles.bridge} aria-labelledby={titleId}><i><Smartphone size={25}/></i><div><h2 id={titleId}>{copy.title}</h2><p>{copy.intro}</p><button type="button" onClick={() => changeView("guide")}>{copy.start}<ArrowRight size={18}/></button></div></section>
      <section className={styles.invitation}><h3>{invitationUrl ? copy.ready : copy.invitation}</h3><p>{invitationUrl ? copy.invitationBody : flexInvitationWaiting[language]}</p><aside><ShieldCheck size={18}/><div><strong>{copy.browserTitle}</strong><p>{copy.browserBody}</p></div></aside>{invitationUrl ? <div className={styles.actions}><button type="button" onClick={() => void copyValue("link", invitationUrl)}><Copy size={17}/>{copied === "link" ? copy.linkCopied : copy.copyLink}</button><a href={invitationUrl} target="_blank" rel="noopener noreferrer">{copy.openInvitation}<ExternalLink size={16}/></a></div> : null}</section>
      <ConnectBetaAmazonOtp accountId={accountId} companyId={companyId} language={language}/>
      <p className={styles.password}><ShieldCheck size={17}/><span><strong>{copy.password}</strong> {copy.passwordBody}</span></p>
    </> : <ConnectBetaFlexGuide language={language} context={{email,driverId,learningPassword,...guideContext}} onInvitation={() => changeView("invitation")}/>}
  </div>;
}
