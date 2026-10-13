"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { compressPdfSlip, isPdfFile, PdfSlipError, renderPdfPages } from "@/lib/ops-pulse/pdf-slip";

type SlipStatus =
  | { kind: "idle" }
  | { kind: "preparing" }
  | { kind: "pdf"; previewUrl: string; note: string }
  | { kind: "error"; message: string };

function sizeLabel(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Deposit slip file input. A photo is submitted as picked. A PDF stays a PDF;
 * a large one is compressed in the browser and swapped into the input first.
 */
export function DepositSlipInput({ required = false }: { required?: boolean }) {
  const [status, setStatus] = useState<SlipStatus>({ kind: "idle" });
  // Bumped on every pick so a slow compression cannot overwrite a newer choice.
  const pick = useRef(0);
  const previewUrl = status.kind === "pdf" ? status.previewUrl : null;

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  async function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const current = ++pick.current;
    const file = input.files?.[0];
    input.setCustomValidity("");
    if (!file || !isPdfFile(file)) {
      setStatus({ kind: "idle" });
      return;
    }

    // Blocks submit until the PDF to upload is settled.
    input.setCustomValidity("The PDF is still being prepared. Wait a moment and try again.");
    setStatus({ kind: "preparing" });
    try {
      const upload = await compressPdfSlip(file);
      // Rendering the first page also refuses a PDF nobody could open (locked
      // or damaged) here instead of after it is uploaded.
      const preview = await renderPdfPages(await upload.arrayBuffer(), { maxPages: 1, width: 700 });
      if (current !== pick.current) return;
      if (!preview.pages.length) throw new PdfSlipError("This PDF has no pages. Upload a photo of the slip instead.");
      if (upload !== file) {
        const transfer = new DataTransfer();
        transfer.items.add(upload);
        input.files = transfer.files;
      }
      input.setCustomValidity("");
      const pages = `${preview.totalPages} page${preview.totalPages === 1 ? "" : "s"}`;
      setStatus({
        kind: "pdf",
        previewUrl: URL.createObjectURL(preview.pages[0].blob),
        note: upload === file
          ? `PDF attached: ${pages}, ${sizeLabel(upload.size)}.`
          : `PDF attached: ${pages}, compressed from ${sizeLabel(file.size)} to ${sizeLabel(upload.size)}.`
      });
    } catch (error) {
      if (current !== pick.current) return;
      input.value = "";
      input.setCustomValidity("");
      setStatus({
        kind: "error",
        message: error instanceof PdfSlipError
          ? error.message
          : "This PDF could not be prepared. Upload a photo of the slip instead."
      });
    }
  }

  return (
    <>
      <input
        className="field"
        name="deposit_slip"
        type="file"
        accept="image/*,application/pdf"
        required={required}
        onChange={handleChange}
      />
      {status.kind === "preparing" ? (
        <span className="subtle" role="status" style={{ display: "block", marginTop: 6 }}>Preparing PDF…</span>
      ) : null}
      {status.kind === "error" ? (
        <span role="alert" style={{ display: "block", marginTop: 6, color: "#b91c1c" }}>{status.message}</span>
      ) : null}
      {status.kind === "pdf" ? (
        <span style={{ display: "block", marginTop: 6 }}>
          <span className="subtle" role="status" style={{ display: "block", marginBottom: 6 }}>{status.note}</span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt="Deposit slip PDF, first page"
            src={status.previewUrl}
            style={{ maxWidth: "100%", maxHeight: 220, objectFit: "contain", borderRadius: 8, border: "1px solid var(--border, #ddd)" }}
          />
        </span>
      ) : null}
    </>
  );
}
