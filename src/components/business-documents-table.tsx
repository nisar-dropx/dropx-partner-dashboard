"use client";

import { EvidencePreview } from "@/components/evidence-preview";
import { useMemo, useState } from "react";
import { Download, Eye } from "lucide-react";

export type BusinessDocumentTableRow = {
  id: string;
  documentName: string;
  scope: string;
  reference: string;
  issue: string;
  expiry: string;
  expiryClassName: string;
  status: string;
  days: string;
  signedUrl: string | null;
  fileName?: string | null;
  canDownload: boolean;
  manageUrl: string;
};

type Props = {
  allFilteredIds: string[];
  canEdit: boolean;
  rows: BusinessDocumentTableRow[];
};

export function BusinessDocumentsTable({ allFilteredIds, canEdit, rows }: Props) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [downloading, setDownloading] = useState<"zip" | "single" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const downloadableOnPage = useMemo(() => rows.filter((row) => row.canDownload).map((row) => row.id), [rows]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const allFilteredSelected = allFilteredIds.length > 0 && allFilteredIds.every((id) => selectedSet.has(id));
  const allPageSelected = downloadableOnPage.length > 0 && downloadableOnPage.every((id) => selectedSet.has(id));

  function replaceSelection(ids: string[]) {
    setSelectedIds(Array.from(new Set(ids)));
    setError(null);
  }

  function toggleOne(id: string, checked: boolean) {
    replaceSelection(checked ? [...selectedIds, id] : selectedIds.filter((item) => item !== id));
  }

  function togglePage(checked: boolean) {
    if (checked) replaceSelection([...selectedIds, ...downloadableOnPage]);
    else replaceSelection(selectedIds.filter((id) => !downloadableOnPage.includes(id)));
  }

  async function download(mode: "zip" | "single") {
    if (!selectedIds.length) {
      setError("Select at least one document with a file.");
      return;
    }
    setDownloading(mode);
    setError(null);
    try {
      const response = await fetch("/api/business-documents/bulk-download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selectedIds, mode })
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || "Unable to download selected documents.");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const filename = filenameFromDisposition(disposition) || (mode === "zip" ? "business-documents.zip" : "business-documents.pdf");
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setDialogOpen(false);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "Unable to download selected documents.");
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div className="business-doc-selection">
      <div className="business-doc-bulk-toolbar">
        <div className="business-doc-selection-actions">
          <button className="button secondary compact" disabled={!allFilteredIds.length} onClick={() => replaceSelection(allFilteredSelected ? [] : allFilteredIds)} type="button">
            {allFilteredSelected ? "Clear selection" : "Select all"}
          </button>
          <span className="subtle">{selectedIds.length} selected</span>
        </div>
        <button className="button compact" disabled={!selectedIds.length} onClick={() => setDialogOpen(true)} type="button">
          Bulk download
        </button>
      </div>
      {error ? <div className="business-doc-bulk-error">{error}</div> : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="select-cell">
                <input
                  aria-label="Select all documents on this page"
                  checked={allPageSelected}
                  disabled={!downloadableOnPage.length}
                  onChange={(event) => togglePage(event.target.checked)}
                  type="checkbox"
                />
              </th>
              <th>Document</th>
              <th>Scope</th>
              <th>Reference</th>
              <th>Issue</th>
              <th>Expiry</th>
              <th>Status</th>
              <th>Days</th>
              <th>File</th>
              {canEdit ? <th>Action</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.length ? rows.map((document) => (
              <tr key={document.id}>
                <td className="select-cell">
                  <input
                    aria-label={`Select ${document.documentName}`}
                    checked={selectedSet.has(document.id)}
                    disabled={!document.canDownload}
                    onChange={(event) => toggleOne(document.id, event.target.checked)}
                    type="checkbox"
                  />
                </td>
                <td><strong>{document.documentName}</strong></td>
                <td><strong>{document.scope}</strong></td>
                <td>{document.reference}</td>
                <td>{document.issue}</td>
                <td><span className={document.expiryClassName}>{document.expiry}</span></td>
                <td><span className={`status-pill ${document.status.toLowerCase() === "active" ? "good" : document.status.toLowerCase() === "expired" ? "bad" : "warn"}`}>{document.status}</span></td>
                <td>{document.days}</td>
                <td>
                  {document.signedUrl ? (
                    <div className="business-doc-file-actions">
                      <EvidencePreview className="icon-button" href={document.signedUrl} fileName={document.fileName} label={`${document.documentName} · ${document.scope}`}><Eye size={16} /></EvidencePreview>
                      <a className="icon-button" href={`/api/business-documents/download?id=${encodeURIComponent(document.id)}`} aria-label="Download document" title="Download document"><Download size={16} /></a>
                    </div>
                  ) : "-"}
                </td>
                {canEdit ? <td><a className="button secondary compact" href={document.manageUrl}>Manage</a></td> : null}
              </tr>
            )) : (
              <tr><td className="empty-cell" colSpan={canEdit ? 10 : 9}>No business documents found.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {dialogOpen ? (
        <div className="modal-backdrop">
          <section aria-modal="true" className="modal-panel business-doc-bulk-dialog" role="dialog">
            <div className="panel-head">
              <div>
                <h2>Bulk download</h2>
                <p className="subtle">{selectedIds.length} document file{selectedIds.length === 1 ? "" : "s"} selected.</p>
              </div>
              <button className="icon-button" onClick={() => setDialogOpen(false)} type="button" aria-label="Close">x</button>
            </div>
            <div className="business-doc-download-options">
              <button className="button" disabled={Boolean(downloading)} onClick={() => download("zip")} type="button">
                {downloading === "zip" ? "Preparing..." : "Download Separate file in zip"}
              </button>
              <button className="button secondary" disabled={Boolean(downloading)} onClick={() => download("single")} type="button">
                {downloading === "single" ? "Preparing..." : "Download as single file"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function filenameFromDisposition(value: string) {
  const match = value.match(/filename="([^"]+)"/i);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}
