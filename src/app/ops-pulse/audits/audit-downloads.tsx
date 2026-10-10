"use client";

import { useState } from "react";

export function AuditDownloads({
  params,
  disabled,
  auditId,
}: {
  params?: string;
  disabled: boolean;
  auditId?: string;
}) {
  const [pending, setPending] = useState<"xlsx" | "pdf" | null>(null);
  const [notice, setNotice] = useState("");
  async function download(format: "xlsx" | "pdf") {
    if (pending || disabled) return;
    setPending(format);
    setNotice("");
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 90000);
    try {
      const response = await fetch(
        auditId
          ? `/api/ops-pulse/audits/report/${encodeURIComponent(auditId)}`
          : `/api/ops-pulse/audits/export?${params}&format=${format}`,
        { signal: controller.signal, cache: "no-store" },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(
          body?.error || "The report could not be downloaded. Please retry.",
        );
      }
      const mime = response.headers.get("Content-Type") || "";
      if (
        !mime.includes(format === "pdf" ? "application/pdf" : "spreadsheetml")
      )
        throw new Error(
          "Your session could not be verified. Reload this page and try the download again.",
        );
      const blob = await response.blob();
      const href = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = href;
      link.download =
        response.headers
          .get("Content-Disposition")
          ?.match(/filename="([^"]+)"/)?.[1] || `station-audits.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 60000);
      setNotice(`${format === "pdf" ? "PDF" : "Excel"} download started.`);
    } catch (error) {
      setNotice(
        error instanceof Error && error.name === "AbortError"
          ? "The download took too long. Try a shorter date range and download again."
          : error instanceof Error
            ? error.message
            : "Download failed. Please retry.",
      );
    } finally {
      clearTimeout(timer);
      setPending(null);
    }
  }
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        justifyContent: "flex-end",
        maxWidth: 440,
      }}
    >
      {!auditId && (
        <button
          className="button secondary compact"
          disabled={disabled || !!pending}
          onClick={() => download("xlsx")}
        >
          {pending === "xlsx" ? "Preparing Excel…" : "Download Excel"}
        </button>
      )}
      <button
        className="button secondary compact"
        disabled={disabled || !!pending}
        onClick={() => download("pdf")}
      >
        {pending === "pdf"
          ? "Preparing PDF…"
          : auditId
            ? "Download PDF report"
            : "Download PDF"}
      </button>
      {notice && (
        <small role="status" style={{ flexBasis: "100%", textAlign: "right" }}>
          {notice}
        </small>
      )}
    </div>
  );
}
