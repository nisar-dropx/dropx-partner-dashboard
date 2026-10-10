"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import type { WorkforcePayoutBankRowSelection } from "@/lib/workforce-payout-action-selection";

export type WorkforcePayoutBankOption = {
  id: string;
  bankCode: string;
  displayName: string;
  accountNo: string;
  fileType: string;
};

function todayIso() {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Kolkata",
    year: "numeric"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function downloadName(header: string | null) {
  const encoded = header?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded); } catch { /* Use the plain fallback. */ }
  }
  return header?.match(/filename="?([^";]+)"?/i)?.[1] || "workforce-payout-bank-file.xlsx";
}

async function responseError(response: Response, fallback: string) {
  try {
    const payload = await response.json();
    return String(payload?.error || fallback);
  } catch {
    return fallback;
  }
}

export function WorkforcePayoutBankDialog({
  banks,
  disabled = false,
  onBusyChange,
  periodEnd,
  periodStart,
  publicationRefreshCount = 0,
  totalAmount,
  payoutRows
}: {
  banks: WorkforcePayoutBankOption[];
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  periodStart: string;
  periodEnd: string;
  publicationRefreshCount?: number;
  totalAmount: number;
  payoutRows: WorkforcePayoutBankRowSelection[];
}) {
  const router = useRouter();
  const titleId = useId();
  const [mode, setMode] = useState<"download" | "finalize" | null>(null);
  const [bankId, setBankId] = useState(banks.length === 1 ? banks[0].id : "");
  const [valueDate, setValueDate] = useState(todayIso());
  const [responseFile, setResponseFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const operationIdRef = useRef("");
  const responseOperationIdRef = useRef("");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLElement>(null);
  const selectedBank = useMemo(() => banks.find((bank) => bank.id === bankId), [bankId, banks]);

  useEffect(() => onBusyChange?.(busy), [busy, onBusyChange]);
  useEffect(() => {
    if (!mode) return;
    const trigger = triggerRef.current;
    closeRef.current?.focus();
    function handleKeys(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        setMode(null);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(modalRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      ) ?? [])];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    }
    document.addEventListener("keydown", handleKeys);
    return () => { document.removeEventListener("keydown", handleKeys); trigger?.focus(); };
  }, [busy, mode]);

  function open(nextMode: "download" | "finalize", trigger: HTMLButtonElement) {
    triggerRef.current = trigger;
    setError("");
    setNotice("");
    setMode(nextMode);
  }

  async function createBankFile() {
    if (busy || !selectedBank || !payoutRows.length) return;
    if (!operationIdRef.current) operationIdRef.current = crypto.randomUUID();
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/payments/workforce-payouts/bank-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bankId: selectedBank.id,
          operationId: operationIdRef.current,
          periodEnd,
          periodStart,
          payoutRows,
          valueDate,
        })
      });
      if (!response.ok) throw new Error(await responseError(response, "Unable to create the Workforce bank file."));
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = downloadName(response.headers.get("content-disposition"));
      link.click();
      URL.revokeObjectURL(href);
      operationIdRef.current = "";
      setMode(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to create the Workforce bank file.");
    } finally {
      setBusy(false);
      // A failed authoritative bank preflight can still follow a successful
      // publication refresh. Reload so repaired rows and any newly surfaced
      // blocker are never left stale in the table.
      router.refresh();
    }
  }

  async function finalizeResponse() {
    if (busy || !responseFile) return;
    if (!responseOperationIdRef.current) responseOperationIdRef.current = crypto.randomUUID();
    setBusy(true); setError(""); setNotice("");
    try {
      const body = new FormData();
      body.set("bank_response_file", responseFile);
      body.set("operation_id", responseOperationIdRef.current);
      const response = await fetch("/api/payments/workforce-payouts/bank-response", { method: "POST", body });
      if (!response.ok) throw new Error(await responseError(response, "Unable to finalize the Workforce bank response."));
      const payload = await response.json();
      responseOperationIdRef.current = "";
      setResponseFile(null);
      const finalizedCount = Number(payload.paid ?? 0) + Number(payload.cancelled ?? 0);
      const unresolvedCount = Number(payload.rejected ?? 0) + Number(payload.unknown ?? 0);
      const issueSummary = Array.isArray(payload.rows)
        ? payload.rows
          .filter((row: Record<string, unknown>) => ["rejected", "unknown"].includes(String(row?.outcome ?? "")))
          .slice(0, 3)
          .map((row: Record<string, unknown>) => `${String(row?.reference_no || `row ${row?.row_number ?? ""}`)}: ${String(row?.message || "not finalized")}`)
          .join("; ")
        : "";
      setNotice(
        `Finalized ${Number(payload.paid ?? 0)} paid and ${Number(payload.cancelled ?? 0)} cancelled payment${finalizedCount === 1 ? "" : "s"}.${unresolvedCount ? ` ${unresolvedCount} response row${unresolvedCount === 1 ? " was" : "s were"} not finalized; correct those rows and upload a new response file.${issueSummary ? ` ${issueSummary}` : ""}` : ""}`
      );
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to finalize the Workforce bank response.");
    } finally {
      setBusy(false);
    }
  }

  const modal = mode && typeof document !== "undefined" ? createPortal(
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setMode(null); }}>
      <section aria-labelledby={titleId} aria-modal="true" className="modal-panel" ref={modalRef} role="dialog">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Workforce payments</p>
            <h2 id={titleId}>{mode === "download" ? "Download bank file" : "Finalize bank payments"}</h2>
          </div>
          <button className="button secondary compact" disabled={busy} onClick={() => setMode(null)} ref={closeRef} type="button">Close</button>
        </div>
        <div className="panel-body">
          {mode === "download" ? <>
            <div className="payout-inline-message warn">
              <strong>Payment Processing lock</strong>
              <p>Generating this file marks {payoutRows.length} selected payout row{payoutRows.length === 1 ? "" : "s"} as Payment Processing. Payout inputs and ID mapping for those profiles cannot change until the bank response is finalized.</p>
              <p>Only current Active Workforce profiles are eligible. Under Review and every other profile status are excluded.</p>
              <p>Only the checked payout row and its location balance are included. Other rows for the same DropX ID remain outside this bank file.</p>
            </div>
            {publicationRefreshCount ? <div className="payout-inline-message warn" role="status">
              <strong>Refresh before file generation</strong>
              <p>{publicationRefreshCount} selected payout row{publicationRefreshCount === 1 ? " has" : "s have"} a pending publication refresh. The server will refresh the exact selected month first, then recheck each selected location balance and every payment blocker. File generation stops if any selected publication remains stale or another blocker is found.</p>
            </div> : null}
            <div className="form-grid two">
              <label>Debit bank
                <select className="field" disabled={busy} onChange={(event) => setBankId(event.target.value)} required value={bankId}>
                  <option value="">Select bank</option>
                  {banks.map((bank) => <option key={bank.id} value={bank.id}>{bank.displayName} · {bank.accountNo}</option>)}
                </select>
              </label>
              <label>File type<input className="field" readOnly value={selectedBank?.fileType?.toLowerCase() === "fedone" ? "Federal Bank - FedOne" : selectedBank ? "Not configured" : "Select bank"} /></label>
              <label>Value date<input className="field" disabled={busy} onChange={(event) => setValueDate(event.target.value)} required type="date" value={valueDate} /></label>
              <label>Selected payout rows<input className="field" readOnly value={payoutRows.length.toLocaleString("en-IN")} /></label>
              <label>{publicationRefreshCount ? "Preliminary selected balance" : "Balance in this file"}<input className="field" readOnly value={`Rs ${Number(totalAmount || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} /></label>
            </div>
          </> : <>
            <p className="subtle">Upload the bank Transaction Enquiry Excel file. Paid rows require a UTR/CIN; cancelled rows release the processing lock for a new payment version.</p>
            <label>Bank response file
              <input accept=".xlsx,.xls" className="field" disabled={busy} onChange={(event) => { setResponseFile(event.target.files?.[0] ?? null); responseOperationIdRef.current = ""; }} required type="file" />
            </label>
          </>}
          {error ? <div className="payout-inline-message error" role="alert">{error}</div> : null}
          {notice ? <div className="payout-inline-message success" role="status">{notice}</div> : null}
          <div className="form-actions">
            <button className="button secondary" disabled={busy} onClick={() => setMode(null)} type="button">Cancel</button>
            <button className="button" disabled={busy || (mode === "download" ? !selectedBank || selectedBank.fileType.toLowerCase() !== "fedone" || !valueDate : !responseFile)} onClick={mode === "download" ? createBankFile : finalizeResponse} type="button">
              {busy ? mode === "download" ? publicationRefreshCount ? "Refreshing & creating…" : "Creating…" : "Finalizing…" : mode === "download" ? publicationRefreshCount ? "Refresh, create & download" : "Create & download" : "Finalize response"}
            </button>
          </div>
        </div>
      </section>
    </div>, document.body
  ) : null;

  return <>
    <button className="button secondary" disabled={disabled || !payoutRows.length || !banks.length || busy} onClick={(event) => open("download", event.currentTarget)} type="button">Download bank file{payoutRows.length ? ` (${payoutRows.length})` : ""}</button>
    <button className="button secondary" disabled={disabled || busy} onClick={(event) => open("finalize", event.currentTarget)} type="button">Finalize bank response</button>
    {modal}
  </>;
}
