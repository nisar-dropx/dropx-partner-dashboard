"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { saveProviderFirstMappingsInline } from "@/app/provider-mapping/actions";
import { SearchableSelect } from "@/components/searchable-select";
import { MappingMultiFilter, type PaymentMethodOption } from "@/components/provider-mapping-worksheet";
import {
  filterProviderFirstRowIndexes,
  providerMemberIdDisplay,
  providerFirstNamesMatch,
  providerFirstPageWindow,
  providerFirstRowIssue,
  providerMemberKey,
  type ProviderFirstMappingRowView,
  type ProviderFirstPageSize,
  type ProviderFirstWorkerView
} from "@/lib/provider-first-mapping-view";

export type ProviderFirstWorker = ProviderFirstWorkerView;
export type ProviderFirstMappingRow = ProviderFirstMappingRowView;

function signature(row: ProviderFirstMappingRow) {
  return [row.providerMemberId, row.stationId, row.workforceId, row.mappingId, row.paymentMethodId, JSON.stringify(row.paymentValues), row.effectiveFrom, row.effectiveTo].join("|");
}

function isMappedToAnotherMember(row: ProviderFirstMappingRow, worker: ProviderFirstWorker | undefined) {
  return Boolean(worker?.mappedProviderMemberId && providerMemberKey(row.stationId, worker.mappedProviderMemberId) !== providerMemberKey(row.stationId, row.providerMemberId));
}

function appendRow(formData: FormData, position: number, row: ProviderFirstMappingRow) {
  const prefix = `rows[${position}]`;
  formData.set(`${prefix}[client_key]`, providerMemberKey(row.stationId, row.providerMemberId));
  formData.set(`${prefix}[id]`, row.workforceId);
  formData.set(`${prefix}[source_type]`, "workforce");
  formData.set(`${prefix}[mapping_id]`, row.mappingId);
  formData.set(`${prefix}[dropx_id]`, row.dropxId);
  formData.set(`${prefix}[dropx_name]`, row.dropxName);
  formData.set(`${prefix}[provider_id]`, row.providerId);
  formData.set(`${prefix}[station_id]`, row.stationId);
  formData.set(`${prefix}[provider_member_id]`, row.providerMemberId);
  formData.set(`${prefix}[payment_method_id]`, row.paymentMethodId);
  formData.set(`${prefix}[payment_values_json]`, JSON.stringify(row.paymentValues));
  formData.set(`${prefix}[effective_from]`, row.effectiveFrom);
  formData.set(`${prefix}[effective_to]`, row.effectiveTo);
}

function RowButton({ busy, canEdit, dirty, index, nameMatches, onSave }: {
  busy: boolean;
  canEdit: boolean;
  dirty: boolean;
  index: number;
  nameMatches: boolean;
  onSave: (index: number) => void;
}) {
  return <button className={`button compact mapping-row-save${dirty ? "" : " secondary"}`} disabled={!canEdit || !dirty || !nameMatches || busy} onClick={() => onSave(index)} type="button">{busy ? "Saving..." : dirty ? "Save" : "Saved"}</button>;
}

