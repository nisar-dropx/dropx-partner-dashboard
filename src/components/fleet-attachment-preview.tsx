'use client';

import { lazy, Suspense, useState, type AnchorHTMLAttributes } from 'react';
import { FleetAttachmentBoundary } from './fleet-attachment-boundary';
const Viewer = lazy(() => import('./fleet-attachment-viewer'));

/** Keep the existing link as a no-JavaScript fallback; load the viewer only on demand. */
export function FleetAttachmentPreview({ fileName, downloadUrl, ...link }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; fileName?: string; downloadUrl?: string }) {
  const [open, setOpen] = useState(false);
  return <><a {...link} onClick={event => { if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); setOpen(true); }} />{open ? <FleetAttachmentBoundary fallback={<span role="alert">Preview unavailable. <button type="button" onClick={() => setOpen(false)}>Close</button></span>}><Suspense fallback={<span role="status">Opening preview…</span>}><Viewer url={link.href} fileName={fileName} downloadUrl={downloadUrl} onClose={() => setOpen(false)} /></Suspense></FleetAttachmentBoundary> : null}</>;
}
