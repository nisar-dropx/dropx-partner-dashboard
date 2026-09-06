"use client";

import { FormEvent, useMemo, useState } from "react";
import { saveProviderFirstMappingWorksheet } from "@/app/provider-mapping/actions";
import { SearchableSelect } from "@/components/searchable-select";
import { SubmitButton } from "@/components/submit-button";
import type { PaymentMethodOption } from "@/components/provider-mapping-worksheet";

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

function nameTokens(value: string) {
  return value.split("/")[0].normalize("NFKD").toLocaleUpperCase()
    .split(/[^\p{L}\p{N}]+/u).map((token) => token.trim()).filter(Boolean);
}

function namesMateriallyMatch(providerName: string, dropxName: string) {
  const providerTokens = new Set(nameTokens(providerName));
  const dropxTokens = new Set(nameTokens(dropxName));
  if (!providerTokens.size || !dropxTokens.size) return false;
  const matching = Array.from(providerTokens).filter((token) => dropxTokens.has(token)).length;
  const smaller = Math.min(providerTokens.size, dropxTokens.size);
  const larger = Math.max(providerTokens.size, dropxTokens.size);
  return matching >= 2 && matching === smaller && matching / larger >= 2 / 3;
}

function isMappedToAnotherMember(row: ProviderFirstMappingRow, worker: ProviderFirstWorker | undefined) {
  return Boolean(worker?.mappedProviderMemberId && worker.mappedProviderMemberId !== row.providerMemberId);
}

function RowButton({ canEdit, dirty, index, nameMatches }: { canEdit: boolean; dirty: boolean; index: number; nameMatches: boolean }) {
  return <button className={`button compact mapping-row-save${dirty ? "" : " secondary"}`} disabled={!canEdit || !dirty || !nameMatches} name="save_row" type="submit" value={index}>{dirty ? "Save" : "Saved"}</button>;
}

export function ProviderFirstMappingWorksheet({ canEdit, mappings, workers, paymentMethods }: {
  canEdit: boolean;
  mappings: ProviderFirstMappingRow[];
  workers: ProviderFirstWorker[];
  paymentMethods: PaymentMethodOption[];
}) {
  const initialRows = useMemo(() => mappings, [mappings]);
  const initialSignatures = useMemo(() => initialRows.map(signature), [initialRows]);
  const [rows, setRows] = useState(initialRows);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const paymentMethodById = useMemo(() => new Map(paymentMethods.map((method) => [method.id, method])), [paymentMethods]);
  const paymentOptions = useMemo(() => paymentMethods.map((method) => ({ value: method.id, label: method.name, helper: method.code })), [paymentMethods]);

  const dirtyRows = rows.map((row, index) => signature(row) !== initialSignatures[index]);
  const hasDirty = dirtyRows.some(Boolean);
  const hasDirtyNameMismatch = rows.some((row, index) => dirtyRows[index] && Boolean(row.workforceId) && !namesMateriallyMatch(row.providerMemberName, row.dropxName));
  const hasDirtyMappingConflict = rows.some((row, index) => dirtyRows[index] && isMappedToAnotherMember(row, workers.find((worker) => worker.id === row.workforceId)));

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
    if (isMappedToAnotherMember(row, workers.find((worker) => worker.id === row.workforceId))) return `Row ${index + 1}: This DropX ID is already mapped to another Provider Member ID.`;
    if (!namesMateriallyMatch(row.providerMemberName, row.dropxName)) return `Row ${index + 1}: Provider member name does not materially match the selected DropX name.`;
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
      <div className="panel-head"><div><h2>Provider member → DropX ID & pay mapping</h2><p className="subtle">Provider Member ID is read-only. Select the DropX workforce ID, then configure payment method, rates and dates exactly as in the existing worksheet.</p></div><SubmitButton className="button mapping-save-all" disabled={!canEdit || !hasDirty || hasDirtyNameMismatch || hasDirtyMappingConflict} disabledText={!canEdit ? "No edit access" : hasDirtyMappingConflict ? "Resolve mapping conflicts" : hasDirtyNameMismatch ? "Fix name mismatches" : "No edits"}>Save all</SubmitButton></div>
      <div className="mapping-rows">{rows.map((row, index) => {
        const availableWorkers = workers;
        const selectedWorker = workers.find((worker) => worker.id === row.workforceId);
        const mappingConflict = isMappedToAnotherMember(row, selectedWorker);
        const workerOptions = availableWorkers.map((worker) => ({ value: worker.id, label: `${worker.dropxId} — ${worker.fullName}`, helper: `${worker.locationLabel} · ${worker.onboardingStatus || "No status"}${worker.mappedProviderMemberId && worker.mappedProviderMemberId !== row.providerMemberId ? " · Already mapped" : ""}` }));
        const components = paymentMethodById.get(row.paymentMethodId)?.components ?? [];
        return <div className={`mapping-row-card ${dirtyRows[index] ? "unsaved-row" : ""}`} key={row.providerMemberId}>
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
            <div className="mapping-field mapping-payment-method-select provider-first-workforce-select"><span className="mapping-field-label">DropX workforce ID</span><SearchableSelect disabled={!canEdit} maxOptions={5000} name={`provider_first_worker_${index}`} onValueChange={(value) => chooseWorker(index, value)} options={workerOptions} placeholder="Search DropX ID or name" value={row.workforceId} /></div>
            <div className="mapping-field mapping-payment-method-select"><span className="mapping-field-label">Payment method</span><SearchableSelect disabled={!canEdit || !row.workforceId} name={`rows[${index}][payment_method_id]`} onValueChange={(value) => update(index, { paymentMethodId: value, paymentValues: {} })} options={paymentOptions} placeholder="Search payment method" required value={row.paymentMethodId} /></div>
            {components.map((component) => <label key={component.code}>{component.label}<input className="worksheet-input" disabled={!canEdit || !row.workforceId} min="0" onChange={(event) => update(index, { paymentValues: { ...row.paymentValues, [component.code]: event.target.value } })} placeholder="0.00" step="0.01" type="number" value={row.paymentValues[component.code] ?? ""} /></label>)}
            <div className="mapping-period-row"><label>Effective from<input className="worksheet-input" disabled={!canEdit || !row.workforceId} name={`rows[${index}][effective_from]`} onChange={(event) => update(index, { effectiveFrom: event.target.value })} type="date" value={row.effectiveFrom} /></label><label>Effective to<input className="worksheet-input" disabled={!canEdit || !row.workforceId} name={`rows[${index}][effective_to]`} onChange={(event) => update(index, { effectiveTo: event.target.value })} type="date" value={row.effectiveTo} /></label></div>
            {row.workforceId && !namesMateriallyMatch(row.providerMemberName, row.dropxName) ? <div className="mapping-row-error">Name mismatch: “{row.providerMemberName.split("/")[0].trim()}” does not sufficiently match “{row.dropxName}”. Save is blocked.</div> : null}
            {mappingConflict ? <div className="mapping-row-error">This DropX ID is already mapped to Provider Member ID {selectedWorker?.mappedProviderMemberId}. Select another DropX ID. Save is blocked.</div> : null}
            {errors[index] ? <div className="mapping-row-error">{errors[index]}</div> : null}
          </div>
          <div className="mapping-row-actions"><RowButton canEdit={canEdit} dirty={dirtyRows[index]} index={index} nameMatches={(!row.workforceId || namesMateriallyMatch(row.providerMemberName, row.dropxName)) && !mappingConflict} /></div>
        </div>;
      })}</div>
    </section>
  </form>;
}
