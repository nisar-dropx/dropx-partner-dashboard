"use client";

import { FormEvent, useDeferredValue, useMemo, useState } from "react";
import { saveProviderFirstMappingWorksheet } from "@/app/provider-mapping/actions";
import { SearchableSelect } from "@/components/searchable-select";
import { SubmitButton } from "@/components/submit-button";
import type { PaymentMethodOption } from "@/components/provider-mapping-worksheet";
import { matchNames } from "@/lib/name-match";

export type ProviderFirstWorker = {
  id: string;
  dropxId: string;
  fullName: string;
  stationId: string;
  providerId: string;
  dateOfJoin: string;
  mappingId: string;
  paymentMethodId: string;
  paymentValues: Record<string, string>;
  effectiveFrom: string;
  effectiveTo: string;
  mappedProviderMemberId: string;
  locationLabel: string;
  onboardingStatus: string;
};

export type ProviderFirstMappingRow = {
  providerMemberId: string;
  providerMemberName: string;
  stationId: string;
  stationLabel: string;
  providerId: string;
  workforceId: string;
  dropxId: string;
  dropxName: string;
  mappingId: string;
  paymentMethodId: string;
  paymentValues: Record<string, string>;
  effectiveFrom: string;
  effectiveTo: string;
};

function signature(row: ProviderFirstMappingRow) {
  return [row.providerMemberId, row.stationId, row.workforceId, row.mappingId, row.paymentMethodId, JSON.stringify(row.paymentValues), row.effectiveFrom, row.effectiveTo].join("|");
}

function namesMateriallyMatch(providerName: string, dropxName: string) {
  return matchNames(providerName, dropxName).status !== "none";
}

function isMappedToAnotherMember(row: ProviderFirstMappingRow, worker: ProviderFirstWorker | undefined) {
  return Boolean(worker?.mappedProviderMemberId && worker.mappedProviderMemberId !== row.providerMemberId);
}

function RowButton({ canEdit, dirty, index, nameMatches }: { canEdit: boolean; dirty: boolean; index: number; nameMatches: boolean }) {
  return <button className={`button compact mapping-row-save${dirty ? "" : " secondary"}`} disabled={!canEdit || !dirty || !nameMatches} name="save_row" type="submit" value={index}>{dirty ? "Save" : "Saved"}</button>;
}

