"use client";

import { Download, LoaderCircle } from "lucide-react";
import { useState } from "react";

function downloadName(response: Response) {
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = disposition.match(/filename="?([^";]+)"?/i);
  return match?.[1] || `raw-punches-${new Date().toISOString().slice(0, 10)}.xlsx`;
}

export function RawPunchExportButton({ href }: { href: string }) {
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState("");

  async function download() {
    if (preparing) return;
    setPreparing(true);
    setError("");
    try {
      const response = await fetch(href, { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || "Unable to prepare the Excel report. Please try again.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = downloadName(response);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "Unable to prepare the Excel report. Please try again.");
    } finally {
      setPreparing(false);
    }
  }

  return (
    <div className="raw-punch-export-action">
      <button className="button secondary" disabled={preparing} onClick={download} type="button">
        {preparing ? <LoaderCircle aria-hidden="true" className="raw-punch-export-spinner" size={16} /> : <Download aria-hidden="true" size={16} />}
        {preparing ? "Preparing Excel…" : "Download Excel"}
      </button>
      {error ? <span className="raw-punch-export-error" role="alert">{error}</span> : null}
    </div>
  );
}
