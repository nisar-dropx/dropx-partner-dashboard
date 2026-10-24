"use client";
import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { loadPdfJs } from "@/lib/ops-pulse/pdf-slip";

function PdfPage({ pdf, page, width }: { pdf: PDFDocumentProxy; page: number; width: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(page === 1);
  const [ratio, setRatio] = useState(1.414);
  const [error, setError] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "400px" });
    if (box.current) observer.observe(box.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    void pdf.getPage(page).then(async p => {
      if (cancelled || !canvas.current) return;
      const base = p.getViewport({ scale: 1 });
      setRatio(base.height / base.width);
      const dpr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(6000000 / (width * width * base.height / base.width)));
      const viewport = p.getViewport({ scale: width / base.width * dpr });
      canvas.current.width = Math.floor(viewport.width);
      canvas.current.height = Math.floor(viewport.height);
      render = p.render({ canvasContext: canvas.current.getContext("2d")!, viewport });
      await render.promise;
    }).catch(e => { if (!cancelled && e?.name !== "RenderingCancelledException") setError(true); });
    return () => { cancelled = true; render?.cancel(); };
  }, [pdf, page, width, visible]);
  return <div ref={box} style={{ width, minHeight: width * ratio, background: "white", margin: "0 auto 12px", position: "relative" }}>
    {error ? <p role="alert">Page {page} could not be rendered. Use Open in new window.</p> : visible ? <canvas ref={canvas} aria-label={`Page ${page}`} style={{ width: "100%", display: "block" }} /> : <span>Page {page}</span>}
  </div>;
}
export function EvidencePdf({ href, width }: { href: string; width: number }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let disposed = false;
    let task: ReturnType<Awaited<ReturnType<typeof loadPdfJs>>["getDocument"]> | undefined;
    setPdf(null); setError(false);
    void loadPdfJs().then(lib => {
      if (disposed) return;
      task = lib.getDocument({ url: href, isEvalSupported: false });
      return task.promise;
    }).then(result => { if (result && !disposed) setPdf(result); })
      .catch(() => { if (!disposed) setError(true); });
    return () => { disposed = true; void task?.destroy(); };
  }, [href]);
  if (error) return <p role="alert">Preview unavailable. Open the file in a new window or download it.</p>;
  if (!pdf) return <p role="status">Loading document…</p>;
  return <div aria-label={`${pdf.numPages} pages`}>
    {Array.from({ length: pdf.numPages }, (_, i) => <PdfPage key={i} pdf={pdf} page={i + 1} width={width} />)}
  </div>;
}