export function ProviderFirstMappingWorksheet({ initialQuery = "", canEdit, mappings, workers, paymentMethods }: {
  initialQuery?: string;
  canEdit: boolean;
  mappings: ProviderFirstMappingRow[];
  workers: ProviderFirstWorker[];
  paymentMethods: PaymentMethodOption[];
}) {
  const initialRows = useMemo(() => mappings, [mappings]);
  const initialSignatures = useMemo(() => initialRows.map(signature), [initialRows]);
  const [rows, setRows] = useState(initialRows);
  const [query, setQuery] = useState(initialQuery);
  const deferredQuery = useDeferredValue(query);
  const [stationFilter, setStationFilter] = useState("all");
  const [methodFilter, setMethodFilter] = useState("all");
  const [mappingFilter, setMappingFilter] = useState("all");
  const [validationFilter, setValidationFilter] = useState("all");
  const [errors, setErrors] = useState<Record<number, string>>({});
  const paymentMethodById = useMemo(() => new Map(paymentMethods.map((method) => [method.id, method])), [paymentMethods]);
  const paymentOptions = useMemo(() => paymentMethods.map((method) => ({ value: method.id, label: method.name, helper: method.code })), [paymentMethods]);
  const workerOptions = useMemo(() => workers.map((worker) => ({
    value: worker.id,
    label: `${worker.dropxId} — ${worker.fullName}`,
    helper: `${worker.locationLabel}${worker.onboardingStatus ? ` · ${worker.onboardingStatus}` : ""}`
  })), [workers]);
  const stations = useMemo(() => Array.from(new Map(rows.map((row) => [row.stationId, row.stationLabel])).entries()), [rows]);

  const dirtyRows = rows.map((row, index) => signature(row) !== initialSignatures[index]);
  const hasDirty = dirtyRows.some(Boolean);
  const hasDirtyNameMismatch = rows.some((row, index) => dirtyRows[index] && Boolean(row.workforceId) && !namesMateriallyMatch(row.providerMemberName, row.dropxName));
  const hasDirtyMappingConflict = rows.some((row, index) => dirtyRows[index] && isMappedToAnotherMember(row, workers.find((worker) => worker.id === row.workforceId)));
  const hasDirtyLocationMismatch = rows.some((row, index) => dirtyRows[index] && Boolean(row.workforceId) && workers.find((worker) => worker.id === row.workforceId)?.stationId !== row.stationId);
  const visibleRows = useMemo(() => new Set(rows.flatMap((row, index) => {
    const worker = workers.find((item) => item.id === row.workforceId);
    const hasNameMismatch = Boolean(row.workforceId) && !namesMateriallyMatch(row.providerMemberName, row.dropxName);
    const hasLocationMismatch = Boolean(worker && worker.stationId !== row.stationId);
    const hasConflict = isMappedToAnotherMember(row, worker);
    const text = [row.providerMemberId, row.providerMemberName, row.dropxId, row.dropxName, row.stationLabel].join(" ").toLowerCase();
    const matchesQuery = !deferredQuery.trim() || text.includes(deferredQuery.trim().toLowerCase());
    const matchesStation = stationFilter === "all" || row.stationId === stationFilter;
    const matchesMethod = methodFilter === "all" || row.paymentMethodId === methodFilter;
    const matchesMapping = mappingFilter === "all" || (mappingFilter === "mapped" ? Boolean(row.workforceId) : !row.workforceId);
    const hasIssue = hasNameMismatch || hasLocationMismatch || hasConflict;
    const matchesValidation = validationFilter === "all" || (validationFilter === "needs_attention" ? hasIssue : Boolean(row.workforceId) && !hasIssue);
    return matchesQuery && matchesStation && matchesMethod && matchesMapping && matchesValidation || dirtyRows[index] ? [index] : [];
  })), [rows, workers, deferredQuery, stationFilter, methodFilter, mappingFilter, validationFilter, dirtyRows]);
  const visibleCount = Array.from(visibleRows).filter((index) => !dirtyRows[index]).length;
  const hasFilters = Boolean(query || stationFilter !== "all" || methodFilter !== "all" || mappingFilter !== "all" || validationFilter !== "all");
  function clearFilters() { setQuery(""); setStationFilter("all"); setMethodFilter("all"); setMappingFilter("all"); setValidationFilter("all"); }

  function update(index: number, change: Partial<ProviderFirstMappingRow>) {
    setErrors((current) => { const next = { ...current }; delete next[index]; return next; });
    setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...change } : row));
  }

  function chooseWorker(index: number, workerId: string) {
    const worker = workers.find((item) => item.id === workerId);
    if (!worker) {
      update(index, { workforceId: "", dropxId: "", dropxName: "", mappingId: "", paymentMethodId: "", paymentValues: {}, effectiveFrom: "", effectiveTo: "" });
      return;
    }
    const row = rows[index];
    update(index, {
      workforceId: worker.id,
      dropxId: worker.dropxId,
      dropxName: worker.fullName,
      // Keep this provider-member row's history row when it already exists.
      // For an unlinked provider member, reuse the selected worker's mapping
      // row so the reverse worksheet has the same update semantics as the
      // existing DropX-first worksheet.
      mappingId: row.mappingId || worker.mappingId,
      providerId: row.providerId || worker.providerId,
      paymentMethodId: worker.paymentMethodId,
      paymentValues: worker.paymentValues,
      effectiveFrom: worker.effectiveFrom || worker.dateOfJoin,
      effectiveTo: worker.effectiveTo
    });
  }

  function validate(row: ProviderFirstMappingRow, index: number) {
    if (!row.workforceId) return `Row ${index + 1}: Select a DropX workforce ID.`;
    if (workers.find((worker) => worker.id === row.workforceId)?.stationId !== row.stationId) return `Row ${index + 1}: Location mismatch.`;
    if (isMappedToAnotherMember(row, workers.find((worker) => worker.id === row.workforceId))) return `Row ${index + 1}: This DropX ID is already mapped to another Provider Member ID.`;
    if (!namesMateriallyMatch(row.providerMemberName, row.dropxName)) return `Row ${index + 1}: Name mismatch.`;
    if (!row.providerId) return `Row ${index + 1}: The selected location has no provider.`;
    if (!row.paymentMethodId) return `Row ${index + 1}: Payment method is required.`;
    if (!row.effectiveFrom) return `Row ${index + 1}: Effective from is required.`;
    if (row.effectiveTo && row.effectiveTo < row.effectiveFrom) return `Row ${index + 1}: Effective to cannot be before effective from.`;
    const method = paymentMethodById.get(row.paymentMethodId);
    if (!method) return `Row ${index + 1}: Payment method is invalid.`;
    for (const component of method.components) {
      const raw = row.paymentValues[component.code]?.trim() ?? "";
      const amount = Number(raw);
      if (!raw) return `Row ${index + 1}: ${component.label} is required.`;
      if (!Number.isFinite(amount) || amount < 0) return `Row ${index + 1}: ${component.label} must be a valid amount.`;
    }
    return null;
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const selected = submitter?.name === "save_row" ? [Number(submitter.value)] : rows.map((_, index) => index).filter((index) => dirtyRows[index]);
    const next: Record<number, string> = {};
    selected.forEach((index) => { const message = validate(rows[index], index); if (message) next[index] = message; });
    setErrors(next);
    if (Object.keys(next).length) event.preventDefault();
  }

  if (!rows.length) return <section className="panel"><div className="empty-state"><strong>No provider members found.</strong><p className="subtle">Import provider production data first, then map each Provider Member ID to a workforce DropX ID.</p></div></section>;

  return <form action={saveProviderFirstMappingWorksheet} autoComplete="off" className="worksheet-form" noValidate onSubmit={submit}>
    <input name="row_count" type="hidden" value={rows.length} />
    <input name="dirty_row_indexes" type="hidden" value={JSON.stringify(dirtyRows.flatMap((dirty, index) => dirty ? [index] : []))} />
    <section className="panel">
      <div className="panel-head provider-first-panel-head"><div><h2>Provider member mapping</h2></div><SubmitButton className="button mapping-save-all" disabled={!canEdit || !hasDirty || hasDirtyNameMismatch || hasDirtyMappingConflict || hasDirtyLocationMismatch} disabledText={!canEdit ? "No edit access" : hasDirtyLocationMismatch ? "Fix location mismatches" : hasDirtyMappingConflict ? "Resolve mapping conflicts" : hasDirtyNameMismatch ? "Fix name mismatches" : "No edits"}>Save changes</SubmitButton></div>
            <div className="provider-first-filters">
        <label className="provider-first-search"><span>Search</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Provider member, DropX ID or name" /></label>
        <label><span>Location</span><select value={stationFilter} onChange={(event) => setStationFilter(event.target.value)}><option value="all">All locations</option>{stations.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label><span>Payment method</span><select value={methodFilter} onChange={(event) => setMethodFilter(event.target.value)}><option value="all">All methods</option>{paymentMethods.map((method) => <option key={method.id} value={method.id}>{method.name}</option>)}</select></label>
        <label><span>Mapping</span><select value={mappingFilter} onChange={(event) => setMappingFilter(event.target.value)}><option value="all">All records</option><option value="mapped">Mapped</option><option value="unmapped">Unmapped</option></select></label>
        <label><span>Validation</span><select value={validationFilter} onChange={(event) => setValidationFilter(event.target.value)}><option value="all">All statuses</option><option value="ready">Ready</option><option value="needs_attention">Needs attention</option></select></label>
        <div className="provider-first-filter-summary"><strong>{visibleCount}</strong><span>shown</span>{hasFilters ? <button className="button secondary compact" onClick={clearFilters} type="button">Clear</button> : null}</div>
      </div>
      <div className="mapping-rows">{rows.map((row, index) => {
        const selectedWorker = workers.find((worker) => worker.id === row.workforceId);
        const mappingConflict = isMappedToAnotherMember(row, selectedWorker);
        const locationMismatch = Boolean(selectedWorker && selectedWorker.stationId !== row.stationId);
        const components = paymentMethodById.get(row.paymentMethodId)?.components ?? [];
        if (!visibleRows.has(index)) return null;
        return <div className={`mapping-row-card provider-first-row ${dirtyRows[index] ? "unsaved-row" : ""}`} key={row.providerMemberId}>
          <input name={`rows[${index}][id]`} type="hidden" value={row.workforceId} />
          <input name={`rows[${index}][source_type]`} type="hidden" value="workforce" />
          <input name={`rows[${index}][mapping_id]`} type="hidden" value={row.mappingId} />
          <input name={`rows[${index}][dropx_id]`} type="hidden" value={row.dropxId} />
          <input name={`rows[${index}][dropx_name]`} type="hidden" value={row.dropxName} />
          <input name={`rows[${index}][provider_id]`} type="hidden" value={row.providerId} />
          <input name={`rows[${index}][station_id]`} type="hidden" value={row.stationId} />
          <input name={`rows[${index}][provider_member_id]`} type="hidden" value={row.providerMemberId} />
          <input name={`rows[${index}][payment_values_json]`} type="hidden" value={JSON.stringify(row.paymentValues)} />
          {dirtyRows[index] ? <span className="unsaved-badge mapping-unsaved-badge">Unsaved</span> : null}
          <div className="mapping-identity"><span className="mapping-dropx-id mono">{row.providerMemberId}</span><strong>{row.providerMemberName}</strong><span>{row.stationLabel}</span></div>
          <div className="mapping-edit-grid">
            <div className="mapping-field mapping-payment-method-select provider-first-workforce-select"><span className="mapping-field-label">DropX workforce ID</span><SearchableSelect disabled={!canEdit} maxOptions={5000} name={`provider_first_worker_${index}`} onValueChange={(value) => chooseWorker(index, value)} options={workerOptions} placeholder="Select DropX workforce" value={row.workforceId} /></div>
            <div className="mapping-field mapping-payment-method-select"><span className="mapping-field-label">Payment method</span><SearchableSelect disabled={!canEdit || !row.workforceId} name={`rows[${index}][payment_method_id]`} onValueChange={(value) => update(index, { paymentMethodId: value, paymentValues: {} })} options={paymentOptions} placeholder="Search payment method" required value={row.paymentMethodId} /></div>
            {components.map((component) => <label key={component.code}>{component.label}<input className="worksheet-input" disabled={!canEdit || !row.workforceId} min="0" onChange={(event) => update(index, { paymentValues: { ...row.paymentValues, [component.code]: event.target.value } })} placeholder="0.00" step="0.01" type="number" value={row.paymentValues[component.code] ?? ""} /></label>)}
            <div className="mapping-period-row"><label>Effective from<input className="worksheet-input" disabled={!canEdit || !row.workforceId} name={`rows[${index}][effective_from]`} onChange={(event) => update(index, { effectiveFrom: event.target.value })} type="date" value={row.effectiveFrom} /></label><label>Effective to<input className="worksheet-input" disabled={!canEdit || !row.workforceId} name={`rows[${index}][effective_to]`} onChange={(event) => update(index, { effectiveTo: event.target.value })} type="date" value={row.effectiveTo} /></label></div>
            {row.workforceId && !namesMateriallyMatch(row.providerMemberName, row.dropxName) ? <div className="mapping-row-error">Name mismatch</div> : null}
            {locationMismatch ? <div className="mapping-row-error">Location mismatch</div> : null}
            {mappingConflict ? <div className="mapping-row-error">This DropX ID is already mapped to Provider Member ID {selectedWorker?.mappedProviderMemberId}. Select another DropX ID. Save is blocked.</div> : null}
            {errors[index] ? <div className="mapping-row-error">{errors[index]}</div> : null}
          </div>
          <div className="mapping-row-actions"><RowButton canEdit={canEdit} dirty={dirtyRows[index]} index={index} nameMatches={(!row.workforceId || namesMateriallyMatch(row.providerMemberName, row.dropxName)) && !mappingConflict && !locationMismatch} /></div>
        </div>;
      })}</div>
    </section>
  </form>;
}
