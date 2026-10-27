"use client";
import { useOpsScreenRequest, useOpsScreenRuntime } from "@/components/ops-screen-runtime";
import { useEffect, useRef, useState } from "react";
import type { ReportPack } from "@/lib/ops-pulse/checklist-report-pack";
import { buildChecklistSummary, downloadSummary, summaryPdf } from "@/lib/ops-pulse/build-checklist-summary";
import styles from "./si-handover.module.css";

export function ChecklistSummaryActions({ kind, id, completed, revision, pack }: {
  kind: "shift" | "store"; id: string; completed: boolean; revision?: string; pack?: ReportPack;
}) {
  const request = useOpsScreenRequest();
  const demo = useOpsScreenRuntime();
  const [ready, setReady] = useState<Awaited<ReturnType<typeof buildChecklistSummary>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [open, setOpen] = useState(false);
  const generation = useRef(0);
  useEffect(() => { generation.current++; setReady(null); setBusy(false); setOpen(false); setMessage(""); return () => { generation.current++; }; }, [id, kind, revision, pack]);
  async function prepare() {
    setOpen(true);
    if (ready || busy) return;
    const current = generation.current;
    setBusy(true); setMessage("");
    try {
      let data = pack;
      if (!data) {
        const res = await request(`/api/ops-pulse/${kind === "shift" ? "si-handover" : "store-ops"}/report-pack?id=${encodeURIComponent(id)}`, {credentials:"same-origin",cache:"no-store"});
        const body = await res.json(); if (!res.ok) throw Error(body.error || "Could not load summary."); data = body;
      }
      const result = await buildChecklistSummary(data!);
      if (current === generation.current) setReady(result);
    } catch (e) { if (current === generation.current) setMessage(e instanceof Error ? e.message : "Could not prepare summary."); }
    finally { if (current === generation.current) setBusy(false); }
  }
  async function whatsapp() {
    if (!ready) return;
    if (demo) { setMessage("Demo only — no message is sent. Download the sample PNG or PDF below."); return; }
    const text = `${ready.data.title}\n${ready.data.subtitle}\n${ready.data.status}\n${ready.data.submitted}`;
    // The system chooser is the supported way to share image files to WhatsApp.
    // WhatsApp web links cannot attach local files or target a private group.
    if (navigator.canShare?.({files:ready.images}) && navigator.share) {
      try { await navigator.share({files:ready.images,title:ready.data.title,text}); setMessage("Choose your store war room group in WhatsApp."); }
      catch (e) { if (!(e instanceof DOMException && e.name === "AbortError")) setMessage("Use PNG download below, then attach it in WhatsApp."); }
    } else {
      ready.images.forEach(downloadSummary);
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener,noreferrer");
      setMessage("Images downloaded. Attach them to your store war room group in WhatsApp.");
    }
  }
  return <section className={styles.summaryShare} aria-label="Share checklist summary">
    <div><strong>{completed ? "Report submitted" : "Saved report summary"}</strong><small>{completed ? "Share the summary image in your store war room WhatsApp group." : "Includes pending items. Save your changes before exporting."}</small></div>
    <button type="button" className={styles.btnAccent} onClick={() => open ? setOpen(false) : void prepare()} aria-expanded={open}>Share / export</button>
    {open ? <div className={styles.summaryShareTools}>
      <button type="button" className={styles.btn} disabled={!ready || busy} onClick={() => void whatsapp()}>Share to WhatsApp</button>
      <button type="button" className={styles.btn} disabled={!ready || busy} onClick={() => ready?.images.forEach(downloadSummary)}>PNG{ready && ready.images.length > 1 ? ` (${ready.images.length} pages)` : ""}</button>
      <button type="button" className={styles.btn} disabled={!ready || busy} onClick={async () => {
        if (!ready) return; setBusy(true); setMessage("");
        try { downloadSummary(await summaryPdf(ready.images, ready.data.filename)); }
        catch { setMessage("PDF could not be created. Try the PNG download."); } finally { setBusy(false); }
      }}>PDF</button>
      {!ready && !busy ? <button type="button" className={styles.btn} onClick={() => void prepare()}>Retry</button> : null}
      <small>Choose WhatsApp, then your store war room group. On desktop, attach the downloaded PNG.</small>
    </div> : null}
    {busy || message ? <p role="status">{busy ? "Preparing saved summary…" : message}</p> : null}
  </section>;
}
