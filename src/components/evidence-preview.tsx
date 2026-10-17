"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import styles from "./evidence-preview.module.css";

export function isEvidenceImage(fileName?: string | null, contentType?: string | null) {
  if (contentType?.toLowerCase().startsWith("image/")) return true;
  return /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(fileName || "");
}

type EvidencePreviewProps = {
  href: string;
  label: string;
  fileName?: string | null;
  contentType?: string | null;
  className?: string;
  children?: ReactNode;
};

/** Opens images in a preview dialog with a fullscreen option; other files keep a new-tab link. */
export function EvidencePreview({
  href,
  label,
  fileName,
  contentType,
  className,
  children,
}: EvidencePreviewProps) {
  const [open, setOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const image = isEvidenceImage(fileName || label, contentType);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onFullscreen = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, [open]);

  useEffect(() => {
    if (open) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    setFullscreen(false);
  }, [open]);

  const toggleFullscreen = async () => {
    const stage = stageRef.current;
    if (!stage) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await stage.requestFullscreen();
    } catch {
      // Fullscreen can be blocked by the browser; the dialog preview still works.
    }
  };

  if (!image) {
    return (
      <a className={className} href={href} target="_blank" rel="noreferrer">
        {children ?? label}
      </a>
    );
  }

  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        {children ?? label}
      </button>
      {open ? (
        <dialog
          ref={dialogRef}
          className={styles.dialog}
          aria-labelledby={titleId}
          onCancel={(event) => {
            event.preventDefault();
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
          onClick={(event) => {
            if (event.target === dialogRef.current) setOpen(false);
          }}
        >
          <div className={styles.panel} role="document">
            <header className={styles.toolbar}>
              <strong id={titleId}>{label}</strong>
              <div className={styles.actions}>
                <button type="button" className="button secondary compact" onClick={() => void toggleFullscreen()}>
                  {fullscreen ? "Exit full screen" : "Full screen"}
                </button>
                <a className="button secondary compact" href={href} target="_blank" rel="noreferrer">
                  Open file
                </a>
                <button type="button" className="button secondary compact" onClick={() => setOpen(false)}>
                  Close
                </button>
              </div>
            </header>
            <div ref={stageRef} className={styles.stage}>
              {/* Evidence URLs are authenticated app routes or short-lived signed links. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={href} alt={label} />
            </div>
          </div>
        </dialog>
      ) : null}
    </>
  );
}
