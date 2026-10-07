'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, ExternalLink, Maximize2, Minimize2, RotateCw, X } from 'lucide-react';
import { lazy, Suspense } from 'react';
import './fleet-attachment-viewer.css';
import { FleetAttachmentBoundary } from './fleet-attachment-boundary';
const Pdf = lazy(() => import('./fleet-attachment-pdf'));
const LIMIT = 25 * 1024 * 1024;
async function readFile(response: Response, limit: number) {
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'You do not have access to this attachment, or your session expired.' : 'Attachment could not be loaded. Retry or download the original.');
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('This file exceeds the viewer size limit.'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Attachment is unavailable. Retry.');
  const chunks: ArrayBuffer[] = []; let size = 0;
  while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > limit) { await reader.cancel(); throw new Error('This file exceeds the viewer size limit.'); } chunks.push(new Uint8Array(next.value).buffer); }
  const type = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  if (/text\/html|application\/json/.test(type)) throw new Error('Attachment unavailable or session expired. Close this preview and sign in again if needed.');
  return new Blob(chunks, {type});
}

function safeUrl(value: string) {
  try { const u = new URL(value, window.location.href); return ['http:', 'https:'].includes(u.protocol) ? u.href : ''; } catch { return ''; }
}

export default function FleetAttachmentViewer({ url, fileName, downloadUrl, onClose }: { url: string; fileName?: string; downloadUrl?: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId();
  const [full, setFull] = useState(false), [app, setApp] = useState(false), [retry, setRetry] = useState(0);
  const [file, setFile] = useState<{ url: string; type: string; name: string } | null>(null);
  const downloadController = useRef<AbortController | null>(null);
  const [downloading, setDownloading] = useState(false), [downloadError, setDownloadError] = useState('');
  const [error, setError] = useState(''), [mediaError, setMediaError] = useState(false);
  const original = safeUrl(url), fallback = safeUrl(downloadUrl || url);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    setApp(window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: fullscreen)').matches || document.referrer.startsWith('android-app://com.dropxlogistics.fleet'));
    return () => { downloadController.current?.abort(); node?.close(); document.body.style.overflow = overflow; };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); let objectUrl = ''; let disposed = false;
    const timeout = setTimeout(() => controller.abort(), 30000);
    setFile(null); setError(''); setMediaError(false);
    (async () => {
      if (!original) throw new Error('This attachment link is unavailable.');
      const response = await fetch(original, { signal: controller.signal, cache: 'no-store', credentials: 'same-origin' });
      const blob = await readFile(response, LIMIT);
      const type = blob.type;
      const disposition = response.headers.get('content-disposition') || '';
      const name = fileName || disposition.match(/filename="([^"]+)"/i)?.[1] || decodeURIComponent(new URL(response.url || original).pathname.split('/').pop() || 'attachment');
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob); setFile({ url: objectUrl, type, name });
    })().catch(e => { if (!disposed) setError(e.name === 'AbortError' ? 'Preview timed out. Retry or download the original.' : e.message || 'Preview unavailable.'); }).finally(() => clearTimeout(timeout));
    return () => { disposed = true; controller.abort(); clearTimeout(timeout); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [original, fileName, retry]);
  async function downloadOriginal() {
    setDownloading(true); setDownloadError('');
    const controller = new AbortController(); downloadController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(fallback, {signal:controller.signal,cache:'no-store',credentials:'same-origin'});
      const blob = await readFile(response, 100 * 1024 * 1024);
      const objectUrl = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = objectUrl; link.download = fileName || 'attachment'; document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    } catch (e) { if (!controller.signal.aborted) setDownloadError(e instanceof Error ? e.message : 'Download failed. Retry.'); else setDownloadError('Download timed out. Retry.'); }
    finally { clearTimeout(timeout); setDownloading(false); }
  }
  const kind = file?.type.startsWith('image/') && file.type !== 'image/svg+xml' ? 'image' : file?.type === 'application/pdf' ? 'pdf' : file?.type.startsWith('video/') ? 'video' : file?.type.startsWith('audio/') ? 'audio' : 'other';
  return createPortal(<dialog ref={dialog} className={`fleet-file-viewer ${full ? 'is-full' : ''}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }} onClick={event => event.stopPropagation()}>
    <header><div><small>Attachment preview</small><h2 id={titleId}>{fileName || file?.name || 'Attachment'}</h2></div><button autoFocus type="button" aria-label="Close attachment preview" onClick={onClose}><X size={20}/></button></header>
    <div className="fleet-file-stage">
      {error || mediaError ? <div className="fleet-file-message" role="alert"><p>{error || 'This file could not be displayed. Download the original or retry.'}</p><button type="button" onClick={() => setRetry(n => n + 1)}><RotateCw size={16}/>Retry</button></div> : !file ? <p role="status">Loading attachment…</p> : kind === 'image' ? <img src={file.url} alt={file.name} onError={() => setMediaError(true)}/> : kind === 'pdf' ? <FleetAttachmentBoundary fallback={<p role="alert">PDF preview unavailable. Download the original.</p>}><Suspense fallback={<p role="status">Opening PDF…</p>}><Pdf url={file.url}/></Suspense></FleetAttachmentBoundary> : kind === 'video' ? <video controls src={file.url} onError={() => setMediaError(true)}/> : kind === 'audio' ? <audio controls src={file.url} onError={() => setMediaError(true)}/> : <p>Preview is not available for this file type. Download the original to view it.</p>}
    </div>
    {downloadError ? <p className="fleet-file-download-error" role="alert">{downloadError}</p> : null}
    <footer><button type="button" onClick={() => setFull(value => !value)}>{full ? <Minimize2 size={16}/> : <Maximize2 size={16}/>} {full ? 'Compact view' : 'Full size'}</button>{!app && original ? <a href={original} target="_blank" rel="noopener noreferrer"><ExternalLink size={16}/>New window</a> : null}{file ? <a className="fleet-file-download" href={file.url} download={file.name}><Download size={16}/>Download</a> : fallback ? <button className="fleet-file-download" type="button" disabled={downloading} onClick={downloadOriginal}><Download size={16}/>{downloading ? 'Downloading…' : 'Download'}</button> : null}</footer>
  </dialog>, document.body);
}
