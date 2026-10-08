"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type RecoveryPreviewRow = {
  rowNumber: number;
  tid: string;
  providerCode: string;
  providerName: string;
  location: string;
  debitMonth: string;
  debitAmount: number;
  recoveryMethod: string;
  recoveryIds: string[];
  allocationCount: number;
  linkStatus: string;
};

type RecoveryPreview = {
  error?: string;
  message?: string;
  batchId?: string;
  fileName?: string;
  fileSha256?: string;
  totalRows?: number;
  payoutRows?: number;
  disputeRows?: number;
  linkedAllocations?: number;
  pendingAllocations?: number;
  canCommit?: boolean;
  issues?: Array<{ rowNumber: number | null; tid: string | null; message: string }>;
  rows?: RecoveryPreviewRow[];
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

async function readResponse(response: Response): Promise<RecoveryPreview> {
  const text = await response.text();
  try { return JSON.parse(text) as RecoveryPreview; } catch { return { error: `The server returned an unreadable response (HTTP ${response.status}).` }; }
}

function money(value: number) {
  return `Rs ${Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function monthLabel(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})/);
  if (!match) return value || "—";
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? `${MONTH_NAMES[month - 1]}-${match[1].slice(-2)}` : value;
}

function routeLabel(value: string) {
  const normalized = value.toLowerCase();
  if (normalized === "payout_deduction") return "Payout deduction";
  if (normalized === "post_invoice_dispute") return "Post-invoice provider dispute";
  return value.replaceAll("_", " ");
}

function linkLabel(value: string) {
  if (value === "linked") return "Linked";
  if (value === "pending") return "Awaiting registration";
  if (value === "mixed") return "Linked + awaiting registration";
  return value === "not_applicable" || value === "not_required" ? "Not applicable" : value.replaceAll("_", " ");
}

export function PaymentRecoveryBulkUpload() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<RecoveryPreview | null>(null);
  const [busy, setBusy] = useState<"preview" | "commit" | null>(null);
  const [error, setError] = useState("");

  async function submit(mode: "preview" | "commit") {
    if (!file) {
      setError("Choose the completed Payment Recovery workbook first.");
      return;
    }
    if (mode === "commit" && !window.confirm(
      `Add ${preview?.totalRows ?? 0} TID-level recovery plans to the register?\n\n` +
      "This stores the provider debit month, selected recovery route, and equal allocations. It does not deduct a payout or file a provider dispute. Existing recovery cases will not be changed."
    )) return;

    setBusy(mode);
    setError("");
    try {
      const body = new FormData();
      body.set("mode", mode);
      body.set("file", file);
      const response = await fetch("/api/payments/recoveries/bulk-upload", { method: "POST", body });
      const payload = await readResponse(response);
      setPreview(payload);
      if (!response.ok) throw new Error(payload.error ?? "Unable to process the recovery workbook.");
      if (mode === "commit") router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to process the recovery workbook.");
    } finally {
      setBusy(null);
    }
  }

  return <div className="workforce-advance-upload">
    <button className="button" onClick={() => setOpen((value) => !value)} type="button">{open ? "Close upload" : "Bulk upload"}</button>
    {open ? <section className="panel compensation-import-panel">
      <div className="panel-head"><div><h2>Bulk upload payment recoveries</h2><p className="subtle">Preview TID-level provider debits and their recovery route before adding them to the register.</p></div><a className="template-download-link" download href="/api/payments/recoveries/bulk-upload/template">Download Excel template</a></div>
      <div className="compensation-import-body">
        <div className="compensation-import-controls"><label><span>Recovery workbook</span><input accept=".xlsx,.xls,.csv" className="field compensation-file-input" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); setError(""); }} type="file" /></label><button className="button secondary" disabled={Boolean(busy)} onClick={() => submit("preview")} type="button">{busy === "preview" ? "Checking…" : "Preview and validate"}</button></div>
        <p className="compensation-match-rule"><strong>How it works:</strong> use one row per TID. Enter the LOCATION and DEBIT_MONTH in MMM-YY format, such as Jul-26; the provider is taken automatically from the location setup. PROVIDER_REFERENCE is optional. Choose PAYOUT_DEDUCTION and list one or more RECOVERY_IDS to split the debit equally, or choose POST_INVOICE_DISPUTE and leave RECOVERY_IDS blank. Unregistered eligible IDs remain visible as awaiting registration. This upload creates a recovery plan only; it does not deduct a payment or submit a provider dispute.</p>
        {error ? <div className="compensation-import-message error" role="alert"><strong>Import blocked</strong><span>{error}</span></div> : null}
        {preview?.message ? <div aria-live="polite" className="compensation-import-message success"><strong>Import completed</strong><span>{preview.message}</span></div> : null}
        {preview ? <div className="compensation-preview">
          <div className="compensation-preview-summary"><span><strong>{preview.totalRows ?? 0}</strong> TIDs</span><span><strong>{preview.payoutRows ?? 0}</strong> payout recoveries</span><span><strong>{preview.disputeRows ?? 0}</strong> planned provider disputes</span><span><strong>{preview.linkedAllocations ?? 0}</strong> linked allocations</span><span><strong>{preview.pendingAllocations ?? 0}</strong> awaiting registration</span></div>
          {preview.issues?.length ? <div className="compensation-issues" role="alert"><strong>{preview.issues.length} issue{preview.issues.length === 1 ? "" : "s"} must be corrected</strong><ul>{preview.issues.map((issue, index) => <li key={`${issue.rowNumber ?? "file"}-${issue.tid ?? "general"}-${index}`}>{issue.rowNumber ? `Row ${issue.rowNumber}` : "Workbook"}{issue.tid ? ` · ${issue.tid}` : ""}: {issue.message}</li>)}</ul></div> : null}
          {preview.rows?.length ? <div className="table-wrap compensation-preview-table"><table><thead><tr><th>Row</th><th>TID</th><th>Provider (from location)</th><th>Location</th><th>Debit month</th><th>Debit amount</th><th>Recovery route</th><th>Recovery IDs</th><th>Allocation</th><th>ID link</th></tr></thead><tbody>{preview.rows.map((row) => <tr className={row.linkStatus === "pending" || row.linkStatus === "mixed" ? "workforce-advance-pending-row" : undefined} key={`${row.rowNumber}-${row.tid}`}><td>{row.rowNumber}</td><td><strong>{row.tid}</strong></td><td><strong>{row.providerCode || "—"}</strong>{row.providerName && row.providerName !== row.providerCode ? <small>{row.providerName}</small> : null}</td><td>{row.location}</td><td>{monthLabel(row.debitMonth)}</td><td>{money(row.debitAmount)}</td><td>{routeLabel(row.recoveryMethod)}</td><td>{Array.isArray(row.recoveryIds) && row.recoveryIds.length ? row.recoveryIds.join(", ") : "—"}</td><td>{row.allocationCount ? `${row.allocationCount} equal ${row.allocationCount === 1 ? "share" : "shares"}` : "Provider dispute"}</td><td><span className={`status-pill ${row.linkStatus === "linked" ? "good" : row.linkStatus === "pending" || row.linkStatus === "mixed" ? "warn" : "payout-status-neutral"}`}>{linkLabel(row.linkStatus)}</span></td></tr>)}</tbody></table></div> : null}
          {preview.canCommit && !preview.batchId ? <div className="compensation-commit-row"><span>Every row passed validation. Nothing has been added and no payment has been deducted yet.</span><button className="button" disabled={Boolean(busy)} onClick={() => submit("commit")} type="button">{busy === "commit" ? "Adding…" : `Confirm and add ${preview.totalRows ?? 0} TIDs`}</button></div> : null}
        </div> : null}
      </div>
    </section> : null}
  </div>;
}
