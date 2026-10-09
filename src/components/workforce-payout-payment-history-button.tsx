"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

type PaymentHistoryEntry = {
  id: string;
  batchId: string;
  referenceNo: string;
  version: number;
  amount: number;
  status: string;
  bankName: string;
  maskedAccount: string;
  utr: string;
  remarks: string;
  generatedAt: string;
  finalizedAt: string;
  redownloadable: boolean;
};

function money(value: number) {
  return `Rs ${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function dateTime(value: string) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function titleStatus(value: string) {
  return value.trim().replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function WorkforcePayoutPaymentHistoryButton({
  historyCount,
  periodEnd,
  periodStart,
  subjectLabel,
  workforceId
}: {
  historyCount: number;
  periodStart: string;
  periodEnd: string;
  subjectLabel: string;
  workforceId: string;
}) {
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [entries, setEntries] = useState<PaymentHistoryEntry[]>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    closeRef.current?.focus();
    const controller = new AbortController();
    setLoading(true); setError("");
    const query = new URLSearchParams({ workforceId, periodStart, periodEnd });
    fetch(`/api/payments/workforce-payouts/payment-history?${query}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.error || "Unable to load payment history.");
        setEntries(Array.isArray(payload?.items) ? payload.items : []);
      })
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "Unable to load payment history.");
      })
      .finally(() => setLoading(false));
    function handleKeys(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); return; }
      if (event.key !== "Tab") return;
      const focusable = [...(modalRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])') ?? [])];
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", handleKeys);
    return () => { controller.abort(); document.removeEventListener("keydown", handleKeys); trigger?.focus(); };
  }, [open, periodEnd, periodStart, workforceId]);

  const modal = open && typeof document !== "undefined" ? createPortal(
    <div className="modal-backdrop payment-history-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section aria-labelledby={titleId} aria-modal="true" className="modal-panel wide payment-history-modal" ref={modalRef} role="dialog">
        <div className="panel-head payment-history-head">
          <div><h2 id={titleId}>Bank payment history</h2><p className="subtle">{subjectLabel} · {periodStart.slice(0, 7)}</p></div>
          <button className="button secondary compact" onClick={() => setOpen(false)} ref={closeRef} type="button">Close</button>
        </div>
        <div className="payment-history-body">
          {loading ? <p className="subtle">Loading payment history…</p> : null}
          {error ? <div className="payout-inline-message error" role="alert">{error}</div> : null}
          {!loading && !error && entries.length ? <div className="table-wrap"><table>
            <thead><tr><th>Reference</th><th>Amount</th><th>Status</th><th>Bank / account</th><th>UTR/CIN</th><th>Generated</th><th>Finalized</th><th>Remarks</th></tr></thead>
            <tbody>{entries.map((entry) => <tr key={entry.id}>
              <td><strong>{entry.referenceNo}</strong><small>Version {entry.version}</small>{entry.redownloadable ? <a className="inline-link" href={`/api/payments/workforce-payouts/bank-file?batch_id=${encodeURIComponent(entry.batchId)}`}>Download again</a> : null}</td>
              <td>{money(entry.amount)}</td>
              <td><span className={`status-pill ${entry.status === "paid" ? "good" : entry.status === "processing" ? "warn" : "bad"}`}>{titleStatus(entry.status)}</span></td>
              <td>{entry.bankName || "—"}<small>{entry.maskedAccount || "—"}</small></td>
              <td>{entry.utr || "—"}</td>
              <td>{dateTime(entry.generatedAt)}</td>
              <td>{dateTime(entry.finalizedAt)}</td>
              <td>{entry.remarks || "—"}</td>
            </tr>)}</tbody>
          </table></div> : null}
          {!loading && !error && !entries.length ? <div className="empty-state payment-history-empty"><strong>No bank payments yet</strong><p className="subtle">Payment versions appear here after a bank file is generated.</p></div> : null}
        </div>
      </section>
    </div>, document.body
  ) : null;

  return <>
    <button aria-expanded={open} aria-haspopup="dialog" className="button secondary compact" onClick={() => setOpen(true)} ref={triggerRef} type="button">Payment history{historyCount ? ` (${historyCount})` : ""}</button>
    {modal}
  </>;
}
