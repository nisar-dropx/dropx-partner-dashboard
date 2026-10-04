"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  paymentAllocationDisplayStatus,
  type PaymentAllocationHistoryEntry
} from "@/lib/payment-allocation-history";

function money(value: number) {
  return `Rs ${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function readableDate(value: string) {
  if (!value) return "Ongoing";
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

function todayIso() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function statusTone(status: string) {
  if (status === "Current") return "good";
  if (status === "Scheduled") return "warn";
  return "payout-status-neutral";
}

function readableStoredStatus(value: string) {
  const normalized = value.trim().replace(/[_-]+/g, " ");
  return normalized ? normalized.replace(/\b\w/g, (character) => character.toUpperCase()) : "";
}

export function PaymentAllocationHistoryButton({
  entries,
  subjectLabel,
  buttonLabel = "History"
}: {
  entries: PaymentAllocationHistoryEntry[];
  subjectLabel: string;
  buttonLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    closeRef.current?.focus();
    function handleModalKeys(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(modalRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) ?? []);
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
    document.addEventListener("keydown", handleModalKeys);
    return () => {
      document.removeEventListener("keydown", handleModalKeys);
      trigger?.focus();
    };
  }, [open]);

  const today = todayIso();
  const modal = open && typeof document !== "undefined"
    ? createPortal(
      <div className="modal-backdrop payment-history-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}>
        <section aria-labelledby={titleId} aria-modal="true" className="modal-panel wide payment-history-modal" ref={modalRef} role="dialog">
          <div className="panel-head payment-history-head">
            <div>
              <h2 id={titleId}>Payment method history</h2>
              <p className="subtle">{subjectLabel}</p>
            </div>
            <button className="button secondary compact" onClick={() => setOpen(false)} ref={closeRef} type="button">Close</button>
          </div>
          <div className="payment-history-body">
            {entries.length ? <div className="payment-history-list">
              {entries.map((entry) => {
                const displayStatus = paymentAllocationDisplayStatus(entry, today);
                return <article className="payment-history-entry" key={entry.id}>
                  <div className="payment-history-entry-head">
                    <div>
                      <strong>{entry.paymentMethodName || "Payment method unavailable"}</strong>
                      <span>{readableDate(entry.effectiveFrom)} – {readableDate(entry.effectiveTo)}</span>
                    </div>
                    <span className={`status-pill ${statusTone(displayStatus)}`}>{displayStatus}</span>
                  </div>
                  <div className="payment-history-meta">
                    {entry.subjectLabel ? <span><b>DropX:</b> {entry.subjectLabel}</span> : null}
                    {entry.sourceLabel ? <span><b>Source:</b> {entry.sourceLabel}</span> : null}
                    {entry.locationLabel ? <span><b>Location:</b> {entry.locationLabel}</span> : null}
                    {readableStoredStatus(entry.storedStatus) ? <span><b>Recorded:</b> {readableStoredStatus(entry.storedStatus)}</span> : null}
                  </div>
                  <div className="payment-history-rates">
                    {entry.rates.length
                      ? entry.rates.map((rate) => <span key={`${entry.id}-${rate.code}`}><b>{rate.label}</b>{money(rate.value)}</span>)
                      : <span className="subtle">No configured rate values</span>}
                  </div>
                  {entry.reason ? <p className="payment-history-reason"><b>Reason:</b> {entry.reason}</p> : null}
                </article>;
              })}
            </div> : <div className="empty-state payment-history-empty"><strong>No saved payment history</strong><p className="subtle">A history entry will appear after a payment method is allocated.</p></div>}
          </div>
        </section>
      </div>,
      document.body
    )
    : null;

  return <>
    <button aria-expanded={open} aria-haspopup="dialog" className="button secondary compact payment-history-button" onClick={() => setOpen(true)} ref={triggerRef} type="button">
      {buttonLabel}{entries.length ? ` (${entries.length})` : ""}
    </button>
    {modal}
  </>;
}
