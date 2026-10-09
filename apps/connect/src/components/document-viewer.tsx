"use client";

import { Download, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { downloadDocument, loadDocument, type StoredDocument } from "../lib/document-store";

// Must match the pdfjs-dist version in package.json (the worker is served from /public).
const PDF_WORKER_URL = "/pdfjs/pdf.worker-4.10.38.min.mjs";

async function renderPdf(bytes: Uint8Array, container: HTMLDivElement, isCancelled: () => boolean) {
  // Legacy build: the modern one needs newer JavaScript than some phones' WebView has.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
  const pdf = await pdfjs.getDocument({ data: bytes }).promise;
  const width = container.clientWidth || window.innerWidth;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    if (isCancelled()) return;
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: (width / page.getViewport({ scale: 1 }).width) * pixelRatio });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = "100%";
    canvas.style.height = "auto";
    const context = canvas.getContext("2d");
    if (!context) continue;
    await page.render({ canvasContext: context, viewport }).promise;
    if (isCancelled()) return;
    container.appendChild(canvas);
  }
}

export function DocumentViewer({ document, title, note, onClose }: { document: StoredDocument; title: string; note?: string; onClose: () => void }) {
  const pagesRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    let objectUrl = "";
    const container = pagesRef.current;
    if (container) container.replaceChildren();
    setStatus("loading");
    setError("");
    (async () => {
      try {
        const { bytes, mimeType } = await loadDocument(document);
        if (cancelled) return;
        if (mimeType.startsWith("image/")) {
          objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
          setImageUrl(objectUrl);
        } else if (container) {
          await renderPdf(bytes, container, () => cancelled);
        }
        if (!cancelled) setStatus("ready");
      } catch (reason) {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : "Unable to open this document.");
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [document]);

  async function save() {
    setSaving(true);
    setNotice("");
    setError("");
    try {
      setNotice(await downloadDocument(document));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to download this document.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div aria-labelledby="dx-document-viewer-title" className="dx-document-viewer">
      <header>
        <button aria-label="Back to documents" className="close" onClick={onClose} type="button"><X />Back</button>
        <strong id="dx-document-viewer-title">{title}</strong>
        <button disabled={saving} onClick={() => void save()} type="button">
          {saving ? <LoaderCircle /> : <Download />}Download
        </button>
      </header>
      {note ? <p className="dx-pay-may-change">{note}</p> : null}
      {notice ? <p className="dx-document-viewer-notice">{notice}</p> : null}
      <div className="dx-document-viewer-body">
        {status === "loading" ? <div className="dx-loader"><span /><small>Opening document…</small></div> : null}
        {error ? <p className="dx-document-viewer-error">{error}</p> : null}
        {imageUrl ? <img alt={title} src={imageUrl} /> : null}
        <div className="dx-document-viewer-pages" ref={pagesRef} />
      </div>
    </div>
  );
}
