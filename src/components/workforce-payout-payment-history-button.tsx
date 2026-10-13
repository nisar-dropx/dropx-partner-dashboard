"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

type PaymentHistoryProfile = {
  workforceId: string;
  dropxId: string;
  name: string;
};

type PaymentHistoryCreditTransfer = {
  wasTransferred: true;
  direction: "in" | "returned";
  allocationCount: number;
  transferredAmount: number;
  transferredAt: string;
  original: PaymentHistoryProfile;
  credited: PaymentHistoryProfile;
};

type PaymentHistoryEntry = {
  id: string;
  batchId: string;
  referenceNo: string;
  version: number;
  amount: number;
  instructionAmount?: number;
  maxAmount?: number;
  status: string;
  debitAccount?: string;
  maskedDebitAccount?: string;
  creditAccount: string;
  creditIfsc: string;
  locationCode: string;
  utr: string;
  valueDate: string;
  bankRemarks?: string;
  responseRemarks?: string;
  finalizationRemarks?: string;
  remarks: string;
  generatedAt: string;
  finalizedAt: string;
  redownloadable: boolean;
  creditTransfer: PaymentHistoryCreditTransfer | null;
};

type PaymentCreditTransferEvent = {
  id: string;
  decisionId: string;
  paymentItemId: string;
  sourceWorkforceId: string;
  destinationWorkforceId: string;
  stationId: string;
  periodStart: string;
  periodEnd: string;
  amount: number;
  referenceNo: string;
  utr: string;
  createdAt: string;
  allocationCount: number;
  direction: "out";
  source: PaymentHistoryProfile;
  destination: PaymentHistoryProfile;
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
  action: "failed" | "cancelled" | "finalize";
  operationId: string;
  paymentItemId?: string;
  title: string;
  entry?: PaymentHistoryEntry;
};

type FinalizeFields = {
  amount: string;
  debitAccount: string;
  creditAccount: string;
  creditIfsc: string;
  valueDate: string;
  utrCin: string;
  bankRemarks: string;
};

const emptyFinalizeFields: FinalizeFields = {
  amount: "",
  debitAccount: "",
  creditAccount: "",
  creditIfsc: "",
  valueDate: "",
  utrCin: "",
  bankRemarks: ""
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
  if (status === "processing" || status === "partially_paid") return "warn";
  return "bad";
}

function maskedDebitAccount(value: string) {
  const account = String(value ?? "").replace(/[\u200B-\u200D\uFEFF\s]/g, "");
  return account ? `••••${account.slice(-4)}` : "—";
}

function finalizableAmount(entry: PaymentHistoryEntry) {
  return Number(entry.maxAmount ?? entry.instructionAmount ?? entry.amount ?? 0);
}

function debitAccountDisplay(entry: PaymentHistoryEntry) {
  return entry.maskedDebitAccount || maskedDebitAccount(entry.debitAccount || "");
}

function bankRemarksDisplay(entry: PaymentHistoryEntry) {
  return entry.bankRemarks || entry.responseRemarks || "—";
}

function finalizationRemarksDisplay(entry: PaymentHistoryEntry) {
  return entry.finalizationRemarks || entry.remarks || "—";
}

function dateOnly(value: string) {
  if (!value) return "—";
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "UTC" });
}

function profileLabel(profile: PaymentHistoryProfile) {
  const dropxId = String(profile.dropxId ?? "").trim();
  const name = String(profile.name ?? "").trim();
  if (dropxId && name) return `${dropxId} · ${name}`;
  return dropxId || name || "another Workforce profile";
}