export function ProviderFirstMappingWorksheet({ initialQuery = "", initialStationId = "", canEdit, mappings, workers, paymentMethods }: {
  initialQuery?: string;
  initialStationId?: string;
  canEdit: boolean;
  mappings: ProviderFirstMappingRow[];
  workers: ProviderFirstWorker[];
  paymentMethods: PaymentMethodOption[];
}) {
  const [rows, setRows] = useState(() => mappings);
  const [baselineRows, setBaselineRows] = useState(() => mappings);
  const [workerRows, setWorkerRows] = useState(() => workers);
  const [query, setQuery] = useState(initialQuery);
  const deferredQuery = useDeferredValue(query);
  const [stationFilters, setStationFilters] = useState<string[]>(initialStationId ? [initialStationId] : []);
  const [methodFilters, setMethodFilters] = useState<string[]>([]);
  const [mappingFilters, setMappingFilters] = useState<string[]>([]);
  const [validationFilters, setValidationFilters] = useState<string[]>([]);
  const [pageSize, setPageSize] = useState<ProviderFirstPageSize>(50);
  const [currentPage, setCurrentPage] = useState(1);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [savingIndexes, setSavingIndexes] = useState<Set<number>>(() => new Set());
  const [saveNotice, setSaveNotice] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  const paymentMethodById = useMemo(() => new Map(paymentMethods.map((method) => [method.id, method])), [paymentMethods]);
  const paymentOptions = useMemo(() => paymentMethods.filter((method) => method.isActive !== false).map((method) => ({ value: method.id, label: method.name, helper: method.code })), [paymentMethods]);
  const workerById = useMemo(() => new Map(workerRows.map((worker) => [worker.id, worker])), [workerRows]);
  const workerOptions = useMemo(() => workerRows.map((worker) => ({
    value: worker.id,
    label: `${worker.dropxId} — ${worker.fullName}`,
    helper: `${worker.locationLabel}${worker.onboardingStatus ? ` · ${worker.onboardingStatus}` : ""}`
  })), [workerRows]);
  const stations = useMemo(() => Array.from(new Map(rows.map((row) => [row.stationId, row.stationLabel])).entries()), [rows]);
  const dirtyRows = useMemo(() => rows.map((row, index) => signature(row) !== signature(baselineRows[index])), [rows, baselineRows]);
  const dirtyIndexes = useMemo(() => dirtyRows.flatMap((dirty, index) => dirty ? [index] : []), [dirtyRows]);
  const hasDirty = dirtyIndexes.length > 0;
  const hasDirtyNameMismatch = dirtyIndexes.some((index) => Boolean(rows[index].workforceId) && !providerFirstNamesMatch(rows[index].providerMemberName, rows[index].dropxName));
  const hasDirtyMappingConflict = dirtyIndexes.some((index) => isMappedToAnotherMember(rows[index], workerById.get(rows[index].workforceId)));
  const hasDirtyLocationMismatch = dirtyIndexes.some((index) => Boolean(rows[index].workforceId) && workerById.get(rows[index].workforceId)?.stationId !== rows[index].stationId);
  const isSaving = savingIndexes.size > 0;

  const visibleIndexes = useMemo(() => filterProviderFirstRowIndexes({
    rows,
    workerById,
    paymentMethodById,
    filters: {
      query: deferredQuery,
      stationIds: stationFilters,
      paymentMethodIds: methodFilters,
      mappingStatuses: mappingFilters,
      validationStatuses: validationFilters
    }
  }), [rows, workerById, paymentMethodById, deferredQuery, stationFilters, methodFilters, mappingFilters, validationFilters]);
  const pageWindow = providerFirstPageWindow(visibleIndexes.length, currentPage, pageSize);
  const paginatedIndexes = useMemo(() => visibleIndexes.slice(pageWindow.fromIndex, pageWindow.toIndex), [visibleIndexes, pageWindow.fromIndex, pageWindow.toIndex]);
  const hasFilters = Boolean(query || stationFilters.length || methodFilters.length || mappingFilters.length || validationFilters.length);

  function resetPage() { setCurrentPage(1); }

  function clearFilters() {
    setQuery("");
    setStationFilters([]);
    setMethodFilters([]);
    setMappingFilters([]);
    setValidationFilters([]);
    resetPage();
  }

  function update(index: number, change: Partial<ProviderFirstMappingRow>) {
    setErrors((current) => { const next = { ...current }; delete next[index]; return next; });
    setSaveNotice(null);
    setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...change } : row));
  }

  function chooseWorker(index: number, workerId: string) {
    const worker = workerById.get(workerId);
    if (!worker) {
      update(index, { workforceId: "", dropxId: "", dropxName: "", mappingId: "", paymentMethodId: "", paymentValues: {}, effectiveFrom: "", effectiveTo: "" });
      return;
    }
    const row = rows[index];
    update(index, {
      workforceId: worker.id,
      dropxId: worker.dropxId,
      dropxName: worker.fullName,
      mappingId: row.mappingId || worker.mappingId,
      providerId: row.providerId || worker.providerId,
      paymentMethodId: worker.paymentMethodId,
      paymentValues: worker.paymentValues,
      effectiveFrom: worker.effectiveFrom || worker.dateOfJoin,
      effectiveTo: worker.effectiveTo
    });
  }

  async function saveIndexes(indexes: number[]) {
    if (isSaving) return;
    const selected = Array.from(new Set(indexes)).filter((index) => dirtyRows[index]);
    const nextErrors: Record<number, string> = {};
    for (const index of selected) {
      const message = providerFirstRowIssue(rows[index], workerById.get(rows[index].workforceId), paymentMethodById.get(rows[index].paymentMethodId));
      if (message) nextErrors[index] = message;
    }
    setErrors((current) => ({ ...current, ...nextErrors }));
    if (!selected.length) return;
    if (Object.keys(nextErrors).length) {
      setSaveNotice({ kind: "error", message: Object.values(nextErrors)[0] });
      return;
    }

    const snapshots = selected.map((index) => ({
      index,
      key: providerMemberKey(rows[index].stationId, rows[index].providerMemberId),
      row: { ...rows[index], paymentValues: { ...rows[index].paymentValues } },
      previousWorkforceId: baselineRows[index]?.workforceId ?? ""
    }));
    const snapshotByKey = new Map(snapshots.map((snapshot) => [snapshot.key, snapshot]));
    const snapshotByIndex = new Map(snapshots.map((snapshot) => [snapshot.index, snapshot]));
    const data = new FormData();
    data.set("row_count", String(snapshots.length));
    snapshots.forEach((snapshot, position) => appendRow(data, position, snapshot.row));
    setSavingIndexes(new Set(selected));
    setSaveNotice(null);

    try {
      const result = await saveProviderFirstMappingsInline(data);
      const canonicalByIndex = new Map<number, ProviderFirstMappingRow>();
      for (const saved of result.savedRows) {
        const snapshot = snapshotByKey.get(saved.clientKey);
        if (!snapshot) continue;
        canonicalByIndex.set(snapshot.index, {
          ...snapshot.row,
          mappingId: saved.mappingId,
          workforceId: saved.workforceId,
          paymentMethodId: saved.paymentMethodId,
          paymentValues: saved.paymentValues,
          effectiveFrom: saved.effectiveFrom,
          effectiveTo: saved.effectiveTo
        });
      }

      if (canonicalByIndex.size) {
        setBaselineRows((current) => current.map((row, index) => canonicalByIndex.get(index) ?? row));
        setRows((current) => current.map((row, index) => {
          const canonical = canonicalByIndex.get(index);
          const snapshot = snapshotByIndex.get(index);
          if (!canonical || !snapshot) return row;
          if (signature(row) === signature(snapshot.row)) return canonical;
          return row.workforceId === snapshot.row.workforceId ? { ...row, mappingId: canonical.mappingId } : row;
        }));
        const workerUpdates = new Map<string, Partial<ProviderFirstWorker>>();
        const workerClears = new Map<string, string>();
        for (const snapshot of snapshots) {
          const canonical = canonicalByIndex.get(snapshot.index);
          if (!canonical) continue;
          if (snapshot.previousWorkforceId && snapshot.previousWorkforceId !== canonical.workforceId) {
            workerClears.set(snapshot.previousWorkforceId, snapshot.row.providerMemberId);
          }
          workerUpdates.set(canonical.workforceId, { mappingId: canonical.mappingId, paymentMethodId: canonical.paymentMethodId, paymentValues: canonical.paymentValues, effectiveFrom: canonical.effectiveFrom, effectiveTo: canonical.effectiveTo, mappedProviderMemberId: canonical.providerMemberId });
        }
        setWorkerRows((current) => current.map((worker) => {
          const update = workerUpdates.get(worker.id);
          if (update) return { ...worker, ...update };
          const expectedMember = workerClears.get(worker.id);
          return expectedMember && providerMemberKey(worker.stationId, worker.mappedProviderMemberId) === providerMemberKey(worker.stationId, expectedMember)
            ? { ...worker, mappingId: "", paymentMethodId: "", paymentValues: {}, effectiveFrom: "", effectiveTo: "", mappedProviderMemberId: "" }
            : worker;
        }));
        setErrors((current) => {
          const next = { ...current };
          canonicalByIndex.forEach((_, index) => delete next[index]);
          return next;
        });
      }

      if (!result.ok && result.failedClientKey) {
        const failed = snapshotByKey.get(result.failedClientKey);
        if (failed) setErrors((current) => ({ ...current, [failed.index]: result.message }));
      }
      setSaveNotice({ kind: result.ok ? "success" : "error", message: result.message });
    } catch (error) {
      setSaveNotice({ kind: "error", message: error instanceof Error ? error.message : "Unable to save provider mappings." });
    } finally {
      setSavingIndexes(new Set());
    }
  }

  if (!rows.length) return <section className="panel"><div className="empty-state"><strong>No provider members found.</strong><p className="subtle">Import provider production data first, then map each Provider Member ID to a workforce DropX ID.</p></div></section>;

  return <div className="worksheet-form">
    <section className="panel">
      <div className="panel-head provider-first-panel-head">
        <div><h2>Provider member mapping</h2>{saveNotice ? <p aria-live="polite" className={saveNotice.kind === "error" ? "mapping-upload-error" : "mapping-upload-success"}>{saveNotice.message}</p> : null}</div>
        <button className="button mapping-save-all" disabled={!canEdit || !hasDirty || hasDirtyNameMismatch || hasDirtyMappingConflict || hasDirtyLocationMismatch || isSaving} onClick={() => void saveIndexes(dirtyIndexes)} type="button">{isSaving ? "Saving..." : !canEdit ? "No edit access" : hasDirtyLocationMismatch ? "Fix location mismatches" : hasDirtyMappingConflict ? "Resolve mapping conflicts" : hasDirtyNameMismatch ? "Fix name mismatches" : hasDirty ? "Save changes" : "No edits"}</button>
      </div>
      <div className="provider-first-filters">
        <label className="provider-first-search"><span>Search</span><input type="search" value={query} onChange={(event) => { setQuery(event.target.value); resetPage(); }} placeholder="Provider member, DropX ID or name" /></label>
        <MappingMultiFilter allLabel="All locations" label="Location" options={stations.map(([value, label]) => ({ value, label, searchText: label }))} selected={stationFilters} setSelected={(values) => { setStationFilters(values); resetPage(); }} />
        <MappingMultiFilter allLabel="All methods" label="Payment method" options={[{ value: "unassigned", label: "No payment method", searchText: "unassigned no payment method" }, ...paymentMethods.map((method) => ({ value: method.id, label: `${method.name}${method.isActive === false ? " (Inactive)" : ""}`, searchText: `${method.name} ${method.code}` }))]} selected={methodFilters} setSelected={(values) => { setMethodFilters(values); resetPage(); }} />
        <MappingMultiFilter allLabel="All records" label="Mapping" options={[{ value: "mapped", label: "Mapped" }, { value: "unmapped", label: "Unmapped" }]} selected={mappingFilters} setSelected={(values) => { setMappingFilters(values); resetPage(); }} />
        <MappingMultiFilter allLabel="All statuses" label="Validation" options={[{ value: "ready", label: "Ready" }, { value: "needs_attention", label: "Needs attention" }, { value: "unmapped", label: "Unmapped" }]} selected={validationFilters} setSelected={(values) => { setValidationFilters(values); resetPage(); }} />
        <label className="mapping-page-size">Rows<select onChange={(event) => { const value = event.target.value; setPageSize(value === "all" ? "all" : Number(value) as ProviderFirstPageSize); resetPage(); }} value={pageSize}><option value="50">50</option><option value="100">100</option><option value="500">500</option><option value="1000">1000</option><option value="all">All</option></select></label>
        <div className="provider-first-filter-summary"><strong>{visibleIndexes.length}</strong><span>of {rows.length}</span>{hasFilters ? <button className="button secondary compact" onClick={clearFilters} type="button">Clear</button> : null}</div>
      </div>
      <div className="mapping-rows provider-first-rows">{paginatedIndexes.map((index) => {
        const row = rows[index];
        const selectedWorker = workerById.get(row.workforceId);
        const mappingConflict = isMappedToAnotherMember(row, selectedWorker);
        const locationMismatch = Boolean(selectedWorker && selectedWorker.stationId !== row.stationId);
        const selectedPaymentMethod = paymentMethodById.get(row.paymentMethodId);
        const rowPaymentOptions = selectedPaymentMethod?.isActive === false
          ? [{ value: selectedPaymentMethod.id, label: `${selectedPaymentMethod.name} (Inactive)`, helper: selectedPaymentMethod.code }, ...paymentOptions]
          : paymentOptions;
        const components = selectedPaymentMethod?.components ?? [];
        const displayedProviderMemberId = providerMemberIdDisplay(row.providerMemberId);
        const expandedScientificId = displayedProviderMemberId !== row.providerMemberId.trim();
        return <div className={`mapping-row-card provider-first-row ${dirtyRows[index] ? "unsaved-row" : ""}`} key={providerMemberKey(row.stationId, row.providerMemberId)}>
          {dirtyRows[index] ? <span className="unsaved-badge mapping-unsaved-badge">Unsaved</span> : null}
          <div className="mapping-identity">
            <span className="mapping-identity-kicker">Provider ID</span>
            <span className="mapping-dropx-id mono" title={expandedScientificId ? `Imported source value: ${row.providerMemberId}. Expanded for display; source digits may have been rounded.` : undefined}>{displayedProviderMemberId}</span>
            <span className="mapping-provider-name">{row.providerMemberName}</span>
            <span className="mapping-station-label">{row.stationLabel}</span>
          </div>
          <div className="mapping-edit-grid">
            <div className="mapping-field mapping-payment-method-select provider-first-workforce-select provider-first-selection-field"><span className="mapping-field-label">DropX ID / name</span><SearchableSelect disabled={!canEdit || isSaving} maxOptions={5000} name={`provider_first_worker_${index}`} onValueChange={(value) => chooseWorker(index, value)} options={workerOptions} placeholder="Select DropX workforce" value={row.workforceId} />{row.workforceId ? <span className="provider-first-selected-detail" title={`${row.dropxId} · ${row.dropxName}`}>{row.dropxId} · {row.dropxName}</span> : null}</div>
            <div className="mapping-field mapping-payment-method-select provider-first-selection-field"><span className="mapping-field-label">Payment method</span><SearchableSelect disabled={!canEdit || !row.workforceId || isSaving} name={`provider_first_payment_method_${index}`} onValueChange={(value) => update(index, { paymentMethodId: value, paymentValues: {} })} options={rowPaymentOptions} placeholder="Search payment method" required value={row.paymentMethodId} />{selectedPaymentMethod ? <span className="provider-first-selected-detail" title={`${selectedPaymentMethod.name} · ${selectedPaymentMethod.code}${selectedPaymentMethod.isActive === false ? " · Inactive" : ""}`}>{selectedPaymentMethod.name} · {selectedPaymentMethod.code}{selectedPaymentMethod.isActive === false ? " · Inactive" : ""}</span> : null}</div>
            {components.map((component) => <label key={component.code}>{component.label}<input className="worksheet-input" disabled={!canEdit || !row.workforceId || isSaving} min="0" onChange={(event) => update(index, { paymentValues: { ...row.paymentValues, [component.code]: event.target.value } })} placeholder="0.00" step="0.01" type="number" value={row.paymentValues[component.code] ?? ""} /></label>)}
            <div className="mapping-period-row"><label>Effective from<input className="worksheet-input" disabled={!canEdit || !row.workforceId || isSaving} onChange={(event) => update(index, { effectiveFrom: event.target.value })} type="date" value={row.effectiveFrom} /></label><label>Effective to<input className="worksheet-input" disabled={!canEdit || !row.workforceId || isSaving} onChange={(event) => update(index, { effectiveTo: event.target.value })} type="date" value={row.effectiveTo} /></label></div>
            {row.workforceId && !providerFirstNamesMatch(row.providerMemberName, row.dropxName) ? <div className="mapping-row-error">Name mismatch</div> : null}
            {locationMismatch ? <div className="mapping-row-error">Location mismatch</div> : null}
            {mappingConflict ? <div className="mapping-row-error">This DropX ID is already mapped to Provider Member ID {selectedWorker?.mappedProviderMemberId}. Select another DropX ID. Save is blocked.</div> : null}
            {errors[index] ? <div className="mapping-row-error">{errors[index]}</div> : null}
          </div>
          <div className="mapping-row-actions"><RowButton busy={isSaving} canEdit={canEdit} dirty={dirtyRows[index]} index={index} nameMatches={(!row.workforceId || providerFirstNamesMatch(row.providerMemberName, row.dropxName)) && !mappingConflict && !locationMismatch} onSave={(rowIndex) => void saveIndexes([rowIndex])} /></div>
        </div>;
      })}{!paginatedIndexes.length ? <div className="empty-state"><strong>No matching provider members.</strong><p className="subtle">Change or clear the filters to see more records.</p></div> : null}</div>
      <div className="mapping-pagination">
        <span>Showing {pageWindow.shownFrom}–{pageWindow.shownTo} of {visibleIndexes.length}</span>
        <div className="mapping-pagination-actions"><button className="button secondary compact" disabled={pageWindow.page <= 1} onClick={() => setCurrentPage((page) => Math.max(1, page - 1))} type="button">Previous</button><span>Page {pageWindow.page} of {pageWindow.totalPages}</span><button className="button secondary compact" disabled={pageWindow.page >= pageWindow.totalPages} onClick={() => setCurrentPage((page) => Math.min(pageWindow.totalPages, page + 1))} type="button">Next</button></div>
      </div>
    </section>
  </div>;
}
