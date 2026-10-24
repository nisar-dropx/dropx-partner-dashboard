"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { Maximize2, Minimize2, ExternalLink, ZoomIn, ZoomOut, X } from "lucide-react";
import { evidenceFitWidth } from "@/lib/evidence-fit";
import styles from "./evidence-preview.module.css";
const EvidencePdf = dynamic(() => import("./evidence-pdf").then(m => m.EvidencePdf), { ssr: false, loading: () => <p role="status">Loading document…</p> });
export function isEvidenceImage(fileName?: string | null, contentType?: string | null) {
  return Boolean(contentType?.toLowerCase().startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(fileName || ""));
}
type Props = { href: string; label: string; fileName?: string | null; contentType?: string | null; className?: string; children?: ReactNode };
/** Lazy, in-page file viewer shared by Business Docs and audit evidence in every portal. */
export function EvidencePreview({ href, label, fileName, contentType, className, children }: Props) {
  const [open, setOpen] = useState(false), [expanded, setExpanded] = useState(false);
  const [zoom, setZoom] = useState(1), [width, setWidth] = useState(600), [failed, setFailed] = useState(false);
  const [height, setHeight] = useState(400), [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const dialogRef = useRef<HTMLDialogElement>(null), stageRef = useRef<HTMLDivElement>(null);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const title = useId();
  const image = isEvidenceImage(fileName || label, contentType);
  const pdf = /\.pdf$/i.test(fileName || label) || contentType?.toLowerCase() === "application/pdf";
  useEffect(() => {
    if (!open) return;
    dialogRef.current?.showModal();
    const stage = stageRef.current;
    const observer = new ResizeObserver(() => { if (stage) { setWidth(Math.max(1, stage.clientWidth - 32)); setHeight(Math.max(1, stage.clientHeight - 32)); } });
    if (stage) observer.observe(stage);
    return () => observer.disconnect();
  }, [open]);
  return <>
    <button type="button" className={className} aria-label={`Preview ${label}`} title={`Preview ${label}`} onClick={() => { setZoom(1); setImageSize({ width: 0, height: 0 }); setExpanded(false); setFailed(false); setOpen(true); }}>{children ?? label}</button>
    {open && <dialog ref={dialogRef} className={`${styles.dialog} ${expanded ? styles.expanded : ""}`} aria-labelledby={title}
      onCancel={e => { e.preventDefault(); setOpen(false); }} onClose={() => setOpen(false)} onClick={e => { if (e.target === dialogRef.current) setOpen(false); }}>
      <div className={styles.panel}>
        <header className={styles.toolbar}><strong id={title}>{label}</strong><div className={styles.actions}>
          {(image || pdf) && <><button type="button" aria-label="Zoom out" disabled={zoom <= .5} onClick={() => setZoom(z => Math.max(.5, z - .25))}><ZoomOut size={17} /></button>
            <button type="button" title="Fit to window" aria-label="Fit to window" onClick={() => { setZoom(1); stageRef.current?.scrollTo({ top: 0, left: 0 }); }}>{Math.round(zoom * 100)}%</button>
            <button type="button" aria-label="Zoom in" disabled={zoom >= 4} onClick={() => setZoom(z => Math.min(4, z + .25))}><ZoomIn size={17} /></button></>}
          <button type="button" aria-label={expanded ? "Compact view" : "Full size"} title={expanded ? "Compact view" : "Full size"} onClick={() => setExpanded(v => !v)}>{expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>
          <a href={href} target="_blank" rel="noopener noreferrer" aria-label="Open in new window" title="Open in new window"><ExternalLink size={17} /></a>
          <button type="button" aria-label="Close preview" onClick={() => setOpen(false)}><X size={18} /></button>
        </div></header>
        <div ref={stageRef} className={styles.stage} tabIndex={0} aria-label="Document. Scroll to move; use zoom controls to enlarge."
          onPointerDown={e => { if (e.pointerType === "mouse" && e.button === 0 && !(e.target as HTMLElement).closest("a,button,input")) { pan.current = { x: e.clientX, y: e.clientY, left: e.currentTarget.scrollLeft, top: e.currentTarget.scrollTop }; e.currentTarget.setPointerCapture(e.pointerId); } }}
          onPointerMove={e => { if (pan.current) { e.currentTarget.scrollLeft = pan.current.left + pan.current.x - e.clientX; e.currentTarget.scrollTop = pan.current.top + pan.current.y - e.clientY; } }} onPointerUp={() => { pan.current = null; }} onPointerCancel={() => { pan.current = null; }}>
          {pdf ? <EvidencePdf href={href} width={width} height={height} zoom={zoom} /> : image && !failed ? <img src={href} alt={label} draggable={false} onLoad={e => setImageSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })} onError={() => setFailed(true)} style={{ width: evidenceFitWidth(imageSize.width, imageSize.height, width, height) * zoom, visibility: imageSize.width ? "visible" : "hidden" }} /> : <p>This file cannot be previewed here. <a href={href} target="_blank" rel="noopener noreferrer">Open in new window</a>.</p>}
        </div>
      </div>
    </dialog>}
  </>;
}
