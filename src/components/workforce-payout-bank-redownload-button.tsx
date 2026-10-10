"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

function attachmentFilename(disposition: string | null, fallback: string) {
  const encoded = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const quoted = disposition?.match(/filename="([^"]+)"/i)?.[1];
  const plain = disposition?.match(/filename=([^;]+)/i)?.[1];
  let candidate = encoded ? decodeURIComponent(encoded) : quoted ?? plain ?? fallback;
  candidate = candidate.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim();
  return candidate || fallback;
}

async function responseError(response: Response) {
  try {
    const payload = await response.json();
    return String(payload?.error ?? "").trim() || "Unable to re-download the selected bank file.";
  } catch {
    return "Unable to re-download the selected bank file.";
  }
}

export function WorkforcePayoutBankRedownloadButton({
  disabled,
  onBusyChange,
  paymentItemIds,
  periodEnd,
  periodStart
}: {
  disabled: boolean;
  onBusyChange?: (busy: boolean) => void;
  paymentItemIds: readonly string[];
  periodEnd: string;
  periodStart: string;
}) {
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const exactPaymentItemIds = useMemo(
    () => [...new Set(paymentItemIds.map((id) => id.trim().toLowerCase()).filter(Boolean))].sort(),
    [paymentItemIds]
  );

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    closeRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) ?? [])];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      trigger?.focus();
    };
  }, [busy, open]);

  async function download() {
    if (busy || !exactPaymentItemIds.length) return;
    setBusy(true);
    onBusyChange?.(true);
    setError("");
    try {
      const response = await fetch("/api/payments/workforce-payouts/bank-file/re-download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentItemIds: exactPaymentItemIds,
          periodStart,
          periodEnd
        })
      });
      if (!response.ok) throw new Error(await responseError(response));
      const blob = await response.blob();
      const fallback = `workforce-payouts-${periodStart.slice(0, 7)}-redownload.${blob.type === "application/zip" ? "zip" : "xlsx"}`;
      const filename = attachmentFilename(response.headers.get("content-disposition"), fallback);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to re-download the selected bank file.");
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  const modal = open && typeof document !== "undefined" ? createPortal(
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setOpen(false); }}>
      <section aria-labelledby={titleId} aria-modal="true" className="modal-panel" ref={dialogRef} role="dialog">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Workforce payments</span>
            <h2 id={titleId}>Re-download bank file</h2>
          </div>
          <button className="button secondary compact" disabled={busy} onClick={() => setOpen(false)} ref={closeRef} type="button">Close</button>
        </div>
        <div className="panel-body">
          <div className="payout-inline-message warn">
            <strong>This is an exact copy of existing Payment Processing instructions.</strong>
            <p>It keeps the original bank references, amounts, beneficiary details and value dates. It does not create a new payment version or change any payment status.</p>
            <p>Do not submit both the original file and this downloaded copy to the bank.</p>
          </div>
          <p><strong>{exactPaymentItemIds.length.toLocaleString("en-IN")}</strong> selected processing payment{exactPaymentItemIds.length === 1 ? "" : "s"} will be included. If they came from different original batches, the download will be a ZIP containing separate bank files.</p>
          {error ? <div className="payout-inline-message error" role="alert">{error}</div> : null}
          <div className="form-actions">
            <button className="button secondary" disabled={busy} onClick={() => setOpen(false)} type="button">Cancel</button>
            <button className="button" disabled={busy || !exactPaymentItemIds.length} onClick={download} type="button">{busy ? "Preparing…" : "Download selected copy"}</button>
          </div>
        </div>
      </section>
    </div>, document.body
  ) : null;

  return <>
    <button
      className="button secondary"
      disabled={disabled || busy || !exactPaymentItemIds.length}
      onClick={() => { setError(""); setOpen(true); }}
      ref={triggerRef}
      type="button"
    >Re-download bank file{exactPaymentItemIds.length ? ` (${exactPaymentItemIds.length})` : ""}</button>
    {modal}
  </>;
}
