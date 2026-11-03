"use client";

import { useEffect, useState } from "react";
import { Copy } from "lucide-react";

/** Start clipboard.write in the click gesture, including on Safari. Never silently copy only part of a report. */
export function CopyReportImage({ getImages, resetKey, disabled, className }: {
  getImages: () => Promise<Blob[]>; resetKey: unknown; disabled?: boolean; className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  useEffect(() => { setPages(0); setPage(1); setMessage(""); }, [resetKey]);
  useEffect(() => {
    if (!message.startsWith("Copied")) return;
    const timer = setTimeout(() => setMessage(""), 3500);
    return () => clearTimeout(timer);
  }, [message]);
  async function copy() {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      setMessage("Image copy is unavailable in this browser. Use Image download."); return;
    }
    setBusy(true); setMessage("");
    const image = getImages().then(images => {
      if (!images.length) throw Error("No report rows to copy.");
      setPages(images.length);
      if (images.length > 1 && pages !== images.length) throw Error(`Report has ${images.length} pages. Choose a page, then copy.`);
      if (!images[page - 1]) throw Error("Choose an available page.");
      return images[page - 1];
    });
    // Consume render rejection even when a browser refuses clipboard permission immediately.
    void image.catch(() => undefined);
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": image })]);
      setMessage(pages > 1 ? `Copied page ${page}.` : "Copied image.");
    } catch (error) {
      setMessage(error instanceof Error && error.name !== "NotAllowedError" ? error.message : "Clipboard access blocked. Allow clipboard access or use Image download.");
    } finally { setBusy(false); }
  }
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
    {pages > 1 ? <select aria-label="Image page to copy" value={page} disabled={busy} onChange={e => setPage(Number(e.target.value))}>
      {Array.from({ length: pages }, (_, i) => <option key={i} value={i + 1}>Page {i + 1} / {pages}</option>)}
    </select> : null}
    <button type="button" className={className} disabled={disabled || busy} onClick={() => void copy()}><Copy size={14} />{busy ? "Copying…" : pages > 1 ? `Copy page ${page}` : "Copy image"}</button>
    {message ? <span role="status" style={{ fontSize: 11, maxWidth: 260 }}>{message}</span> : null}
  </span>;
}
