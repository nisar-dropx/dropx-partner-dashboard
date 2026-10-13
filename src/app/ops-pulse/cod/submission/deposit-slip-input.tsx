"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { isPdfFile, pdfSlipToImage } from "@/lib/ops-pulse/pdf-slip-image";

type SlipStatus =
  | { kind: "idle" }
  | { kind: "converting" }
  | { kind: "converted"; previewUrl: string; note: string }
  | { kind: "error"; message: string };

/**
 * Deposit slip file input. A PDF is converted to a JPEG in the browser and
 * swapped into the input, so the form always submits an image.
 */
export function DepositSlipInput({ required = false }: { required?: boolean }) {
  const [status, setStatus] = useState<SlipStatus>({ kind: "idle" });
  // Bumped on every pick so a slow conversion cannot overwrite a newer choice.
  const pick = useRef(0);
  const previewUrl = status.kind === "converted" ? status.previewUrl : null;

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

    // Blocks submit until the image has replaced the PDF.
    input.setCustomValidity("The PDF is still being converted. Wait a moment and try again.");
    setStatus({ kind: "converting" });
    try {
      const image = await pdfSlipToImage(file);
      if (current !== pick.current) return;
      const transfer = new DataTransfer();
      transfer.items.add(image.file);
      input.files = transfer.files;
      input.setCustomValidity("");
      setStatus({
        kind: "converted",
        previewUrl: URL.createObjectURL(image.file),
        note: image.totalPages > image.pages
          ? `PDF converted to an image. Only the first ${image.pages} of ${image.totalPages} pages are included.`
          : "PDF converted to an image."
      });
    } catch (error) {
      if (current !== pick.current) return;
      input.value = "";
      input.setCustomValidity("");
      setStatus({
        kind: "error",
        message: error instanceof Error && error.message.includes("Upload a photo")
          ? error.message
          : "This PDF could not be converted. Upload a photo of the slip instead."
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
      {status.kind === "converting" ? (
        <span className="subtle" role="status" style={{ display: "block", marginTop: 6 }}>Converting PDF to an image…</span>
      ) : null}
      {status.kind === "error" ? (
        <span role="alert" style={{ display: "block", marginTop: 6, color: "#b91c1c" }}>{status.message}</span>
      ) : null}
      {status.kind === "converted" ? (
        <span style={{ display: "block", marginTop: 6 }}>
          <span className="subtle" role="status" style={{ display: "block", marginBottom: 6 }}>{status.note}</span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt="Converted deposit slip"
            src={status.previewUrl}
            style={{ maxWidth: "100%", maxHeight: 220, objectFit: "contain", borderRadius: 8, border: "1px solid var(--border, #ddd)" }}
          />
        </span>
      ) : null}
    </>
  );
}
