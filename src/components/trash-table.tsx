"use client";

import { useMemo, useState } from "react";
import { Download, Eye } from "lucide-react";
import { SubmitButton } from "@/components/submit-button";

export type TrashItem = {
  id: string;
  key: string;
  source: "business" | "fleet" | "profile";
  reason: string;
  fileName: string;
  owner: string;
  documentName: string;
  deletedAt: string | null;
  deleteAfter: string | null;
  daysRemaining: number | null;
  sizeLabel: string;
};

export function TrashTable({ items, canEdit, action }: { items: TrashItem[]; canEdit: boolean; action: (formData: FormData) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const allSelected = Boolean(items.length && selected.length === items.length);

  function toggleAll(checked: boolean) {
    setSelected(checked ? items.map((item) => item.key) : []);
  }

  function toggleItem(key: string, checked: boolean) {
    setSelected((current) => checked ? Array.from(new Set([...current, key])) : current.filter((item) => item !== key));
  }

  return (
    <form action={action}>
      <section className="panel trash-panel">
        <div className="panel-head">
          <div>
            <h2>Trash list</h2>
            <p className="subtle">{items.length} files scheduled for permanent deletion</p>
          </div>
          {canEdit ? <TrashDeleteAction selectedCount={selected.length} /> : null}
        </div>
        {canEdit ? (
          <div className="trash-bulk-toolbar">
            <span>{selected.length ? `${selected.length} selected` : "Select files to delete permanently"}</span>
            <TrashDeleteAction selectedCount={selected.length} />
          </div>
        ) : null}
        <div className="table-wrap">
          <table className="trash-table">
            <thead>
              <tr>
                {canEdit ? (
                  <th className="trash-check-cell">
                    <input aria-label="Select all trash files" checked={allSelected} onChange={(event) => toggleAll(event.target.checked)} type="checkbox" />
                  </th>
                ) : null}
                <th>File</th>
                <th>Source</th>
                <th>Document</th>
                <th>Owner</th>
                <th>Reason</th>
                <th>Deleted on</th>
                <th>Delete in</th>
                <th>File</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              {items.length ? items.map((item) => (
                <tr key={item.key}>
                  {canEdit ? (
                    <td className="trash-check-cell">
                      <input
                        checked={selectedSet.has(item.key)}
                        name="trash_key"
                        onChange={(event) => toggleItem(item.key, event.target.checked)}
                        type="checkbox"
                        value={item.key}
                      />
                    </td>
                  ) : null}
                  <td><strong>{item.fileName}</strong></td>
                  <td><span className="status-pill">{item.source === "fleet" ? "Fleet" : "Business"}</span></td>
                  <td>{item.documentName}</td>
                  <td>{item.owner}</td>
                  <td>{item.reason}</td>
                  <td>{formatDateTime(item.deletedAt)}</td>
                  <td><span className={deleteClass(item.daysRemaining)}>{daysRemainingLabel(item.daysRemaining)}</span></td>
                  <td>
                    <div className="business-doc-file-actions">
                      <a className="icon-button" href={trashFileUrl(item, true)} target="_blank" rel="noreferrer" aria-label={`Open ${item.fileName}`} title="Open document">
                        <Eye size={16} />
                      </a>
                      <a className="icon-button" href={trashFileUrl(item, false)} aria-label={`Download ${item.fileName}`} title="Download document">
                        <Download size={16} />
                      </a>
                    </div>
                  </td>
                  <td>{item.sizeLabel}</td>
                </tr>
              )) : (
                <tr><td className="empty-cell" colSpan={canEdit ? 10 : 9}>Trash is empty.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </form>
  );
}

function TrashDeleteAction({ selectedCount }: { selectedCount: number }) {
  if (!selectedCount) {
    return (
      <button className="button danger trash-delete-button" disabled type="button">
        Delete selected
      </button>
    );
  }

  return (
    <SubmitButton
      className="button danger trash-delete-button"
      confirmDescription="This removes the selected files from storage and deletes their database entries."
      confirmMessage={`Permanently delete ${selectedCount} selected file${selectedCount === 1 ? "" : "s"}?`}
      confirmSubmitText="Delete permanently"
      pendingText="Deleting"
    >
      Delete selected ({selectedCount})
    </SubmitButton>
  );
}

function trashFileUrl(item: TrashItem, inline: boolean) {
  const params = new URLSearchParams({
    id: item.id,
    source: item.source
  });
  if (inline) params.set("disposition", "inline");
  return `/api/trash/file?${params.toString()}`;
}

function daysRemainingLabel(value: number | null) {
  if (value === null) return "-";
  if (value <= 0) return "Due now";
  if (value === 1) return "1 day";
  return `${value} days`;
}

function deleteClass(value: number | null) {
  if (value === null) return "status-pill";
  if (value <= 3) return "status-pill bad";
  if (value <= 7) return "status-pill warn";
  return "status-pill";
}

function formatDateTime(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}
