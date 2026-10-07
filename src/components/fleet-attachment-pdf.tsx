'use client';
import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

/** One canvas/page at a time: works on mobile without relying on a browser PDF plug-in. */
export default function FleetAttachmentPdf({ url }: { url: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null), [page, setPage] = useState(1), [zoom, setZoom] = useState(1), [error, setError] = useState(''), [rendering, setRendering] = useState(true);
  useEffect(() => {
    let disposed = false; let task: { destroy: () => Promise<void> } | undefined;
    (async () => {
      const pdf = await import('pdfjs-dist');
      if (disposed) return;
      pdf.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker-4.10.38.min.mjs';
      const loading = pdf.getDocument({ url, isEvalSupported: false }); task = loading;
      const result = await loading.promise;
      if (!disposed) { setDoc(result); setPage(1); }
    })().catch(() => { if (!disposed) setError('PDF preview unavailable. You can still download the file.'); });
    return () => { disposed = true; void task?.destroy(); };
  }, [url]);
  useEffect(() => {
    if (!doc) return;
    let disposed = false; let task: { cancel: () => void } | undefined;
    setRendering(true); setError('');
    (async () => {
      const sheet = await doc.getPage(page); if (disposed || !canvas.current) return;
      const base = sheet.getViewport({ scale: 1 });
      const viewport = sheet.getViewport({ scale: Math.min(1.5 * zoom, 3200 / Math.max(base.width, base.height)) }); const node = canvas.current;
      node.width = viewport.width; node.height = viewport.height;
      const context = node.getContext('2d'); if (!context) throw new Error('Canvas unavailable');
      const render = sheet.render({ canvasContext: context, viewport }); task = render;
      await render.promise; if (!disposed) setRendering(false);
    })().catch(() => { if (!disposed) { setRendering(false); setError('This PDF page could not be displayed. Download the original.'); } });
    return () => { disposed = true; task?.cancel(); };
  }, [doc, page, zoom]);
  return <div className="fleet-file-pdf"><div className="fleet-file-pdf-tools"><button type="button" disabled={!doc || page <= 1 || rendering} onClick={() => setPage(n => n - 1)}>Previous</button><span>{doc ? `${page} / ${doc.numPages}` : 'Loading PDF…'}</span><button type="button" disabled={!doc || page >= doc.numPages || rendering} onClick={() => setPage(n => n + 1)}>Next</button><button type="button" disabled={!doc} onClick={() => setZoom(n => n === 1 ? 2 : 1)}>{zoom === 1 ? 'Zoom in' : 'Fit page'}</button></div>{error ? <p role="alert">{error}</p> : null}{rendering && !error ? <span role="status">Loading page…</span> : null}<div className="fleet-file-pdf-page"><canvas ref={canvas} style={{width:zoom === 2 ? '200%' : '100%'}} aria-label={`PDF page ${page}`}/></div></div>;
}
