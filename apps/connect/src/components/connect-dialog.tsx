"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";

/** Native dialogs keep keyboard focus and nested attachment previews in the top layer. */
export function ConnectDialog({ title, eyebrow, className = "", onClose, children }: {
  title: string;
  eyebrow?: string;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    const previouslyFocused = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) previouslyFocused.focus();
    };
  }, []);

  return <dialog
    aria-labelledby={titleId}
    className={`dx-dialog ${className}`}
    onCancel={(event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.target === event.currentTarget) onClose();
    }}
    onKeyDown={(event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    ref={ref}
  >
    <div className="dx-dialog-surface">
      <header className="dx-dialog-head">
        <div>{eyebrow ? <small>{eyebrow}</small> : null}<h2 id={titleId}>{title}</h2></div>
        <button aria-label="Close" className="dx-dialog-close" onClick={onClose} type="button"><X /></button>
      </header>
      <div className="dx-dialog-content">{children}</div>
    </div>
  </dialog>;
}
