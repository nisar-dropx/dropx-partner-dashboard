"use client";

import { useMemo, useState, useTransition } from "react";
import { StatusPill } from "@/components/status-pill";
import { applyBulkPortalAccess, normalizePortalCodes, portalAccessChanged, type LocationPortalAccessDraft } from "@/lib/location-portal-access";
import styles from "./location-portal-access-panel.module.css";

export type LocationPortalAccessProduct = { code: string; label: string };

export type LocationPortalAccessRow = {
  locationId: string;
  code: string;
  name: string;
  email: string | null;
  profileId: string | null;
  enabledProducts: string[];
};

export type LocationPortalAccessSaveResult = {
  ok: boolean;
  savedLocationIds: string[];
  savedAccess: Array<{ locationId: string; productCodes: string[] }>;
  errors: Array<{ locationId: string; message: string }>;
  message: string;
};

const PAGE_SIZE = 10;

function accessByLocation(rows: readonly LocationPortalAccessRow[]) {
  return Object.fromEntries(rows.map((row) => [row.locationId, normalizePortalCodes(row.enabledProducts)]));
}

export function LocationPortalAccessPanel({ canEdit, products, rows, saveAction }: {
  canEdit: boolean;
  products: readonly LocationPortalAccessProduct[];
  rows: LocationPortalAccessRow[];
  saveAction: (updates: Array<{ locationId: string; productCodes: string[] }>) => Promise<LocationPortalAccessSaveResult>;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [baseline, setBaseline] = useState<LocationPortalAccessDraft>(() => accessByLocation(rows));
  const [draft, setDraft] = useState<LocationPortalAccessDraft>(() => accessByLocation(rows));
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [isSaving, startSaving] = useTransition();

  const editableIds = useMemo(() => new Set(rows.filter((row) => row.profileId && row.email).map((row) => row.locationId)), [rows]);
  const filteredRows = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return rows;
    return rows.filter((row) => [row.code, row.name, row.email].some((value) => String(value ?? "").toLowerCase().includes(normalized)));
  }, [query, rows]);
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const visibleRows = filteredRows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const visibleEditableIds = visibleRows.filter((row) => editableIds.has(row.locationId)).map((row) => row.locationId);
  const filteredEditableIds = filteredRows.filter((row) => editableIds.has(row.locationId)).map((row) => row.locationId);
  const dirtyIds = rows
    .filter((row) => editableIds.has(row.locationId) && portalAccessChanged(baseline[row.locationId] ?? [], draft[row.locationId] ?? []))
    .map((row) => row.locationId);
  const allVisibleSelected = visibleEditableIds.length > 0 && visibleEditableIds.every((locationId) => selectedIds.has(locationId));

  function setLocationProduct(locationId: string, productCode: string, enabled: boolean) {
    setDraft((current) => applyBulkPortalAccess(current, [locationId], productCode, enabled));
    setFeedback(null);
  }

  function setBulkProduct(productCode: string, enabled: boolean) {
    setDraft((current) => applyBulkPortalAccess(current, [...selectedIds], productCode, enabled));
    setFeedback(null);
  }

  function toggleSelected(locationId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(locationId)) next.delete(locationId);
      else next.add(locationId);
      return next;
    });
  }

  function selectVisible() {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) visibleEditableIds.forEach((locationId) => next.delete(locationId));
      else visibleEditableIds.forEach((locationId) => next.add(locationId));
      return next;
    });
  }

  function discardChanges() {
    setDraft(Object.fromEntries(Object.entries(baseline).map(([locationId, codes]) => [locationId, [...codes]])));
    setFeedback(null);
  }

  function saveChanges() {
    if (!dirtyIds.length || isSaving) return;
    const updates = dirtyIds.map((locationId) => ({ locationId, productCodes: draft[locationId] ?? [] }));
    setFeedback(null);
    startSaving(async () => {
      try {
        const result = await saveAction(updates);
        const savedIds = new Set(result.savedLocationIds);
        if (savedIds.size) {
          const savedProducts = new Map(result.savedAccess.map((item) => [item.locationId, normalizePortalCodes(item.productCodes)]));
          setBaseline((current) => {
            const next = { ...current };
            savedIds.forEach((locationId) => { next[locationId] = [...(savedProducts.get(locationId) ?? draft[locationId] ?? [])]; });
            return next;
          });
          setDraft((current) => {
            const next = { ...current };
            savedIds.forEach((locationId) => { next[locationId] = [...(savedProducts.get(locationId) ?? current[locationId] ?? [])]; });
            return next;
          });
          setSelectedIds((current) => new Set([...current].filter((locationId) => !savedIds.has(locationId))));
        }
        setFeedback({ tone: result.ok ? "success" : "error", message: result.message });
      } catch (error) {
        setFeedback({ tone: "error", message: error instanceof Error ? error.message : "Access changes could not be saved." });
      }
    });
  }

  return <section className="panel">
    <div className="panel-head toolbar">
      <div>
        <h2>Location portal access</h2>
        <p className="subtle">Edit stations in place, apply one change to multiple locations, then save everything once.</p>
      </div>
      <a className="button secondary" href="/master/location">Location Master</a>
    </div>
    <div className={`panel-body ${styles.searchRow}`}>
      <input aria-label="Search locations" className={`field ${styles.search}`} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Search station code, name, or DropX email" value={query} />
      {canEdit && filteredEditableIds.length ? <button className="button secondary compact" onClick={() => setSelectedIds(new Set(filteredEditableIds))} type="button">Select all {filteredEditableIds.length} matching</button> : null}
    </div>
    {canEdit ? <div className={styles.bulkBar}>
      <span className={styles.bulkLabel}>{selectedIds.size ? `${selectedIds.size} selected` : "Select locations"}</span>
      {products.map((product) => <div className={styles.bulkGroup} key={product.code}>
        <strong>{product.label}</strong>
        <button className={styles.miniButton} disabled={!selectedIds.size || isSaving} onClick={() => setBulkProduct(product.code, true)} type="button">Enable</button>
        <button className={styles.miniButton} disabled={!selectedIds.size || isSaving} onClick={() => setBulkProduct(product.code, false)} type="button">Turn off</button>
      </div>)}
      {selectedIds.size ? <button className={styles.miniButton} onClick={() => setSelectedIds(new Set())} type="button">Clear selection</button> : null}
    </div> : null}
    <div className="table-wrap">
      <table style={{ minWidth: 1080 }}>
        <thead><tr><th style={{ width: 42 }}>{canEdit ? <input aria-label="Select all visible locations" checked={allVisibleSelected} onChange={selectVisible} type="checkbox" /> : null}</th><th>Location</th><th>DropX mailbox</th>{products.map((product) => <th key={product.code}>{product.label}</th>)}<th>Status</th></tr></thead>
        <tbody>
          {visibleRows.map((row) => {
            const canSave = canEdit && editableIds.has(row.locationId);
            const isDirty = canSave && portalAccessChanged(baseline[row.locationId] ?? [], draft[row.locationId] ?? []);
            const isSelected = selectedIds.has(row.locationId);
            return <tr className={`${isSelected ? styles.selectedRow : ""} ${isDirty ? styles.dirtyRow : ""}`} key={row.locationId}>
              <td>{canSave ? <input aria-label={`Select ${row.code}`} checked={isSelected} onChange={() => toggleSelected(row.locationId)} type="checkbox" /> : null}</td>
              <td><strong>{row.code}</strong><div className="subtle">{row.name}</div></td>
              <td>{row.email ? <><strong>{row.email}</strong><div className="subtle">{row.profileId ? "Identity linked" : "Save this mailbox in Location Master to link it"}</div></> : <StatusPill status="Mailbox required" />}</td>
              {products.map((product) => {
                const enabled = (draft[row.locationId] ?? []).includes(product.code);
                return <td className={styles.portalCell} key={product.code}><label className={styles.checkLabel}><input checked={enabled} disabled={!canSave || isSaving} onChange={(event) => setLocationProduct(row.locationId, product.code, event.target.checked)} type="checkbox" /><span>{enabled ? "Enabled" : "Off"}</span></label></td>;
              })}
              <td className={styles.rowStatus}>{canSave ? isDirty ? <span className={styles.unsaved}>Unsaved</span> : <span className={styles.saved}>Saved</span> : <span className="subtle">Setup required</span>}</td>
            </tr>;
          })}
          {!visibleRows.length ? <tr><td className="empty-cell" colSpan={products.length + 4}>No matching active location was found.</td></tr> : null}
        </tbody>
      </table>
    </div>
    {totalPages > 1 ? <div className="pagination"><button className="pager-button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)} type="button">Prev</button><span>Page {currentPage} of {totalPages}</span><button className="pager-button" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)} type="button">Next</button></div> : null}
    {canEdit && (dirtyIds.length || feedback) ? <div className={styles.footerBar}>
      <p className={`${styles.feedback} ${feedback?.tone === "error" ? styles.feedbackError : ""}`} role="status">{feedback?.message ?? `${dirtyIds.length} location${dirtyIds.length === 1 ? "" : "s"} changed`}</p>
      <div className={styles.footerActions}>{dirtyIds.length ? <button className="button secondary" disabled={isSaving} onClick={discardChanges} type="button">Discard</button> : null}{dirtyIds.length ? <button className="button" disabled={isSaving} onClick={saveChanges} type="button">{isSaving ? "Saving changes…" : `Save ${dirtyIds.length} change${dirtyIds.length === 1 ? "" : "s"}`}</button> : null}</div>
    </div> : null}
  </section>;
}
