"use client";
import { useState } from "react";
import { Download } from "lucide-react";
import styles from "./station-edd.module.css";

export function StationEddDownload({ href, label = "Download report", disabled = false }: { href: string; label?: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function download() {
    setBusy(true); setError("");
    try {
      const response = await fetch(href, { cache: "no-store" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Report download failed.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] || "station-edd.xlsx";
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Download failed."); }
    finally { setBusy(false); }
  }
  return <div><button className={styles.button} type="button" onClick={download} disabled={busy || disabled}><Download size={15} /> {busy ? "Preparing report…" : label}</button>{error ? <p role="alert">{error}</p> : null}</div>;
}
