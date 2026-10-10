"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

type PaymentHistoryEntry = {
  id: string;
  batchId: string;
  referenceNo: string;
  version: number;
  amount: number;
  status: string;
  bankName: string;
  maskedAccount: string;
  locationCode: string;
  locationName: string;
  utr: string;
  remarks: string;
  generatedAt: string;
  finalizedAt: string;
  redownloadable: boolean;
};

type PaymentHoldEvent = {
  id: string;
  action: "hold" | "release";
  remarks: string;
  createdAt: string;
};

type PaymentHoldState = {
  onHold: boolean;
  latestRemark: string;
  events: PaymentHoldEvent[];
};

type PendingAction = {
  action: "failed" | "cancelled" | "hold" | "release_hold";
  operationId: string;
  paymentItemId?: string;
  title: string;
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

function statusTone(status: string) {
  if (status === "paid") return "good";
  if (status === "processing") return "warn";
  return "bad";
}

function locationLabel(entry: PaymentHistoryEntry) {
  const code = String(entry.locationCode ?? "").trim();
  const name = String(entry.locationName ?? "").trim();
  if (code && name && code.toLocaleLowerCase() !== name.toLocaleLowerCase()) return `${code} · ${name}`;
  return code || name || "—";
}

export function WorkforcePayoutPaymentHistoryButton({
  canManageStatus,
  historyCount,
  periodEnd,
  periodStart,
  stationId,
  subjectLabel,
  workforceId
}: {
  canManageStatus: boolean;
  historyCount: number;
  periodStart: string;
  periodEnd: string;
  stationId: string;
  subjectLabel: string;
  workforceId: string;
}) {
  const router = useRouter();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [entries, setEntries] = useState<PaymentHistoryEntry[]>([]);
  const [hold, setHold] = useState<PaymentHoldState>({ onHold: false, latestRemark: "", events: [] });
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [remarks, setRemarks] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLElement>(null);

  const loadHistory = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ workforceId, stationId, periodStart, periodEnd });
      const response = await fetch(`/api/payments/workforce-payouts/payment-history?${query}`, { signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Unable to load payment history.");
      setEntries(Array.isArray(payload?.items) ? payload.items : []);
      setHold({
        onHold: payload?.hold?.onHold === true,
        latestRemark: String(payload?.hold?.latestRemark ?? ""),
        events: Array.isArray(payload?.hold?.events) ? payload.hold.events : []
      });
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "Unable to load payment history.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [periodEnd, periodStart, stationId, workforceId]);

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    closeRef.current?.focus();
    const controller = new AbortController();
    void loadHistory(controller.signal);
    function handleKeys(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); return; }
      if (event.key !== "Tab") return;
      const focusable = [...(modalRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", handleKeys);
    return () => { controller.abort(); document.removeEventListener("keydown", handleKeys); trigger?.focus(); };
  }, [loadHistory, open]);

  function chooseAction(action: PendingAction["action"], title: string, paymentItemId?: string) {
    if (!canManageStatus) return;
    setPendingAction({ action, title, paymentItemId, operationId: crypto.randomUUID() });
    setRemarks("");
    setError("");
    setNotice("");
  }

  async function submitAction() {
    if (!canManageStatus || !pendingAction || actionBusy || remarks.trim().length < 3) return;
    setActionBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/payments/workforce-payouts/payment-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: pendingAction.action,
          operationId: pendingAction.operationId,
          paymentItemId: pendingAction.paymentItemId,
          workforceId,
          periodStart,
          periodEnd,
          remarks: remarks.trim()
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Unable to update the payment status.");
      const message = pendingAction.action === "hold"
        ? "Payment placed on hold."
        : pendingAction.action === "release_hold"
          ? "Payment hold released."
          : pendingAction.action === "failed"
            ? "Payment marked as failed."
            : "Payment marked as cancelled.";
      setPendingAction(null);
      setRemarks("");
      setNotice(message);
      await loadHistory();
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to update the payment status.");
    } finally {
      setActionBusy(false);
    }
  }

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
          {notice ? <div className="payout-inline-message success" role="status">{notice}</div> : null}
          {!loading ? <div className={`payout-inline-message ${hold.onHold ? "warn" : ""}`}>
            <div>
              <strong>{hold.onHold ? "Payment On Hold" : "Payment is not on hold"}</strong>
              {hold.latestRemark ? <p>{hold.latestRemark}</p> : null}
            </div>
            {canManageStatus ? <button
              className="button secondary compact"
              disabled={actionBusy}
              onClick={() => chooseAction(
                hold.onHold ? "release_hold" : "hold",
                hold.onHold ? "Release payment hold" : "Mark payment on hold"
              )}
              type="button"
            >{hold.onHold ? "Release hold" : "Mark on hold"}</button> : null}
          </div> : null}
          {canManageStatus && pendingAction ? <div className="payout-inline-message warn">
            <strong>{pendingAction.title}</strong>
            <p>This change is audited. Enter the reason before confirming.</p>
            <label>Mandatory remarks
              <textarea
                autoFocus
                className="field"
                disabled={actionBusy}
                maxLength={1000}
                minLength={3}
                onChange={(event) => setRemarks(event.target.value)}
                required
                rows={3}
                value={remarks}
              />
            </label>
            <div className="form-actions">
              <button className="button secondary compact" disabled={actionBusy} onClick={() => { setPendingAction(null); setRemarks(""); }} type="button">Cancel</button>
              <button className="button compact" disabled={actionBusy || remarks.trim().length < 3} onClick={submitAction} type="button">{actionBusy ? "Saving…" : "Confirm"}</button>
            </div>
          </div> : null}
          {!loading && !error && entries.length ? <div className="table-wrap"><table>
            <thead><tr><th>Reference</th><th>Location</th><th>Amount</th><th>Status</th><th>Bank / account</th><th>UTR/CIN</th><th>Generated</th><th>Finalized</th><th>Remarks</th>{canManageStatus ? <th>Action</th> : null}</tr></thead>
            <tbody>{entries.map((entry) => <tr key={entry.id}>
              <td><strong>{entry.referenceNo}</strong><small>Version {entry.version}</small>{entry.redownloadable ? <a className="inline-link" href={`/api/payments/workforce-payouts/bank-file?batch_id=${encodeURIComponent(entry.batchId)}`}>Download again</a> : null}</td>
              <td>{locationLabel(entry)}</td>
              <td>{money(entry.amount)}</td>
              <td><span className={`status-pill ${statusTone(entry.status)}`}>{titleStatus(entry.status)}</span></td>
              <td>{entry.bankName || "—"}<small>{entry.maskedAccount || "—"}</small></td>
              <td>{entry.utr || "—"}</td>
              <td>{dateTime(entry.generatedAt)}</td>
              <td>{dateTime(entry.finalizedAt)}</td>
              <td>{entry.remarks || "—"}</td>
              {canManageStatus ? <td>{entry.status === "processing" ? <div className="payout-detail-actions">
                <button className="button secondary compact" disabled={actionBusy} onClick={() => chooseAction("failed", `Mark ${entry.referenceNo} as Payment Failed`, entry.id)} type="button">Failed</button>
                <button className="button secondary compact" disabled={actionBusy} onClick={() => chooseAction("cancelled", `Mark ${entry.referenceNo} as Payment Cancelled`, entry.id)} type="button">Cancelled</button>
              </div> : <span aria-hidden="true">—</span>}</td> : null}
            </tr>)}</tbody>
          </table></div> : null}
          {!loading && !error && !entries.length ? <div className="empty-state payment-history-empty"><strong>No bank payments yet</strong><p className="subtle">Payment versions appear here after a bank file is generated.</p></div> : null}
          {!loading && hold.events.length ? <details>
            <summary>Hold history ({hold.events.length})</summary>
            <div className="table-wrap"><table><thead><tr><th>Action</th><th>Changed on</th><th>Remarks</th></tr></thead><tbody>
              {hold.events.map((event) => <tr key={event.id}><td>{event.action === "hold" ? "Placed on hold" : "Hold released"}</td><td>{dateTime(event.createdAt)}</td><td>{event.remarks}</td></tr>)}
            </tbody></table></div>
          </details> : null}
        </div>
      </section>
    </div>, document.body
  ) : null;

  return <>
    <button aria-expanded={open} aria-haspopup="dialog" className="button secondary compact" onClick={() => { setPendingAction(null); setRemarks(""); setNotice(""); setOpen(true); }} ref={triggerRef} type="button">Payment history{historyCount ? ` (${historyCount})` : ""}</button>
    {modal}
  </>;
}
