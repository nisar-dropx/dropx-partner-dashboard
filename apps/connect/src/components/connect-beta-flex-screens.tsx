"use client";

import { ChevronLeft, ChevronRight, Expand, Images, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { GuidanceLanguage } from "../lib/beta-guidance";
import type { FlexGuideStep } from "../lib/beta-flex-guide";
import { flexScreenCopy, flexScreenExamples } from "../lib/beta-flex-screens";
import styles from "./connect-beta-flex-guide.module.css";

// The parent is mounted only inside the selected isolated beta journey.
// This viewer changes presentation state only; it never submits an Amazon task.
export function ConnectBetaFlexScreens({ step, language, title }: {
  step: FlexGuideStep; language: GuidanceLanguage; title: string;
}) {
  const [index, setIndex] = useState(0), [expanded, setExpanded] = useState(false);
  const examples = flexScreenExamples[step], id = examples[index], copy = flexScreenCopy[language];
  const dialog = useRef<HTMLDialogElement>(null), preview = useRef<HTMLButtonElement>(null);
  const titleId = useId(), dialogTitleId = useId(), noteId = useId();
  const src = `/guide/amazon-onboarding/${id}.png`;
  const alt = `${copy.screen}: ${title} (${index + 1}/${examples.length})`;

  useEffect(() => {
    if (!expanded) return;
    const element = dialog.current;
    if (!element) return;
    const previousOverflow = document.body.style.overflow;
    element.showModal();
    document.body.style.overflow = "hidden";
    return () => { element.close(); document.body.style.overflow = previousOverflow; };
  }, [expanded]);

  const close = () => { setExpanded(false); preview.current?.focus({ preventScroll: true }); };
  const navigation = () => examples.length > 1 ? <div className={styles.exampleNavigation}>
    <button type="button" aria-label={copy.previous} disabled={index === 0} onClick={() => setIndex(value => value - 1)}><ChevronLeft size={19}/></button>
    <span aria-live="polite">{copy.screen} {index + 1} / {examples.length}</span>
    <button type="button" aria-label={copy.next} disabled={index === examples.length - 1} onClick={() => setIndex(value => value + 1)}><ChevronRight size={19}/></button>
  </div> : null;
  const pointers = () => <ol className={styles.screenPointers} data-numbered={step !== "account"}>
    {copy.examples[id].map((line, i) => <li key={i}><span aria-hidden="true">{step === "account" ? "!" : i + 1}</span><p>{line}</p></li>)}
  </ol>;
  return <section className={styles.examples} aria-labelledby={titleId}>
    <header className={styles.examplesHeader}><h3 id={titleId}><Images size={18}/>{copy.title}</h3>{navigation()}</header>
    <div className={styles.exampleBody}>
      <button className={styles.screenPreview} type="button" ref={preview} aria-haspopup="dialog" aria-label={`${copy.enlarge}: ${title}`} onClick={() => setExpanded(true)}>
        <img src={src} alt={alt} loading="lazy" decoding="async"/>
        <span><Expand size={16}/>{copy.enlarge}</span>
      </button>
      <div className={styles.exampleNotes}>{pointers()}<p className={styles.exampleNotice}>{copy.note}</p></div>
    </div>
    <dialog ref={dialog} className={styles.screenDialog} aria-labelledby={dialogTitleId} aria-describedby={noteId} onClose={close} onClick={event => { if (event.target === dialog.current) close(); }}>
      <header><div><small>{copy.screen}</small><h3 id={dialogTitleId}>{title}</h3></div><button type="button" aria-label={copy.close} onClick={close}><X size={22}/></button></header>
      <div className={styles.dialogBody}>
        <div className={styles.fullScreen}><img src={src} alt={alt}/></div>
        <div className={styles.dialogNotes}>{navigation()}{pointers()}<p className={styles.exampleNotice} id={noteId}>{copy.note}</p></div>
      </div>
    </dialog>
  </section>;
}