export function WorkforcePayoutPaymentHistoryButton({
  audience = "workforce",
  canManageStatus,
  historyCount,
  periodEnd,
  periodStart,
  stationId,
  subjectLabel,
  workforceId
}: {
  audience?: "workforce" | "helpers";
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
  const [creditTransfers, setCreditTransfers] = useState<PaymentCreditTransferEvent[]>([]);
  const [hold, setHold] = useState<PaymentHoldState>({ onHold: false, latestRemark: "", events: [] });
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [finalizeFields, setFinalizeFields] = useState<FinalizeFields>(emptyFinalizeFields);
  const [remarks, setRemarks] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLElement>(null);

  const loadHistory = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ audience, workforceId, stationId, periodStart, periodEnd });
      const response = await fetch(`/api/payments/workforce-payouts/payment-history?${query}`, {
        cache: "no-store",
        signal
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Unable to load payment history.");
      setEntries(Array.isArray(payload?.items) ? payload.items : []);
      setCreditTransfers(Array.isArray(payload?.creditTransfers) ? payload.creditTransfers : []);
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
  }, [audience, periodEnd, periodStart, stationId, workforceId]);

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

  function chooseAction(action: "failed" | "cancelled", title: string, paymentItemId?: string) {
    if (!canManageStatus) return;
    setPendingAction({ action, title, paymentItemId, operationId: crypto.randomUUID() });
    setFinalizeFields(emptyFinalizeFields);
    setRemarks("");
    setError("");
    setNotice("");
  }

  function chooseFinalize(entry: PaymentHistoryEntry) {
    if (!canManageStatus) return;
    setPendingAction({
      action: "finalize",
      title: `Finalize ${entry.referenceNo} manually`,
      paymentItemId: entry.id,
      operationId: crypto.randomUUID(),
      entry
    });
    const debitAccount = String(entry.debitAccount ?? "").trim();
    setFinalizeFields({
      amount: String(finalizableAmount(entry) || ""),
      // The history endpoint normally exposes only the last four digits. Never
      // submit that masked display value as bank evidence; require the operator
      // to enter the actual debit account used for this settlement.
      debitAccount: debitAccount.includes("•") ? "" : debitAccount,
      creditAccount: entry.creditAccount || "",
      creditIfsc: entry.creditIfsc || "",
      valueDate: entry.valueDate?.slice(0, 10) || "",
      utrCin: "",
      bankRemarks: entry.bankRemarks || entry.responseRemarks || ""
    });
    setRemarks("");
    setError("");
    setNotice("");
  }

  function setFinalizeField(field: keyof FinalizeFields, value: string) {
    setFinalizeFields((current) => ({ ...current, [field]: value }));
  }

  function validFinalizeFields() {
    if (!pendingAction?.entry) return false;
    const amount = Number(finalizeFields.amount);
    const maximum = finalizableAmount(pendingAction.entry);
    return Number.isFinite(amount)
      && amount > 0
      && Number.isFinite(maximum)
      && amount <= maximum
      && /^\d+(?:\.\d{1,2})?$/.test(finalizeFields.amount.trim())
      && Boolean(finalizeFields.debitAccount.trim())
      && Boolean(finalizeFields.creditAccount.trim())
      && Boolean(finalizeFields.creditIfsc.trim())
      && /^\d{4}-\d{2}-\d{2}$/.test(finalizeFields.valueDate)
      && Boolean(finalizeFields.utrCin.trim())
      && finalizeFields.bankRemarks.trim().length >= 3
      && remarks.trim().length >= 3;
  }

  async function submitAction() {
    if (!canManageStatus || !pendingAction || actionBusy || remarks.trim().length < 3) return;
    if (pendingAction.action === "finalize" && !validFinalizeFields()) return;
    setActionBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/payments/workforce-payouts/payment-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: pendingAction.action,
          audience,
          operationId: pendingAction.operationId,
          paymentItemId: pendingAction.paymentItemId,
          workforceId,
          periodStart,
          periodEnd,
          ...(pendingAction.action === "finalize" ? finalizeFields : {}),
          remarks: remarks.trim()
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Unable to update the payment status.");
      const finalStatus = String(payload?.status ?? payload?.outcome ?? "").toLowerCase();
      const message = pendingAction.action === "failed"
        ? "Payment marked as failed."
        : pendingAction.action === "cancelled"
          ? "Payment marked as cancelled."
          : finalStatus.includes("partial")
            ? "Payment finalized as partially paid. The unpaid balance remains payable."
            : "Payment finalized as paid.";
      setPendingAction(null);
      setFinalizeFields(emptyFinalizeFields);
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
              <strong>{hold.onHold ? "On Hold" : "Payment is not on hold"}</strong>
              {hold.latestRemark ? <p>{hold.latestRemark}</p> : null}
            </div>
          </div> : null}
          {canManageStatus && pendingAction ? <div className="payout-inline-message warn">
            <strong>{pendingAction.title}</strong>
            <p>{pendingAction.action === "finalize"
              ? `Enter the actual bank-payment details. The paid amount cannot exceed ${money(pendingAction.entry ? finalizableAmount(pendingAction.entry) : 0)}; a lower amount leaves the balance payable and marks the payout Partially Paid.`
              : "This change is audited. Enter the reason before confirming."}</p>
            {pendingAction.action === "finalize" ? <div className="form-grid three">
              <label>Paid amount
                <input
                  autoFocus
                  className="field"
                  disabled={actionBusy}
                  inputMode="decimal"
                  max={pendingAction.entry ? finalizableAmount(pendingAction.entry) : undefined}
                  min="0.01"
                  onChange={(event) => setFinalizeField("amount", event.target.value)}
                  required
                  step="0.01"
                  type="number"
                  value={finalizeFields.amount}
                />
              </label>
              <label>Debit account
                <input className="field" disabled={actionBusy} maxLength={128} onChange={(event) => setFinalizeField("debitAccount", event.target.value)} required type="text" value={finalizeFields.debitAccount} />
              </label>
              <label>Credit account
                <input className="field" disabled={actionBusy} maxLength={128} onChange={(event) => setFinalizeField("creditAccount", event.target.value)} required type="text" value={finalizeFields.creditAccount} />
              </label>
              <label>Credit IFSC
                <input className="field" disabled={actionBusy} maxLength={64} onChange={(event) => setFinalizeField("creditIfsc", event.target.value)} required type="text" value={finalizeFields.creditIfsc} />
              </label>
              <label>UTR/CIN
                <input className="field" disabled={actionBusy} maxLength={200} onChange={(event) => setFinalizeField("utrCin", event.target.value)} required type="text" value={finalizeFields.utrCin} />
              </label>
              <label>Value date
                <input className="field" disabled={actionBusy} onChange={(event) => setFinalizeField("valueDate", event.target.value)} required type="date" value={finalizeFields.valueDate} />
              </label>
              <label>Bank remarks
                <input className="field" disabled={actionBusy} maxLength={1000} onChange={(event) => setFinalizeField("bankRemarks", event.target.value)} required type="text" value={finalizeFields.bankRemarks} />
              </label>
            </div> : null}
            <label>Mandatory remarks
              <textarea
                autoFocus={pendingAction.action !== "finalize"}
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
              <button className="button secondary compact" disabled={actionBusy} onClick={() => { setPendingAction(null); setFinalizeFields(emptyFinalizeFields); setRemarks(""); }} type="button">Cancel</button>
              <button className="button compact" disabled={actionBusy || (pendingAction.action === "finalize" ? !validFinalizeFields() : remarks.trim().length < 3)} onClick={submitAction} type="button">{actionBusy ? "Saving…" : pendingAction.action === "finalize" ? "Finalize payment" : "Confirm"}</button>
            </div>
          </div> : null}
          {!loading && !error && entries.length ? <div className="table-wrap"><table>
            <thead><tr><th>Reference</th><th>Location</th><th>Amount</th><th>Status</th><th>Debit A/c</th><th>Credit A/c</th><th>Credit IFSC</th><th>UTR/CIN</th><th>Value Date</th><th>Bank remarks</th><th>Generated on</th><th>Finalized on</th><th>Remarks</th>{canManageStatus ? <th>Action</th> : null}</tr></thead>
            <tbody>{entries.map((entry) => <tr key={entry.id}>
              <td><strong>{entry.referenceNo}</strong><small>Version {entry.version}</small>{entry.creditTransfer ? <><small><strong>Paid credit transferred in</strong>{entry.creditTransfer.transferredAt ? ` · ${dateTime(entry.creditTransfer.transferredAt)}` : ""}</small><small>Originally paid to {profileLabel(entry.creditTransfer.original)}. The original reference and UTR are unchanged.</small></> : null}{canManageStatus && entry.redownloadable ? <a className="inline-link" href={`/api/payments/workforce-payouts/bank-file?audience=${encodeURIComponent(audience)}&batch_id=${encodeURIComponent(entry.batchId)}`}>Download again</a> : null}</td>
              <td>{entry.locationCode || "—"}</td>
              <td>{money(entry.amount)}</td>
              <td><span className={`status-pill ${statusTone(entry.status)}`}>{titleStatus(entry.status)}</span></td>
              <td>{debitAccountDisplay(entry)}</td>
              <td>{entry.creditAccount || "—"}</td>
              <td>{entry.creditIfsc || "—"}</td>
              <td>{entry.utr || "—"}</td>
              <td>{dateOnly(entry.valueDate)}</td>
              <td>{bankRemarksDisplay(entry)}</td>
              <td>{dateTime(entry.generatedAt)}</td>
              <td>{dateTime(entry.finalizedAt)}</td>
              <td>{finalizationRemarksDisplay(entry)}</td>
              {canManageStatus ? <td>{entry.status === "processing" ? <div className="payout-detail-actions">
                <button className="button compact" disabled={actionBusy} onClick={() => chooseFinalize(entry)} type="button">Finalize</button>
                <button className="button secondary compact" disabled={actionBusy} onClick={() => chooseAction("failed", `Mark ${entry.referenceNo} as Payment Failed`, entry.id)} type="button">Failed</button>
                <button className="button secondary compact" disabled={actionBusy} onClick={() => chooseAction("cancelled", `Mark ${entry.referenceNo} as Payment Cancelled`, entry.id)} type="button">Cancelled</button>
              </div> : <span aria-hidden="true">—</span>}</td> : null}
            </tr>)}</tbody>
          </table></div> : null}
          {!loading && !error && !entries.length && !creditTransfers.length ? <div className="empty-state payment-history-empty"><strong>No bank payments yet</strong><p className="subtle">Payment versions appear here after a bank file is generated.</p></div> : null}
          {!loading && !error && !entries.length && creditTransfers.length ? <div className="payout-inline-message"><strong>No currently owned bank payment for this period</strong><p>The previously paid credit was transferred to another DropX ID. Its audit trail is shown below.</p></div> : null}
          {!loading && !error && creditTransfers.length ? <details open>
            <summary>Paid-credit transfer audit ({creditTransfers.length})</summary>
            <div className="table-wrap"><table><thead><tr><th>Reference</th><th>Amount</th><th>Status</th><th>Transferred to</th><th>UTR/CIN</th><th>Transferred on</th></tr></thead><tbody>
              {creditTransfers.map((transfer) => <tr key={transfer.id}>
                <td><strong>{transfer.referenceNo}</strong><small>Original bank reference</small></td>
                <td>{money(transfer.amount)}</td>
                <td><span className="status-pill warn">Credit transferred out</span></td>
                <td>{profileLabel(transfer.destination)}<small>The bank payment itself was not changed.</small></td>
                <td>{transfer.utr || "—"}</td>
                <td>{dateTime(transfer.createdAt)}</td>
              </tr>)}
            </tbody></table></div>
          </details> : null}
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
    <button aria-expanded={open} aria-haspopup="dialog" className="button secondary compact" onClick={() => { setPendingAction(null); setFinalizeFields(emptyFinalizeFields); setRemarks(""); setNotice(""); setOpen(true); }} ref={triggerRef} type="button">Payment history{historyCount ? ` (${historyCount})` : ""}</button>
    {modal}
  </>;
}
