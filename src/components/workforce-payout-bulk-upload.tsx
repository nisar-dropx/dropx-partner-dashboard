"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type PreviewIssue = {
  rowNumber: number | null;
  dropxId: string | null;
  message: string;
};

type PreviewRow = {
  rowNumber: number;
  action: "UPSERT" | "CLEAR";
  dropxId: string;
  fullName: string;
  inputType: string;
  fieldCode: string;
  locationCode: string;
  effectiveFrom: string;
  effectiveTo: string;
  value: number | string | null;
  workMinutes: number | null;
};

type PreviewResponse = {
  error?: string;
  message?: string;
  importId?: string;
  fileName?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  totalRows?: number;
  matchedRows?: number;
  canCommit?: boolean;
  counts?: Record<string, number>;
  issues?: PreviewIssue[];
  rows?: PreviewRow[];
};

async function readResponse(response: Response): Promise<PreviewResponse> {
  const text = await response.text();
  try {
    return JSON.parse(text) as PreviewResponse;
  } catch {
    if (response.status === 404) throw new Error("The payout import service is unavailable. Refresh the page and retry.");
    throw new Error(`The payout import service returned an unreadable response (HTTP ${response.status}).`);
  }
}

export function WorkforcePayoutBulkUpload({ fromDate, toDate }: { fromDate: string; toDate: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState(fromDate);
  const [effectiveTo, setEffectiveTo] = useState(toDate);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [busy, setBusy] = useState<"preview" | "commit" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEffectiveFrom(fromDate);
    setEffectiveTo(toDate);
    setPreview(null);
    setError(null);
  }, [fromDate, toDate]);

  function invalidatePreview() {
    setPreview(null);
    setError(null);
  }

  async function submit(mode: "preview" | "commit") {
    if (!file) {
      setError("Choose the completed payout input workbook first.");
      return;
    }
    if (!effectiveFrom || !effectiveTo || effectiveTo < effectiveFrom) {
      setError("Select a valid effective-from and effective-to range.");
      return;
    }
    if (mode === "commit" && !window.confirm(
      `Apply all ${preview?.totalRows ?? 0} previewed payout input rows for ${effectiveFrom} to ${effectiveTo}? This is one atomic import.`
    )) return;

    setBusy(mode);
    setError(null);
    try {
      const body = new FormData();
      body.set("mode", mode);
      body.set("effective_from", effectiveFrom);
      body.set("effective_to", effectiveTo);
      body.set("file", file);
      const response = await fetch("/api/payments/workforce-payouts/bulk-upload", { method: "POST", body });
      const result = await readResponse(response);
      setPreview(result);
      if (!response.ok) throw new Error(result.error ?? "Unable to process this payout workbook.");
      if (mode === "commit") router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to process this payout workbook.");
    } finally {
      setBusy(null);
    }
  }

  const issues = preview?.issues ?? [];
  const rows = preview?.rows ?? [];
  const templateUrl = `/api/payments/workforce-payouts/bulk-upload/template?effective_from=${encodeURIComponent(effectiveFrom)}&effective_to=${encodeURIComponent(effectiveTo)}`;

  return (
    <div className="workforce-payout-bulk-upload">
      <button className="button secondary" type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
        {open ? "Close bulk upload" : "Bulk upload"}
      </button>

      {open ? (
        <section className="panel compensation-import-panel">
          <div className="panel-head">
            <div>
              <h2>Bulk upload payout inputs</h2>
              <p className="subtle">Preview attendance, configured field values, custom production units and additional payments before applying them.</p>
            </div>
            <a className="template-download-link" download href={templateUrl}>Download current Excel template</a>
          </div>

          <div className="compensation-import-body">
            <div className="compensation-import-controls">
              <label>
                <span>Effective from</span>
                <input className="field" type="date" value={effectiveFrom} onChange={(event) => { setEffectiveFrom(event.target.value); invalidatePreview(); }} required />
              </label>
              <label>
                <span>Effective to</span>
                <input className="field" type="date" min={effectiveFrom} value={effectiveTo} onChange={(event) => { setEffectiveTo(event.target.value); invalidatePreview(); }} required />
              </label>
              <label>
                <span>Payout input workbook</span>
                <input
                  accept=".xlsx,.xls,.csv"
                  className="field compensation-file-input"
                  type="file"
                  onChange={(event) => { setFile(event.target.files?.[0] ?? null); invalidatePreview(); }}
                />
              </label>
              <button className="button secondary" disabled={Boolean(busy)} onClick={() => submit("preview")} type="button">
                {busy === "preview" ? "Checking…" : "Preview and validate"}
              </button>
            </div>

            <p className="compensation-match-rule">
              <strong>Effective-date rules:</strong> attendance and production use one date per row; additional payments must use this exact payout period. Zero is preserved as a real value.
            </p>

            {error ? <div className="compensation-import-message error"><strong>Import blocked</strong><span>{error}</span></div> : null}
            {preview?.message ? <div className="compensation-import-message success"><strong>Import completed</strong><span>{preview.message}</span></div> : null}

            {preview?.totalRows ? (
              <div className="compensation-preview">
                <div className="compensation-preview-summary">
                  <span><strong>{preview.totalRows}</strong> workbook rows</span>
                  <span><strong>{preview.matchedRows ?? 0}</strong> Workforce matches</span>
                  <span><strong>{preview.counts?.ATTENDANCE ?? 0}</strong> attendance</span>
                  <span><strong>{preview.counts?.PRODUCTION_UNITS ?? 0}</strong> production</span>
                  <span><strong>{preview.counts?.PAYMENT_FIELD_VALUE ?? 0}</strong> field values</span>
                  <span><strong>{preview.counts?.ADDITIONAL_PAYMENT ?? 0}</strong> additions</span>
                </div>

                {issues.length ? (
                  <div className="compensation-issues" role="alert">
                    <strong>{issues.length} issue{issues.length === 1 ? "" : "s"} must be corrected</strong>
                    <ul>{issues.map((issue, index) => (
                      <li key={`${issue.rowNumber ?? "workbook"}-${issue.dropxId ?? "none"}-${index}`}>
                        {issue.rowNumber ? `Row ${issue.rowNumber}` : "Workbook"}{issue.dropxId ? ` · ${issue.dropxId}` : ""}: {issue.message}
                      </li>
                    ))}</ul>
                  </div>
                ) : null}

                <div className="table-wrap compensation-preview-table">
                  <table>
                    <thead><tr><th>Row</th><th>DropX ID</th><th>Location</th><th>Database person</th><th>Input</th><th>Field</th><th>Effective dates</th><th>Value</th><th>Action</th></tr></thead>
                    <tbody>{rows.slice(0, 50).map((row) => (
                      <tr key={`${row.rowNumber}-${row.dropxId}-${row.inputType}-${row.fieldCode}`}>
                        <td>{row.rowNumber}</td>
                        <td><strong>{row.dropxId}</strong></td>
                        <td>{row.locationCode || "Database location"}</td>
                        <td>{row.fullName}</td>
                        <td>{row.inputType.replaceAll("_", " ")}</td>
                        <td>{row.fieldCode || "—"}</td>
                        <td>{row.effectiveFrom === row.effectiveTo ? row.effectiveFrom : `${row.effectiveFrom} – ${row.effectiveTo}`}</td>
                        <td>{row.value ?? (row.action === "CLEAR" ? "Clear" : "—")}{row.workMinutes !== null ? ` · ${row.workMinutes} min` : ""}</td>
                        <td><span className={`status-pill ${row.action === "CLEAR" ? "warn" : "good"}`}>{row.action.toLowerCase()}</span></td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
                {(preview.matchedRows ?? rows.length) > 50 ? <p className="subtle compensation-preview-more">Showing the first 50 of {preview.matchedRows} matched rows.</p> : null}
                {preview.canCommit && !preview.importId ? (
                  <div className="compensation-commit-row">
                    <span>Every row passed server validation. Nothing has been changed yet.</span>
                    <button className="button" disabled={Boolean(busy)} onClick={() => submit("commit")} type="button">
                      {busy === "commit" ? "Applying…" : `Apply ${preview.totalRows} rows`}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
