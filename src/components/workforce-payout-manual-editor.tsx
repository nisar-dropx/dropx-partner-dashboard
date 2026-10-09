"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { announceWorkforcePayoutInputsChanged } from "@/lib/workforce-payout-client-events";
import {
  WORKFORCE_PAYOUT_MANUAL_INPUT_TYPES,
  applyWorkforcePayoutManualLineToAll,
  buildWorkforcePayoutManualCsv,
  chunkWorkforcePayoutManualLines,
  createWorkforcePayoutManualLine,
  createWorkforcePayoutManualLines,
  normalizeWorkforcePayoutManualLineType,
  validateWorkforcePayoutManualLines,
  workforcePayoutManualSelectionKey,
  type WorkforcePayoutManualAction,
  type WorkforcePayoutManualCatalog,
  type WorkforcePayoutManualInputType,
  type WorkforcePayoutManualLine,
  type WorkforcePayoutManualSelection
} from "@/lib/workforce-payout-manual-entry";

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
  effectiveDate: string;
  effectiveTo: string;
  value: number | string | null;
};

type PreviewResponse = {
  error?: string;
  message?: string;
  importId?: string;
  totalRows?: number;
  matchedRows?: number;
  canCommit?: boolean;
  counts?: Record<string, number>;
  issues?: PreviewIssue[];
  warnings?: Array<string | { message?: string; dropxId?: string | null }>;
  rows?: PreviewRow[];
};

const INPUT_LABELS: Record<WorkforcePayoutManualInputType, string> = {
  ATTENDANCE: "Attendance",
  PRODUCTION_UNITS: "Production units",
  PAYMENT_FIELD_VALUE: "Payment field / rate",
  ADDITIONAL_PAYMENT: "Additional payment",
  DEDUCTION: "Deduction"
};

const MANUAL_INPUT_REQUEST_CHUNK_SIZE = 1000;

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`The payout service returned an unreadable response (HTTP ${response.status}).`);
  }
}

export type WorkforcePayoutManualEditorProps = {
  fromDate: string;
  toDate: string;
  selectedRows: WorkforcePayoutManualSelection[];
  buttonLabel?: string;
  onCommitted?: () => void;
};

