"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ExternalLink, ImageOff, Loader2, X } from "lucide-react";
import s from "@/app/ops-pulse/report-bot/report-bot.module.css";

/** Modal photo viewer. Native <dialog>: focus trap, Escape and focus return come for free. */
export function ImageModal({ src, title, open, onClose }: { src: string; title: string; open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setState("loading");
      dialog.showModal();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={s.modal}
      aria-label={title}
      onClose={onClose}
      onClick={(event) => {
        // A click on the backdrop (the dialog element itself) closes it.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={s.modalHead}>
        <strong>{title}</strong>
        <div className={s.modalActions}>
          <a className={`${s.button} ${s.small} ${s.ghost}`} href={src} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden />Full size</a>
          <button type="button" className={`${s.button} ${s.small} ${s.ghost}`} onClick={onClose} aria-label="Close"><X size={16} aria-hidden /></button>
        </div>
      </div>
      <div className={s.modalImage}>
        {open ? (
          <>
            {state === "loading" ? <span className={s.modalStatus}><Loader2 size={22} className="spin" aria-hidden />Fetching the photo from WhatsApp…</span> : null}
            {state === "error" ? <span className={s.modalStatus}><ImageOff size={22} aria-hidden />This photo is no longer available from WhatsApp.</span> : null}
            {/* eslint-disable-next-line @next/next/no-img-element -- streamed from the worker */}
            <img src={src} alt={title} onLoad={() => setState("ready")} onError={() => setState("error")} style={{ display: state === "ready" ? "block" : "none" }} />
          </>
        ) : null}
      </div>
    </dialog>
  );
}

export function ViewImageButton({ submissionId, title, className, children }: { submissionId: string; title: string; className: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>{children}</button>
      <ImageModal src={`/api/report-bot/image/${submissionId}`} title={title} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** Review-card thumbnail; opens the modal viewer instead of a new tab. */
export function ReportThumb({ submissionId, alt, className, missingClassName }: { submissionId: string; alt: string; className: string; missingClassName: string }) {
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const src = `/api/report-bot/image/${submissionId}`;
  if (failed) {
    return (
      <div className={`${className} ${missingClassName}`}>
        <span><ImageOff size={22} aria-hidden /><br />Image not available from WhatsApp</span>
      </div>
    );
  }
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} title="View photo">
        {/* eslint-disable-next-line @next/next/no-img-element -- streamed from the worker */}
        <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />
        <span>View</span>
      </button>
      <ImageModal src={src} title={alt} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
