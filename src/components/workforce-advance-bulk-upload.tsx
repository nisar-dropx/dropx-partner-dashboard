"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Preview = {
  error?: string;
  message?: string;
  importId?: string;
  totalRows?: number;
  matchedRows?: number;
  pendingRows?: number;
  canCommit?: boolean;
  issues?: Array<{ rowNumber: number | null; dropxId: string | null; message: string }>;
  rows?: Array<{ rowNumber: number; dropxId: string; fullName: string; location: string; linkStatus: "linked" | "pending"; advanceDate: string; amount: number; deductedAmount: number; pendingAmount: number; reference: string; paymentMode: string }>;
};

async function readResponse(response: Response): Promise<Preview> {
  const text = await response.text();
  try { return JSON.parse(text) as Preview; } catch { return { error: `The server returned an unreadable response (HTTP ${response.status}).` }; }
}

function money(value: number) {
  return `Rs ${Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function WorkforceAdvanceBulkUpload() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<"preview" | "commit" | null>(null);
  const [error, setError] = useState("");

  async function submit(mode: "preview" | "commit") {
    if (!file) { setError("Choose the completed Workforce advance workbook first."); return; }
    if (mode === "commit" && !window.confirm(`Import ${preview?.totalRows ?? 0} advances?\n\nThis adds new register entries. DEDUCTED_AMOUNT will be recorded as already recovered for linked Workforce. Unregistered IDs will wait for registration and cannot be deducted from payouts until they link automatically. Existing advances will not be changed. Duplicate advances are blocked even if the workbook was re-saved.`)) return;
    setBusy(mode);
    setError("");
    try {
      const body = new FormData();
      body.set("mode", mode);
      body.set("file", file);
      const response = await fetch("/api/payments/workforce-advances/bulk-upload", { method: "POST", body });
      const payload = await readResponse(response);
      setPreview(payload);
      if (!response.ok) throw new Error(payload.error ?? "Unable to process the workbook.");
      if (mode === "commit") router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to process the workbook.");
    } finally {
      setBusy(null);
    }
  }

  return <div className="workforce-advance-upload">
    <button className="button secondary" onClick={() => setOpen((value) => !value)} type="button">{open ? "Close bulk upload" : "Bulk upload"}</button>
    {open ? <section className="panel compensation-import-panel">
      <div className="panel-head"><div><h2>Bulk upload existing advances</h2><p className="subtle">Preview and validate every payment before adding it to the register.</p></div><a className="template-download-link" download href="/api/payments/workforce-advances/bulk-upload/template">Download Excel template</a></div>
      <div className="compensation-import-body">
        <div className="compensation-import-controls"><label><span>Advance workbook</span><input accept=".xlsx,.xls,.csv" className="field compensation-file-input" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); setError(""); }} type="file" /></label><button className="button secondary" disabled={Boolean(busy)} onClick={() => submit("preview")} type="button">{busy === "preview" ? "Checking…" : "Preview and validate"}</button></div>
        <p className="compensation-match-rule"><strong>Matching:</strong> DROPX_ID is matched to the canonical Workforce profile in your company. For company-wide users, an unregistered ID is kept exactly as uploaded and marked Awaiting Workforce registration; it cannot be deducted from payouts until registration links it automatically. Linked profiles must be inside your location access scope. Dates accept DD-MM-YYYY or DD/MM/YYYY.</p>
        {error ? <div className="compensation-import-message error"><strong>Import blocked</strong><span>{error}</span></div> : null}
        {preview?.message ? <div className="compensation-import-message success"><strong>Import completed</strong><span>{preview.message}</span></div> : null}
        {preview?.totalRows ? <div className="compensation-preview">
          <div className="compensation-preview-summary"><span><strong>{preview.totalRows}</strong> workbook rows</span><span><strong>{preview.matchedRows ?? 0}</strong> Workforce matches</span><span><strong>{preview.pendingRows ?? 0}</strong> awaiting registration</span></div>
          {preview.issues?.length ? <div className="compensation-issues" role="alert"><strong>{preview.issues.length} issue{preview.issues.length === 1 ? "" : "s"} must be corrected</strong><ul>{preview.issues.map((issue, index) => <li key={`${issue.rowNumber ?? "file"}-${index}`}>{issue.rowNumber ? `Row ${issue.rowNumber}` : "Workbook"}{issue.dropxId ? ` · ${issue.dropxId}` : ""}: {issue.message}</li>)}</ul></div> : null}
          <div className="table-wrap compensation-preview-table"><table><thead><tr><th>Row</th><th>DropX ID</th><th>Workforce</th><th>Registration</th><th>Location</th><th>Advance date</th><th>Amount</th><th>Already deducted</th><th>Pending</th><th>Mode</th><th>Reference</th></tr></thead><tbody>{(preview.rows ?? []).map((row) => <tr className={row.linkStatus === "pending" ? "workforce-advance-pending-row" : undefined} key={`${row.rowNumber}-${row.dropxId}`}><td>{row.rowNumber}</td><td><strong>{row.dropxId}</strong></td><td>{row.fullName}</td><td><span className={`status-pill ${row.linkStatus === "linked" ? "good" : "warn"}`}>{row.linkStatus === "linked" ? "Linked" : "Awaiting Workforce registration"}</span></td><td>{row.location}</td><td>{row.advanceDate}</td><td>{money(row.amount)}</td><td>{money(row.deductedAmount)}</td><td>{money(row.pendingAmount)}</td><td>{row.paymentMode.replaceAll("_", " ")}</td><td>{row.reference || "—"}</td></tr>)}</tbody></table></div>
          {preview.canCommit && !preview.importId ? <div className="compensation-commit-row"><span>Every row passed validation. Nothing has been added yet.{preview.pendingRows ? ` ${preview.pendingRows} ${preview.pendingRows === 1 ? "row will" : "rows will"} await Workforce registration.` : ""}</span><button className="button" disabled={Boolean(busy)} onClick={() => submit("commit")} type="button">{busy === "commit" ? "Importing…" : `Import ${preview.totalRows} advances`}</button></div> : null}
        </div> : null}
      </div>
    </section> : null}
  </div>;
}
