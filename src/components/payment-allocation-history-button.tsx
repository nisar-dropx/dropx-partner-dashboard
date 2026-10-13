"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  paymentAllocationDisplayStatus,
  type PaymentAllocationHistoryEntry
} from "@/lib/payment-allocation-history";

import { mappingAuditDateTime, type MappingAuditEvent } from "@/lib/provider-mapping-audit";

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
  buttonLabel = "History",
  loadMappingAudit = false
}: {
  entries: PaymentAllocationHistoryEntry[];
  subjectLabel: string;
  buttonLabel?: string;
  loadMappingAudit?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [audit, setAudit] = useState<Record<string, MappingAuditEvent[]>>({});
  const [auditError, setAuditError] = useState("");
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditRetry, setAuditRetry] = useState(0);
  const idsKey = entries.map(entry => entry.id).sort().join(",");
  useEffect(() => {
    if (!open || !loadMappingAudit || !idsKey) return;
    const controller = new AbortController();
    setAudit({}); setAuditError(""); setAuditLoading(true);
    // Bound each request; long-lived associates can have more than 100 versions.
    const ids = idsKey.split(",");
    void Promise.all(Array.from({length:Math.ceil(ids.length/100)},(_,index) => ids.slice(index*100,index*100+100)).map(async batch => {
      const response = await fetch(`/api/provider-mapping/history?ids=${encodeURIComponent(batch.join(","))}`, {cache:"no-store",signal:controller.signal});
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not load update history.");
      return body.audit as Record<string,MappingAuditEvent[]>;
    })).then(parts => { if (!controller.signal.aborted) setAudit(Object.assign({},...parts)); })
      .catch(error => { if (!controller.signal.aborted) setAuditError(error instanceof Error ? error.message : "Could not load update history."); })
      .finally(() => { if (!controller.signal.aborted) setAuditLoading(false); });
    return () => controller.abort();
  }, [open, loadMappingAudit, idsKey, auditRetry]);
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
            {auditLoading ? <p role="status">Loading update history…</p> : null}
            {auditError ? <p role="alert">{auditError} <button type="button" className="button secondary compact" onClick={() => setAuditRetry(value => value+1)}>Retry history</button></p> : null}
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
                  {entry.productionThreshold ? <p className="payment-history-reason">
                    <b>Combined minimum / {entry.productionThreshold.period}:</b>{" "}
                    {entry.productionThreshold.minimum_units.toLocaleString("en-IN")} units across{" "}
                    {entry.productionThreshold.component_codes.map((code) => entry.rates.find((rate) => rate.code === code)?.label ?? code).join(" + ")}
                  </p> : null}
                  {loadMappingAudit && !auditLoading && !auditError ? <div className="mapping-audit-list"><strong>Updated by · date and time</strong>{audit[entry.id]?.length ? audit[entry.id].map(event => <div key={event.id}><b>{event.action}</b> · {event.actor} · <time dateTime={event.at}>{mappingAuditDateTime(event.at)}</time></div>) : <span className="subtle">No updater information was recorded for this entry.</span>}</div> : null}
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
