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
  value: number;
  providerReference: string;
};

type RecoveryPreview = {
  error?: string;
  message?: string;
  batchId?: string;
  fileName?: string;
  fileSha256?: string;
  totalRows?: number;
  totalValue?: number;
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
      `Add ${preview?.totalRows ?? 0} TID-level recovery records to the register?\n\n` +
      "This stores the location, debit month, and value only. You will select the recovery method from the register after upload. No payout will be deducted and no provider dispute will be submitted now."
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
      <div className="panel-head"><div><h2>Bulk upload payment recoveries</h2><p className="subtle">Preview TID-level values before adding unconfigured rows to the register. Select each recovery method after upload.</p></div><a className="template-download-link" download href="/api/payments/recoveries/bulk-upload/template">Download Excel template</a></div>
      <div className="compensation-import-body">
        <div className="compensation-import-controls"><label><span>Recovery workbook</span><input accept=".xlsx,.xls,.csv" className="field compensation-file-input" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); setError(""); }} type="file" /></label><button className="button secondary" disabled={Boolean(busy)} onClick={() => submit("preview")} type="button">{busy === "preview" ? "Checking…" : "Preview and validate"}</button></div>
        <p className="compensation-match-rule"><strong>How it works:</strong> use one row per TID. Enter LOCATION, DEBIT_MONTH in MMM-YY format such as Jul-26, and VALUE. The provider is taken automatically from the location setup, and PROVIDER_REFERENCE is optional. After upload, select either payout deduction or post-invoice provider dispute from each row in the Recovery register.</p>
        {error ? <div className="compensation-import-message error" role="alert"><strong>Import blocked</strong><span>{error}</span></div> : null}
        {preview?.message ? <div aria-live="polite" className="compensation-import-message success"><strong>Import completed</strong><span>{preview.message}</span></div> : null}
        {preview ? <div className="compensation-preview">
          <div className="compensation-preview-summary"><span><strong>{preview.totalRows ?? 0}</strong> TIDs</span><span><strong>{money(preview.totalValue ?? 0)}</strong> total value</span><span><strong>Not configured</strong> recovery method selected after upload</span></div>
          {preview.issues?.length ? <div className="compensation-issues" role="alert"><strong>{preview.issues.length} issue{preview.issues.length === 1 ? "" : "s"} must be corrected</strong><ul>{preview.issues.map((issue, index) => <li key={`${issue.rowNumber ?? "file"}-${issue.tid ?? "general"}-${index}`}>{issue.rowNumber ? `Row ${issue.rowNumber}` : "Workbook"}{issue.tid ? ` · ${issue.tid}` : ""}: {issue.message}</li>)}</ul></div> : null}
          {preview.rows?.length ? <div className="table-wrap compensation-preview-table"><table><thead><tr><th>Row</th><th>TID</th><th>Provider (from location)</th><th>Location</th><th>Debit month</th><th>Value</th><th>Provider reference</th></tr></thead><tbody>{preview.rows.map((row) => <tr key={`${row.rowNumber}-${row.tid}`}><td>{row.rowNumber}</td><td><strong>{row.tid}</strong></td><td><strong>{row.providerCode || "—"}</strong>{row.providerName && row.providerName !== row.providerCode ? <small>{row.providerName}</small> : null}</td><td>{row.location}</td><td>{monthLabel(row.debitMonth)}</td><td>{money(row.value)}</td><td>{row.providerReference || "—"}</td></tr>)}</tbody></table></div> : null}
          {preview.canCommit && !preview.batchId ? <div className="compensation-commit-row"><span>Every row passed validation. Nothing has been added, configured, or deducted yet.</span><button className="button" disabled={Boolean(busy)} onClick={() => submit("commit")} type="button">{busy === "commit" ? "Adding…" : `Confirm and add ${preview.totalRows ?? 0} TIDs`}</button></div> : null}
        </div> : null}
      </div>
    </section> : null}
  </div>;
}
