"use client";
import { ReportTable } from "@/components/report-table";


import { useState } from "react";

type ImportKind = "employee_salary" | "contractor_remuneration";

type PreviewRow = {
  rowNumber: number;
  dropxId: string;
  personId: string | null;
  fullName: string | null;
  amount: number;
  action: "create" | "update" | "blocked";
};

type PreviewIssue = {
  rowNumber: number | null;
  dropxId: string | null;
  message: string;
};

type PreviewResponse = {
  error?: string;
  message?: string;
  kind?: ImportKind;
  fileName?: string;
  effectiveFrom?: string;
  totalRows?: number;
  matchedRows?: number;
  createRows?: number;
  updateRows?: number;
  canCommit?: boolean;
  issues?: PreviewIssue[];
  rows?: PreviewRow[];
  matchRule?: string;
  importId?: string;
};

const rupees = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });

function indiaToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

async function readPreviewResponse(response: Response): Promise<PreviewResponse> {
  const body = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(body) as PreviewResponse;
    } catch {
      throw new Error("The import service returned an unreadable response. Please retry once.");
    }
  }

  if (response.status === 404) {
    throw new Error("The import service is temporarily unavailable after an update. Please refresh and retry.");
  }
  throw new Error(`The import service could not complete the request (HTTP ${response.status}). Please retry.`);
}

export function CompensationBulkUpload({ kind }: { kind: ImportKind }) {
  const employee = kind === "employee_salary";
  const [file, setFile] = useState<File | null>(null);
  const [effectiveFrom, setEffectiveFrom] = useState(indiaToday);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [busy, setBusy] = useState<"preview" | "commit" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function invalidatePreview() {
    setPreview(null);
    setError(null);
  }

  async function submit(mode: "preview" | "commit") {
    if (!file) {
      setError("Choose the Excel workbook first.");
      return;
    }
    if (!effectiveFrom) {
      setError("Select the date from which these values should apply.");
      return;
    }
    if (mode === "commit" && !window.confirm(
      employee
        ? `Apply the previewed salary values to ${preview?.totalRows ?? 0} employees?`
        : `Apply the previewed monthly remuneration to ${preview?.totalRows ?? 0} contractors?`
    )) return;
    setBusy(mode);
    setError(null);
    try {
      const body = new FormData();
      body.set("kind", kind);
      body.set("mode", mode);
      body.set("effective_from", effectiveFrom);
      body.set("file", file);
      const response = await fetch("/api/payroll/compensation-import", { method: "POST", body });
      const result = await readPreviewResponse(response);
      setPreview(result);
      if (!response.ok) throw new Error(result.error ?? "Unable to process this workbook.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to process this workbook.");
    } finally {
      setBusy(null);
    }
  }

  const rows = preview?.rows ?? [];
  const issues = preview?.issues ?? [];
  const title = employee ? "Bulk employee salary update" : "Bulk contractor remuneration update";
  const description = employee
    ? "Upload employee CTC and its monthly components. Records are matched only by EmpCode / DropX ID."
    : "Upload monthly contractor remuneration. Records are matched only by DropX ID.";

  return (
    <section className="panel compensation-import-panel">
      <div className="panel-head">
        <div>
          <h2>{title}</h2>
          <p className="subtle">{description}</p>
        </div>
        <div className="compensation-import-head-actions">
          <a
            className="template-download-link"
            download
            href={`/api/import-template?kind=${employee ? "employee_salary" : "contractor_remuneration"}`}
          >
            Download sample Excel
          </a>
          <span className="status-pill good">Owner only</span>
        </div>
      </div>
      <div className="compensation-import-body">
        <div className="compensation-import-controls">
          <label>
            <span>Effective from</span>
            <input className="field" type="date" value={effectiveFrom} onChange={(event) => { setEffectiveFrom(event.target.value); invalidatePreview(); }} required />
          </label>
          <label>
            <span>{employee ? "Employee salary workbook" : "IC remuneration workbook"}</span>
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
          <strong>ID-only matching:</strong> spreadsheet name, designation and location are ignored. The saved record is resolved from the company database by DropX ID.
        </p>

        {error ? <div className="compensation-import-message error"><strong>Import blocked</strong><span>{error}</span></div> : null}
        {preview?.message ? <div className="compensation-import-message success"><strong>Import completed</strong><span>{preview.message}</span></div> : null}

        {preview?.totalRows ? (
          <div className="compensation-preview">
            <div className="compensation-preview-summary">
              <span><strong>{preview.totalRows}</strong> workbook rows</span>
              <span><strong>{preview.matchedRows ?? 0}</strong> ID matches</span>
              <span><strong>{preview.createRows ?? 0}</strong> new pay records</span>
              <span><strong>{preview.updateRows ?? 0}</strong> updates</span>
            </div>

            {issues.length ? (
              <div className="compensation-issues" role="alert">
                <strong>{issues.length} issue{issues.length === 1 ? "" : "s"} must be corrected</strong>
                <ul>{issues.map((issue, index) => (
                  <li key={`${issue.rowNumber ?? "master"}-${issue.dropxId ?? "none"}-${index}`}>
                    {issue.rowNumber ? `Row ${issue.rowNumber}` : "Payroll Master"}{issue.dropxId ? ` · ${issue.dropxId}` : ""}: {issue.message}
                  </li>
                ))}</ul>
              </div>
            ) : null}

            <div className="table-wrap compensation-preview-table">
              <ReportTable>
                <thead><tr><th>Row</th><th>DropX ID</th><th>Database person</th><th>{employee ? "Monthly CTC" : "Monthly remuneration"}</th><th>Action</th></tr></thead>
                <tbody>{rows.slice(0, 50).map((row) => (
                  <tr key={`${row.rowNumber}-${row.dropxId}`}>
                    <td>{row.rowNumber}</td>
                    <td><strong>{row.dropxId || "—"}</strong></td>
                    <td>{row.fullName ?? "Not matched"}</td>
                    <td>{Number.isFinite(row.amount) ? rupees.format(row.amount) : "Invalid"}</td>
                    <td><span className={`status-pill ${row.action === "blocked" ? "warn" : "good"}`}>{row.action}</span></td>
                  </tr>
                ))}</tbody>
              </ReportTable>
            </div>
            {rows.length > 50 ? <p className="subtle compensation-preview-more">Showing the first 50 of {rows.length} validated rows.</p> : null}
            {preview.canCommit && !preview.importId ? (
              <div className="compensation-commit-row">
                <span>All IDs and amounts passed validation. Nothing has been changed yet.</span>
                <button className="button" disabled={Boolean(busy)} onClick={() => submit("commit")} type="button">
                  {busy === "commit" ? "Applying…" : employee ? `Apply ${preview.totalRows} salary records` : `Apply ${preview.totalRows} remuneration records`}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