export function WorkforcePayoutManualEditor({
  fromDate,
  toDate,
  selectedRows,
  buttonLabel = "Manual entry",
  onCommitted
}: WorkforcePayoutManualEditorProps) {
  const router = useRouter();
  const nextLineNumber = useRef(1);
  const operationIdsRef = useRef<string[]>([]);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const confirmationRef = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<WorkforcePayoutManualCatalog | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [lines, setLines] = useState<WorkforcePayoutManualLine[]>([]);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [busy, setBusy] = useState<"preview" | "commit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showClientIssues, setShowClientIssues] = useState(false);
  const [confirmationOpen, setConfirmationOpen] = useState(false);

  const selectionSignature = selectedRows
    .map((row) => workforcePayoutManualSelectionKey(row))
    .sort()
    .join("|");

  const selectionByKey = useMemo(
    () => new Map(selectedRows.map((row) => [workforcePayoutManualSelectionKey(row), row])),
    [selectedRows]
  );
  const clientIssues = useMemo(
    () => validateWorkforcePayoutManualLines(lines, fromDate, toDate),
    [fromDate, lines, toDate]
  );
  const publishedCount = selectedRows.filter((row) => /payment published|notification (?:queued|failed)|delivery needs review/i.test(row.status ?? "")).length;

  useEffect(() => {
    if (!open) return;
    const initial = createWorkforcePayoutManualLines(selectedRows, fromDate, toDate);
    nextLineNumber.current = initial.length + 1;
    setLines(initial);
    setPreview(null);
    setError(null);
    setShowClientIssues(false);
    setConfirmationOpen(false);
    operationIdsRef.current = [];
  }, [fromDate, open, selectionSignature, toDate]); // selectedRows is intentionally represented by its stable identity signature.

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setCatalogBusy(true);
    setCatalog(null);
    const query = new URLSearchParams({ effective_from: fromDate, effective_to: toDate });
    fetch(`/api/payments/workforce-payouts/manual-inputs/catalog?${query}`, { signal: controller.signal })
      .then(async (response) => {
        const result = await readJson<WorkforcePayoutManualCatalog & { error?: string }>(response);
        if (!response.ok) throw new Error(result.error ?? "Unable to load payout input fields.");
        setCatalog(result);
      })
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "Unable to load payout input fields.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setCatalogBusy(false);
      });
    return () => controller.abort();
  }, [fromDate, open, toDate]);

  useEffect(() => {
    if (!open && !confirmationOpen) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || busy) return;
      if (confirmationOpen) setConfirmationOpen(false);
      else {
        setOpen(false);
        requestAnimationFrame(() => launcherRef.current?.focus());
      }
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, confirmationOpen, open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const dialog = confirmationOpen ? confirmationRef.current : dialogRef.current;
      dialog?.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [confirmationOpen, open]);

  function closeEditor() {
    setOpen(false);
    setConfirmationOpen(false);
    requestAnimationFrame(() => launcherRef.current?.focus());
  }

  function trapDialogFocus(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Tab") return;
    const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])"
    )].filter((element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true");
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

  function invalidatePreview() {
    setPreview(null);
    setError(null);
    setConfirmationOpen(false);
    operationIdsRef.current = [];
  }

  function replaceLine(lineId: string, update: (line: WorkforcePayoutManualLine) => WorkforcePayoutManualLine) {
    setLines((current) => current.map((line) => line.id === lineId ? update(line) : line));
    invalidatePreview();
  }

  function changeSelection(lineId: string, selectionKey: string) {
    const selection = selectionByKey.get(selectionKey);
    if (!selection) return;
    replaceLine(lineId, (line) => ({
      ...line,
      selectionKey,
      dropxId: selection.dropxId,
      name: selection.name,
      location: selection.location === "-" ? "" : selection.location
    }));
  }

  function changeAction(lineId: string, action: WorkforcePayoutManualAction) {
    replaceLine(lineId, (line) => ({ ...line, action, value: action === "CLEAR" ? "" : line.value }));
  }

  function changeType(lineId: string, inputType: WorkforcePayoutManualInputType | "") {
    replaceLine(lineId, (line) => normalizeWorkforcePayoutManualLineType(line, inputType, fromDate, toDate));
  }

  function changeDate(lineId: string, key: "effectiveDate" | "effectiveTo", value: string) {
    replaceLine(lineId, (line) => {
      if (line.inputType === "PRODUCTION_UNITS" && key === "effectiveDate") {
        return { ...line, effectiveDate: value, effectiveTo: value };
      }
      return { ...line, [key]: value };
    });
  }

  function addLine() {
    const selection = selectedRows[0];
    if (!selection) return;
    const id = `manual-line-${nextLineNumber.current++}`;
    setLines((current) => [...current, createWorkforcePayoutManualLine(selection, fromDate, toDate, id)]);
    invalidatePreview();
  }

  function removeLine(lineId: string) {
    setLines((current) => current.filter((line) => line.id !== lineId));
    invalidatePreview();
  }

  function applyToAll(lineId: string) {
    setLines((current) => applyWorkforcePayoutManualLineToAll(current, lineId, selectedRows));
    invalidatePreview();
  }

  async function submit(mode: "preview" | "commit") {
    if (mode === "commit" && (!preview?.canCommit || preview.importId)) {
      setError("Preview and validate the current input lines before applying them.");
      return;
    }
    const validationIssues = validateWorkforcePayoutManualLines(lines, fromDate, toDate);
    setShowClientIssues(true);
    if (!lines.length || validationIssues.length) {
      setError(!lines.length ? "Add at least one payout input line." : "Correct the highlighted lines before previewing.");
      return;
    }
    setBusy(mode);
    setError(null);
    let completedCommitChunks = 0;
    try {
      const chunks = chunkWorkforcePayoutManualLines(lines, MANUAL_INPUT_REQUEST_CHUNK_SIZE);
      if (mode === "preview" || operationIdsRef.current.length !== chunks.length) {
        operationIdsRef.current = chunks.map(() => crypto.randomUUID());
      }
      const aggregate: PreviewResponse = {
        totalRows: 0,
        matchedRows: 0,
        canCommit: true,
        counts: {},
        issues: [],
        warnings: [],
        rows: []
      };
      let lineOffset = 0;
      for (const [chunkIndex, chunk] of chunks.entries()) {
        const csv = buildWorkforcePayoutManualCsv(chunk);
        const body = new FormData();
        body.set("mode", mode);
        body.set("effective_from", fromDate);
        body.set("effective_to", toDate);
        body.set("input_source", "manual");
        body.set("manual_operation_id", operationIdsRef.current[chunkIndex]);
        body.set("file", new File([csv], `manual-payout-inputs-${fromDate}-to-${toDate}-${chunkIndex + 1}.csv`, { type: "text/csv" }));
        const response = await fetch("/api/payments/workforce-payouts/bulk-upload", { method: "POST", body });
        const result = await readJson<PreviewResponse>(response);
        aggregate.totalRows = Number(aggregate.totalRows ?? 0) + Number(result.totalRows ?? chunk.length);
        aggregate.matchedRows = Number(aggregate.matchedRows ?? 0) + Number(result.matchedRows ?? 0);
        aggregate.canCommit = Boolean(aggregate.canCommit && result.canCommit);
        for (const [key, value] of Object.entries(result.counts ?? {})) {
          aggregate.counts![key] = Number(aggregate.counts![key] ?? 0) + Number(value ?? 0);
        }
        aggregate.issues!.push(...(result.issues ?? []).map((issue) => ({
          ...issue,
          rowNumber: issue.rowNumber && issue.rowNumber >= 2 ? issue.rowNumber + lineOffset : issue.rowNumber
        })));
        aggregate.warnings!.push(...(result.warnings ?? []));
        aggregate.rows!.push(...(result.rows ?? []).map((row) => ({
          ...row,
          rowNumber: row.rowNumber + lineOffset
        })));
        if (aggregate.rows!.length > 50) aggregate.rows = aggregate.rows!.slice(0, 50);
        if (!response.ok) {
          setPreview(aggregate);
          throw new Error(result.error ?? "Unable to process these payout inputs.");
        }
        if (mode === "commit") completedCommitChunks += 1;
        lineOffset += chunk.length;
      }
      aggregate.message = mode === "commit"
        ? `${aggregate.totalRows} payout input line${aggregate.totalRows === 1 ? " was" : "s were"} applied in ${chunks.length} safe batch${chunks.length === 1 ? "" : "es"}.`
        : `${aggregate.matchedRows} of ${aggregate.totalRows} payout input lines matched server records across ${chunks.length} safe batch${chunks.length === 1 ? "" : "es"}.`;
      aggregate.importId = mode === "commit" ? operationIdsRef.current.join(",") : undefined;
      setPreview(aggregate);
      if (mode === "commit") {
        operationIdsRef.current = [];
        announceWorkforcePayoutInputsChanged(aggregate.message ?? "Payout inputs were updated and the worksheet is refreshing.");
        closeEditor();
        router.refresh();
        onCommitted?.();
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Unable to process these payout inputs.";
      setError(completedCommitChunks
        ? `${completedCommitChunks} manual edit batch${completedCommitChunks === 1 ? " was" : "es were"} applied before the next batch failed. Retry to replay completed batches safely and continue. ${message}`
        : message);
      if (completedCommitChunks) router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const issuesByLine = useMemo(() => {
    const grouped = new Map<string, string[]>();
    if (showClientIssues) {
      clientIssues.forEach((issue) => grouped.set(issue.lineId, [...(grouped.get(issue.lineId) ?? []), issue.message]));
    }
    (preview?.issues ?? []).forEach((issue) => {
      if (!issue.rowNumber || issue.rowNumber < 2) return;
      const line = lines[issue.rowNumber - 2];
      if (line) grouped.set(line.id, [...(grouped.get(line.id) ?? []), issue.message]);
    });
    return grouped;
  }, [clientIssues, lines, preview?.issues, showClientIssues]);

  return (
    <>
      <button
        aria-haspopup="dialog"
        className="button secondary"
        disabled={!selectedRows.length}
        onClick={() => setOpen(true)}
        ref={launcherRef}
        type="button"
      >
        {buttonLabel}{selectedRows.length ? ` (${selectedRows.length})` : ""}
      </button>

      {open ? (
        <div
          className="modal-backdrop workforce-payout-manual-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) closeEditor();
          }}
          role="presentation"
        >
          <section
            aria-labelledby="workforce-payout-manual-title"
            aria-hidden={confirmationOpen || undefined}
            aria-modal="true"
            className="modal-panel wide-modal workforce-payout-manual-modal"
            inert={confirmationOpen || undefined}
            onKeyDown={trapDialogFocus}
            ref={dialogRef}
            role="dialog"
          >
            <header className="panel-head workforce-payout-manual-head">
              <div>
                <h2 id="workforce-payout-manual-title">Edit payout inputs</h2>
                <p className="subtle">
                  Enter several changes together, validate them, then apply only the matching stored inputs for {fromDate} to {toDate}.
                </p>
              </div>
              <button className="button secondary" disabled={Boolean(busy)} onClick={closeEditor} type="button">Close</button>
            </header>

            <div className="workforce-payout-manual-body">
              <div className="workforce-payout-manual-summary" aria-label="Manual payout selection summary">
                <span><strong>{selectedRows.length}</strong> selected payout{selectedRows.length === 1 ? "" : "s"}</span>
                <span><strong>{lines.length}</strong> input line{lines.length === 1 ? "" : "s"}</span>
                <span><strong>{publishedCount}</strong> already published</span>
                <span><strong>{fromDate}</strong> to {toDate}</span>
              </div>

              {publishedCount ? (
                <p className="workforce-payout-manual-notice">
                  {publishedCount} selected payout{publishedCount === 1 ? " is" : "s are"} already published. The server will preserve the previous snapshot when it applies an updated publication revision.
                </p>
              ) : null}

              <div className="workforce-payout-manual-toolbar">
                <div>
                  <strong>Input lines</strong>
                  <span>Use “Apply to all” on any completed line to copy that input to every selected payout.</span>
                </div>
                <button className="button secondary" disabled={Boolean(busy) || !selectedRows.length} onClick={addLine} type="button">Add line</button>
              </div>

              {catalogBusy ? <p className="subtle workforce-payout-manual-loading">Loading configured payout fields…</p> : null}
              <div className="table-wrap workforce-payout-manual-table-wrap">
                <table className="workforce-payout-manual-table">
                  <thead>
                    <tr>
                      <th>Workforce payout</th>
                      <th>Action</th>
                      <th>Input type</th>
                      <th>Field</th>
                      <th>From</th>
                      <th>To</th>
                      <th>Value</th>
                      <th>Remark</th>
                      <th>Line actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, index) => {
                      const fieldOptions = (catalog?.fields ?? []).filter((field) => field.inputType === line.inputType);
                      const selectedField = fieldOptions.find((field) => field.code === line.fieldCode);
                      const lineIssues = issuesByLine.get(line.id) ?? [];
                      const periodOnly = line.inputType === "ADDITIONAL_PAYMENT" || line.inputType === "DEDUCTION";
                      return (
                        <tr className={lineIssues.length ? "has-error" : ""} key={line.id}>
                          <td className="workforce-payout-manual-person">
                            <select
                              aria-label={`Workforce payout for line ${index + 1}`}
                              className="field"
                              onChange={(event) => changeSelection(line.id, event.target.value)}
                              value={line.selectionKey}
                            >
                              {selectedRows.map((row) => {
                                const key = workforcePayoutManualSelectionKey(row);
                                return <option key={key} value={key}>{row.dropxId} · {row.name} · {row.location}</option>;
                              })}
                            </select>
                            {lineIssues.length ? <small role="alert">{lineIssues.join(" ")}</small> : <small>{line.location || "Database location"}</small>}
                          </td>
                          <td>
                            <select
                              aria-label={`Action for line ${index + 1}`}
                              className="field"
                              onChange={(event) => changeAction(line.id, event.target.value as WorkforcePayoutManualAction)}
                              value={line.action}
                            >
                              <option value="UPSERT">Set value</option>
                              <option value="CLEAR">Clear stored value</option>
                            </select>
                          </td>
                          <td>
                            <select
                              aria-label={`Input type for line ${index + 1}`}
                              className="field"
                              onChange={(event) => changeType(line.id, event.target.value as WorkforcePayoutManualInputType | "")}
                              value={line.inputType}
                            >
                              <option value="">Select type</option>
                              {WORKFORCE_PAYOUT_MANUAL_INPUT_TYPES.map((inputType) => (
                                <option key={inputType} value={inputType}>{INPUT_LABELS[inputType]}</option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <select
                              aria-label={`Field for line ${index + 1}`}
                              className="field"
                              disabled={!line.inputType || catalogBusy}
                              onChange={(event) => replaceLine(line.id, (current) => ({ ...current, fieldCode: event.target.value }))}
                              value={line.fieldCode}
                            >
                              <option value="">Select field</option>
                              {fieldOptions.map((field) => <option key={`${field.inputType}-${field.code}`} value={field.code}>{field.label} · {field.code}</option>)}
                            </select>
                          </td>
                          <td>
                            <input
                              aria-label={`From date for line ${index + 1}`}
                              className="field"
                              disabled={periodOnly}
                              max={toDate}
                              min={fromDate}
                              onChange={(event) => changeDate(line.id, "effectiveDate", event.target.value)}
                              type="date"
                              value={line.effectiveDate}
                            />
                          </td>
                          <td>
                            <input
                              aria-label={`To date for line ${index + 1}`}
                              className="field"
                              disabled={periodOnly || line.inputType === "PRODUCTION_UNITS"}
                              max={toDate}
                              min={fromDate}
                              onChange={(event) => changeDate(line.id, "effectiveTo", event.target.value)}
                              type="date"
                              value={line.effectiveTo}
                            />
                          </td>
                          <td>
                            <input
                              aria-label={`Value for line ${index + 1}`}
                              className="field"
                              disabled={line.action === "CLEAR"}
                              inputMode="decimal"
                              min="0"
                              onChange={(event) => replaceLine(line.id, (current) => ({ ...current, value: event.target.value }))}
                              placeholder={line.action === "CLEAR" ? "Cleared" : "0"}
                              step="any"
                              type="number"
                              value={line.value}
                            />
                            {selectedField ? (
                              <small className="workforce-payout-manual-value-help">
                                <strong>{selectedField.calculation}</strong>{selectedField.valueMeaning}
                              </small>
                            ) : null}
                          </td>
                          <td>
                            <input
                              aria-label={`Remark for line ${index + 1}`}
                              className="field"
                              maxLength={500}
                              onChange={(event) => replaceLine(line.id, (current) => ({ ...current, remark: event.target.value }))}
                              placeholder="Optional"
                              type="text"
                              value={line.remark}
                            />
                          </td>
                          <td>
                            <div className="workforce-payout-manual-line-actions">
                              <button
                                className="button secondary"
                                disabled={selectedRows.length < 2 || !line.inputType || !line.fieldCode}
                                onClick={() => applyToAll(line.id)}
                                type="button"
                              >
                                Apply to all
                              </button>
                              <button
                                aria-label={`Remove line ${index + 1}`}
                                className="button secondary"
                                disabled={lines.length === 1}
                                onClick={() => removeLine(line.id)}
                                type="button"
                              >
                                Remove
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {error ? <div className="compensation-import-message error" role="alert"><strong>Changes blocked</strong><span>{error}</span></div> : null}
              {(preview?.issues ?? []).some((issue) => !issue.rowNumber) ? (
                <div className="compensation-issues" role="alert">
                  <strong>Worksheet validation</strong>
                  <ul>{(preview?.issues ?? []).filter((issue) => !issue.rowNumber).map((issue, index) => <li key={index}>{issue.message}</li>)}</ul>
                </div>
              ) : null}
              {preview?.message ? <div className="compensation-import-message success"><strong>Changes applied</strong><span>{preview.message}</span></div> : null}
              {(preview?.warnings ?? []).length ? (
                <div className="workforce-payout-manual-warnings" role="status">
                  <strong>Applied with {preview?.warnings?.length} warning{preview?.warnings?.length === 1 ? "" : "s"}</strong>
                  <ul>{preview?.warnings?.map((warning, index) => {
                    const message = typeof warning === "string" ? warning : warning.message ?? "The server reported a payout update warning.";
                    const dropxId = typeof warning === "string" ? null : warning.dropxId;
                    return <li key={`${dropxId ?? "warning"}-${index}`}>{dropxId ? `${dropxId}: ` : ""}{message}</li>;
                  })}</ul>
                </div>
              ) : null}

              {preview && !preview.importId ? (
                <div className={`workforce-payout-manual-preview ${preview.canCommit ? "success" : "error"}`}>
                  <div>
                    <strong>{preview.canCommit ? "Ready to apply" : "Preview needs attention"}</strong>
                    <span>{preview.matchedRows ?? 0} of {preview.totalRows ?? lines.length} lines matched server records.</span>
                  </div>
                  {preview.canCommit ? (
                    <button className="button" disabled={Boolean(busy)} onClick={() => setConfirmationOpen(true)} type="button">Review and apply</button>
                  ) : null}
                </div>
              ) : null}

              <footer className="form-actions modal-actions workforce-payout-manual-footer">
                <button className="button secondary" disabled={Boolean(busy)} onClick={closeEditor} type="button">Cancel</button>
                <button className="button" disabled={Boolean(busy) || catalogBusy || !lines.length} onClick={() => void submit("preview")} type="button">
                  {busy === "preview" ? "Validating…" : preview ? "Validate again" : "Preview and validate"}
                </button>
              </footer>
            </div>
          </section>
        </div>
      ) : null}

      {confirmationOpen ? (
        <div className="modal-backdrop confirmation-backdrop" role="presentation">
          <section
            aria-labelledby="manual-payout-confirmation-title"
            aria-modal="true"
            className="modal-panel confirmation-dialog"
            onKeyDown={trapDialogFocus}
            ref={confirmationRef}
            role="alertdialog"
          >
            <div className="panel-head">
              <div>
                <h2 id="manual-payout-confirmation-title">Apply matching payout changes?</h2>
                <p className="subtle">Only the input identities shown in this preview are replaced or cleared.</p>
              </div>
            </div>
            <div className="confirmation-body">
              <p>Apply <strong>{lines.length} validated input line{lines.length === 1 ? "" : "s"}</strong> across <strong>{selectedRows.length} selected payout{selectedRows.length === 1 ? "" : "s"}</strong>?</p>
              <p>Other attendance, production, payment fields, additions and deductions not listed here remain unchanged.</p>
              {publishedCount ? <p><strong>{publishedCount} published payout{publishedCount === 1 ? "" : "s"}</strong> will keep their historical snapshot and receive an updated revision.</p> : null}
            </div>
            <div className="form-actions modal-actions confirmation-actions">
              <button autoFocus className="button secondary" disabled={Boolean(busy)} onClick={() => setConfirmationOpen(false)} type="button">Go back</button>
              <button className="button" disabled={Boolean(busy)} onClick={() => void submit("commit")} type="button">
                {busy === "commit" ? "Applying…" : "Confirm and apply changes"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
