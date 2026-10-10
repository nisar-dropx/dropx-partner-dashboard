"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

export type WorkforcePayoutProcessingSelection = {
  paymentItemId: string;
  dropxId: string;
  name: string;
  location: string;
  amount: number;
};

function money(value: number) {
  return `Rs ${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function WorkforcePayoutBulkCancellation({
  audience = "workforce",
  disabled,
  items,
  onBusyChange,
  onCompleted,
  periodEnd,
  periodStart
}: {
  audience?: "workforce" | "helpers";
  disabled: boolean;
  items: WorkforcePayoutProcessingSelection[];
  onBusyChange: (busy: boolean) => void;
  onCompleted: (cancelled: number) => void;
  periodStart: string;
  periodEnd: string;
}) {
  const router = useRouter();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [remarks, setRemarks] = useState("");
  const [error, setError] = useState("");
  const [operationId, setOperationId] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLElement>(null);
  const total = useMemo(() => items.reduce((sum, item) => sum + Number(item.amount || 0), 0), [items]);

  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    closeRef.current?.focus();
    function handleKeys(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(modalRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
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
    document.addEventListener("keydown", handleKeys);
    return () => {
      document.removeEventListener("keydown", handleKeys);
      trigger?.focus();
    };
  }, [busy, open]);

  function showDialog() {
    if (disabled || !items.length) return;
    setRemarks("");
    setError("");
    setOperationId(crypto.randomUUID());
    setOpen(true);
  }

  function closeDialog() {
    if (busy) return;
    setOpen(false);
    setError("");
  }

  async function cancelSelectedPayments() {
    const reason = remarks.trim();
    if (busy || !items.length || reason.length < 3 || reason.length > 1000 || !operationId) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/payments/workforce-payouts/payment-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "cancelled",
          audience,
          operationId,
          paymentItemIds: items.map((item) => item.paymentItemId),
          periodStart,
          periodEnd,
          remarks: reason
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Unable to cancel the selected processing payments.");
      const cancelled = Number(payload?.cancelled ?? items.length);
      setOpen(false);
      setRemarks("");
      onCompleted(cancelled);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to cancel the selected processing payments.");
    } finally {
      setBusy(false);
    }
  }

  const modal = open && typeof document !== "undefined" ? createPortal(
    <div className="modal-backdrop confirmation-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog(); }} role="presentation">
      <section aria-labelledby={titleId} aria-modal="true" className="modal-panel confirmation-dialog" ref={modalRef} role="alertdialog">
        <div className="panel-head">
          <div>
            <p className="eyebrow">{audience === "helpers" ? "Helper" : "Workforce"} payments</p>
            <h2 id={titleId}>Cancel processing payments</h2>
          </div>
          <button aria-label="Close bulk cancellation dialog" className="button secondary compact" disabled={busy} onClick={closeDialog} ref={closeRef} type="button">Close</button>
        </div>
        <div className="panel-body">
          <p>Cancel {items.length.toLocaleString("en-IN")} selected Payment Processing instruction{items.length === 1 ? "" : "s"} totaling <strong>{money(total)}</strong>?</p>
          <div className="payout-inline-message warn">
            <strong>Processing lock will be released</strong>
            <p>The bank instructions remain in permanent payment history as cancelled. They will not count as paid, and a later bank file can use the outstanding balance under a new payment version.</p>
          </div>
          <div className="payout-inline-message">
            <strong>Selected payout rows</strong>
            <p>{items.slice(0, 8).map((item) => `${item.dropxId || item.name} · ${item.location}`).join(", ")}{items.length > 8 ? ` and ${items.length - 8} more` : ""}</p>
          </div>
          <label>
            <span>Cancellation remarks</span>
            <textarea
              autoFocus
              className="field"
              disabled={busy}
              maxLength={1000}
              minLength={3}
              onChange={(event) => setRemarks(event.target.value)}
              placeholder="Enter why these processing payments are being cancelled."
              required
              rows={4}
              value={remarks}
            />
          </label>
          <p className="subtle">3–1,000 characters. The same remark is recorded against every selected payment.</p>
          {error ? <div className="payout-inline-message error" role="alert">{error}</div> : null}
          <div className="form-actions">
            <button className="button secondary" disabled={busy} onClick={closeDialog} type="button">Keep processing</button>
            <button className="button" disabled={busy || remarks.trim().length < 3} onClick={cancelSelectedPayments} type="button">{busy ? "Cancelling…" : `Cancel ${items.length.toLocaleString("en-IN")} payment${items.length === 1 ? "" : "s"}`}</button>
          </div>
        </div>
      </section>
    </div>, document.body
  ) : null;

  return <>
    <button className="button secondary" disabled={busy || disabled || !items.length} onClick={showDialog} ref={triggerRef} type="button">Cancel processing{items.length ? ` (${items.length.toLocaleString("en-IN")})` : ""}</button>
    {modal}
  </>;
}
