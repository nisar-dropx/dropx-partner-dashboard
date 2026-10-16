"use client";

import { useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Check, Copy, ImageOff, Loader2 } from "lucide-react";

type FormAction = (formData: FormData) => void | Promise<void>;

/**
 * Submit button with a spinner on the button that was actually pressed, an optional
 * confirmation, and an optional per-button server action (several actions, one form).
 */
export function ActionButton({ children, className, confirm, disabled, formAction, skipValidation }: {
  children: ReactNode;
  className: string;
  confirm?: string;
  disabled?: boolean;
  formAction?: FormAction;
  skipValidation?: boolean;
}) {
  const status = useFormStatus();
  const mine = status.pending && (!formAction || status.action === formAction);
  return (
    <button
      type="submit"
      className={className}
      formAction={formAction}
      formNoValidate={skipValidation}
      disabled={disabled || status.pending}
      aria-busy={mine}
      onClick={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault();
      }}
    >
      {mine ? <Loader2 size={15} className="spin" aria-hidden /> : null}
      {children}
    </button>
  );
}

export function CopyButton({ value, className }: { value: string; className: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** Report image fetched live from WhatsApp; shows a calm fallback when it is no longer available. */
export function ReportThumb({ src, alt, className, missingClassName }: { src: string; alt: string; className: string; missingClassName: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className={`${className} ${missingClassName}`}>
        <span><ImageOff size={22} aria-hidden /><br />Image not available from WhatsApp</span>
      </div>
    );
  }
  return (
    <a className={className} href={src} target="_blank" rel="noreferrer" title="Open full image">
      {/* eslint-disable-next-line @next/next/no-img-element -- streamed from the worker, not a static asset */}
      <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />
      <span>Open</span>
    </a>
  );
}
