"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { saveProviderFirstMappingsInline } from "@/app/provider-mapping/actions";
import { SearchableSelect } from "@/components/searchable-select";
import { PaymentAllocationHistoryButton } from "@/components/payment-allocation-history-button";
import { MappingMultiFilter, type PaymentMethodOption } from "@/components/provider-mapping-worksheet";
import { paymentAllocationHistoryRates, uniquePaymentAllocationHistory } from "@/lib/payment-allocation-history";
import { buildProductionThresholdSnapshot } from "@/lib/production-threshold-snapshot";
import {
  filterProviderFirstRowIndexes,
  providerMappingMonthOptions,
  isScientificProviderMemberId,
  providerFirstNamesMatch,
  providerFirstLocationRemap,
  providerFirstMappingReplacement,
  providerFirstMappingReplacementMessage,
  providerFirstPageWindow,
  providerFirstRowIssue,
  providerMemberKey,
  type ProviderFirstMappingReplacement,
  type ProviderFirstMappingRowView,
  type ProviderFirstPageSize,
  type ProviderFirstWorkerView
} from "@/lib/provider-first-mapping-view";

export type ProviderFirstWorker = ProviderFirstWorkerView;
export type ProviderFirstMappingRow = ProviderFirstMappingRowView;

function signature(row: ProviderFirstMappingRow) {
  return [row.providerMemberId, row.stationId, row.workforceId, row.mappingId, row.paymentMethodId, JSON.stringify(row.paymentValues), JSON.stringify(row.productionThresholdConfig), row.productionThresholdMinimumUnits, row.effectiveFrom, row.effectiveTo].join("|");
}

function isMappedToAnotherMember(row: ProviderFirstMappingRow, worker: ProviderFirstWorker | undefined) {
  return Boolean(worker?.mappedProviderMemberId && providerMemberKey(row.stationId, worker.mappedProviderMemberId) !== providerMemberKey(row.stationId, row.providerMemberId));
}

function appendRow(
  formData: FormData,
  position: number,
  row: ProviderFirstMappingRow,
  replacementMappingId = "",
  replacementAction: "move" | "keep" | "" = "",
  clearWorkforceId = ""
) {
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
  formData.set(`${prefix}[provider_member_name]`, row.providerMemberName);
  formData.set(`${prefix}[payment_method_id]`, row.paymentMethodId);
  formData.set(`${prefix}[payment_values_json]`, JSON.stringify(row.paymentValues));
  formData.set(`${prefix}[production_threshold_minimum_units]`, row.productionThresholdMinimumUnits);
  formData.set(`${prefix}[effective_from]`, row.effectiveFrom);
  formData.set(`${prefix}[effective_to]`, row.effectiveTo);
  formData.set(`${prefix}[replace_mapping_id]`, replacementMappingId);
  formData.set(`${prefix}[replacement_confirmed]`, replacementMappingId ? "yes" : "");
  formData.set(`${prefix}[replacement_action]`, replacementAction);
  formData.set(`${prefix}[clear_mapping]`, !row.workforceId && row.mappingId ? "yes" : "");
  formData.set(`${prefix}[clear_workforce_id]`, clearWorkforceId);
}

type ReplacementSaveConfirmation = {
  indexes: number[];
  replacements: Array<{ index: number; replacement: ProviderFirstMappingReplacement }>;
  cursor: number;
  confirmedMappingIds: Record<number, string>;
  confirmedActions: Record<number, "move" | "keep">;
};

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

export function ProviderFirstMappingWorksheet({ initialQuery = "", initialStationId = "", canEdit, mappings, workers, paymentMethods, shipmentMonths }: {
  shipmentMonths: string[];
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
  const [monthFilters, setMonthFilters] = useState<string[]>([]);
  const monthOptions = useMemo(() => providerMappingMonthOptions(shipmentMonths), [shipmentMonths]);
  const [methodFilters, setMethodFilters] = useState<string[]>([]);
  const [mappingFilters, setMappingFilters] = useState<string[]>(["unmapped"]);
  const [validationFilters, setValidationFilters] = useState<string[]>([]);
  const [pageSize, setPageSize] = useState<ProviderFirstPageSize>(50);
  const [currentPage, setCurrentPage] = useState(1);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [savingIndexes, setSavingIndexes] = useState<Set<number>>(() => new Set());
  const [saveNotice, setSaveNotice] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [replacementConfirmation, setReplacementConfirmation] = useState<ReplacementSaveConfirmation | null>(null);

  const paymentMethodById = useMemo(() => new Map(paymentMethods.map((method) => [method.id, method])), [paymentMethods]);
  const paymentOptions = useMemo(() => paymentMethods.filter((method) => method.isActive !== false).map((method) => ({ value: method.id, label: method.name, helper: method.code })), [paymentMethods]);
  const workerById = useMemo(() => new Map(workerRows.map((worker) => [worker.id, worker])), [workerRows]);
  const workerOptions = useMemo(() => workerRows.map((worker) => ({
    value: worker.id,
    label: `${worker.dropxId} — ${worker.fullName}`,
    helper: `${worker.profileStationId && worker.profileStationId !== worker.stationId
      ? `Mapped: ${worker.locationLabel} · Profile: ${worker.profileLocationLabel ?? "No location"}`
      : worker.locationLabel}${worker.onboardingStatus ? ` · ${worker.onboardingStatus}` : ""}`
  })), [workerRows]);
  const stations = useMemo(() => Array.from(new Map(rows.map((row) => [row.stationId, row.stationLabel])).entries()), [rows]);
  const dirtyRows = useMemo(() => rows.map((row, index) => {
    const thresholdConfig = row.productionThresholdConfig ?? paymentMethodById.get(row.paymentMethodId)?.productionThresholdConfig ?? null;
    const minimumUnits = Number(row.productionThresholdMinimumUnits);
    const thresholdIncomplete = Boolean(thresholdConfig && (!row.productionThresholdMinimumUnits.trim() || !Number.isInteger(minimumUnits) || minimumUnits <= 0));
    return thresholdIncomplete || signature(row) !== signature(baselineRows[index]);
  }), [rows, baselineRows, paymentMethodById]);
  const dirtyIndexes = useMemo(() => dirtyRows.flatMap((dirty, index) => dirty ? [index] : []), [dirtyRows]);
  const hasDirty = dirtyIndexes.length > 0;
  const hasDirtyNameMismatch = dirtyIndexes.some((index) => Boolean(rows[index].workforceId) && !providerFirstNamesMatch(rows[index].providerMemberName, rows[index].dropxName));
  const hasDirtyMappingConflict = dirtyIndexes.some((index) => isMappedToAnotherMember(rows[index], workerById.get(rows[index].workforceId)));
  const hasDirtyLocationMismatch = dirtyIndexes.some((index) => {
    const selectedWorker = workerById.get(rows[index].workforceId);
    return Boolean(rows[index].workforceId)
      && selectedWorker?.stationId !== rows[index].stationId
      && !providerFirstLocationRemap(rows[index], selectedWorker);
  });
  const isSaving = savingIndexes.size > 0;

  const visibleIndexes = useMemo(() => filterProviderFirstRowIndexes({
    rows,
    workerById,
    paymentMethodById,
    filters: {
      outboundMonths: monthFilters,
      query: deferredQuery,
      stationIds: stationFilters,
      paymentMethodIds: methodFilters,
      mappingStatuses: mappingFilters,
      validationStatuses: validationFilters
    }
  }), [rows, workerById, paymentMethodById, deferredQuery, monthFilters, stationFilters, methodFilters, mappingFilters, validationFilters]);
  const pageWindow = providerFirstPageWindow(visibleIndexes.length, currentPage, pageSize);
  const paginatedIndexes = useMemo(() => visibleIndexes.slice(pageWindow.fromIndex, pageWindow.toIndex), [visibleIndexes, pageWindow.fromIndex, pageWindow.toIndex]);
  const hasFilters = Boolean(query || monthFilters.length || stationFilters.length || methodFilters.length || mappingFilters.length || validationFilters.length);

  function resetPage() { setCurrentPage(1); }

  function clearFilters() {
    setQuery("");
    setStationFilters([]);
    setMonthFilters([]);
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

  function relocatedHistory(
    history: ProviderFirstMappingRow["history"],
    relocation: { previousMappingId: string; previousEffectiveTo: string; previousStatus: "closed" | "cancelled" }
  ) {
    return uniquePaymentAllocationHistory(history.map((entry) => entry.id === relocation.previousMappingId
      ? { ...entry, effectiveTo: relocation.previousEffectiveTo, storedStatus: relocation.previousStatus }
      : entry));
  }

  function clearCurrentMapping(row: ProviderFirstMappingRow, history: ProviderFirstMappingRow["history"]): ProviderFirstMappingRow {
    return {
      ...row,
      workforceId: "",
      dropxId: "",
      dropxName: "",
      mappingId: "",
      paymentMethodId: "",
      paymentValues: {},
      productionThresholdConfig: null,
      productionThresholdMinimumUnits: "",
      effectiveFrom: "",
      effectiveTo: "",
      history
    };
  }

  function reconciledHistory(
    previous: ProviderFirstMappingRow,
    next: ProviderFirstMappingRow,
    sourceHistory = previous.history,
    relocation?: { previousMappingId: string; previousEffectiveTo: string; previousStatus: "closed" | "cancelled" }
  ) {
    const method = paymentMethodById.get(next.paymentMethodId);
    const nextEntry = {
      id: next.mappingId,
      paymentMethodId: next.paymentMethodId,
      paymentMethodName: method?.name ?? "Payment method unavailable",
      effectiveFrom: next.effectiveFrom,
      effectiveTo: next.effectiveTo,
      storedStatus: next.effectiveTo ? "closed" : "active",
      sourceLabel: `Provider ID ${next.providerMemberId}`,
      subjectLabel: `${next.dropxId} · ${next.dropxName}`.replace(/^ · | · $/g, ""),
      locationLabel: next.stationLabel,
      rates: paymentAllocationHistoryRates(next.paymentValues, (method?.components ?? []).map((component, index) => ({ code: component.code, label: component.label, sortOrder: index }))),
      productionThreshold: buildProductionThresholdSnapshot(next.productionThresholdConfig ?? method?.productionThresholdConfig ?? null, next.productionThresholdMinimumUnits)
    };
    let history = relocation ? relocatedHistory(sourceHistory, relocation) : sourceHistory;
    if (!relocation && previous.mappingId && previous.workforceId !== next.workforceId) {
      history = history.filter((entry) => entry.id !== previous.mappingId);
    } else if (!relocation && previous.mappingId && previous.mappingId !== next.mappingId && next.effectiveFrom > previous.effectiveFrom) {
      const closingDate = new Date(`${next.effectiveFrom}T00:00:00.000Z`);
      closingDate.setUTCDate(closingDate.getUTCDate() - 1);
      const effectiveTo = closingDate.toISOString().slice(0, 10);
      history = history.map((entry) => entry.id === previous.mappingId ? { ...entry, effectiveTo, storedStatus: "closed" } : entry);
    }
    return uniquePaymentAllocationHistory([...history.filter((entry) => entry.id !== next.mappingId), nextEntry]);
  }

  function chooseWorker(index: number, workerId: string) {
    const worker = workerById.get(workerId);
    if (!worker) {
      update(index, { workforceId: "", dropxId: "", dropxName: "", mappingId: baselineRows[index].mappingId, paymentMethodId: "", paymentValues: {}, productionThresholdConfig: null, productionThresholdMinimumUnits: "", effectiveFrom: "", effectiveTo: "" });
      return;
    }
    const row = rows[index];
    const targetHasMapping = Boolean(worker.mappingId);
    update(index, {
      workforceId: worker.id,
      dropxId: worker.dropxId,
      dropxName: worker.fullName,
      mappingId: worker.mappingId,
      providerId: row.providerId || worker.providerId,
      paymentMethodId: targetHasMapping ? worker.paymentMethodId : row.paymentMethodId,
      paymentValues: targetHasMapping ? worker.paymentValues : row.paymentValues,
      productionThresholdConfig: targetHasMapping ? worker.productionThresholdConfig : row.productionThresholdConfig,
      productionThresholdMinimumUnits: targetHasMapping ? worker.productionThresholdMinimumUnits : row.productionThresholdMinimumUnits,
      effectiveFrom: targetHasMapping ? worker.effectiveFrom : row.effectiveFrom || worker.dateOfJoin,
      effectiveTo: targetHasMapping ? worker.effectiveTo : row.effectiveTo
    });
  }

  async function saveIndexes(
    indexes: number[],
    confirmedMappingIds: Record<number, string> = {},
    confirmedActions: Record<number, "move" | "keep"> = {}
  ) {
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

    const replacements = selected.flatMap((index) => {
      const replacement = providerFirstMappingReplacement(baselineRows[index], rows[index])
        ?? providerFirstLocationRemap(rows[index], workerById.get(rows[index].workforceId));
      return replacement && !confirmedMappingIds[index] ? [{ index, replacement }] : [];
    });
    if (replacements.length) {
      setReplacementConfirmation({ indexes: selected, replacements, cursor: 0, confirmedMappingIds, confirmedActions });
      return;
    }

    const snapshots = selected.map((index) => ({
      index,
      key: providerMemberKey(rows[index].stationId, rows[index].providerMemberId),
      row: { ...rows[index], paymentValues: { ...rows[index].paymentValues } },
      previousWorkforceId: baselineRows[index]?.workforceId ?? "",
      replacementMappingId: confirmedMappingIds[index] ?? "",
      replacementAction: confirmedActions[index] ?? "" as const
    }));
    const snapshotByKey = new Map(snapshots.map((snapshot) => [snapshot.key, snapshot]));
    const snapshotByIndex = new Map(snapshots.map((snapshot) => [snapshot.index, snapshot]));
    const data = new FormData();
    data.set("row_count", String(snapshots.length));
    snapshots.forEach((snapshot, position) => appendRow(
      data,
      position,
      snapshot.row,
      snapshot.replacementMappingId,
      snapshot.replacementAction,
      snapshot.previousWorkforceId
    ));
    setSavingIndexes(new Set(selected));
    setSaveNotice(null);

    try {
      const result = await saveProviderFirstMappingsInline(data);
      const canonicalByIndex = new Map<number, ProviderFirstMappingRow>();
      const clearedByIndex = new Map<number, { row: ProviderFirstMappingRow; expectedMappingId: string }>();
      for (const saved of result.savedRows) {
        const snapshot = snapshotByKey.get(saved.clientKey);
        if (!snapshot) continue;
        if (saved.cleared) {
          const clearedHistory = relocatedHistory(snapshot.row.history, {
            previousMappingId: saved.cleared.previousMappingId,
            previousEffectiveTo: saved.cleared.previousEffectiveTo,
            previousStatus: saved.cleared.previousStatus
          });
          canonicalByIndex.set(snapshot.index, clearCurrentMapping(snapshot.row, clearedHistory));
          continue;
        }
        let canonical = {
          ...snapshot.row,
          mappingId: saved.mappingId,
          workforceId: saved.workforceId,
          paymentMethodId: saved.paymentMethodId,
          paymentValues: saved.paymentValues,
          productionThresholdConfig: saved.productionThresholdConfig,
          productionThresholdMinimumUnits: saved.productionThresholdMinimumUnits,
          effectiveFrom: saved.effectiveFrom,
          effectiveTo: saved.effectiveTo
        };
        if (saved.relocation) {
          const originIndex = baselineRows.findIndex((candidate, candidateIndex) => candidateIndex !== snapshot.index && candidate.mappingId === saved.relocation?.previousMappingId);
          const origin = originIndex >= 0 ? baselineRows[originIndex] : null;
          const originHistory = origin
            ? relocatedHistory(origin.history, saved.relocation)
            : [];
          const sourceHistory = uniquePaymentAllocationHistory([...originHistory, ...baselineRows[snapshot.index].history]);
          canonical = { ...canonical, history: reconciledHistory(baselineRows[snapshot.index], canonical, sourceHistory, saved.relocation) };
          if (origin && originIndex >= 0) {
            clearedByIndex.set(originIndex, {
              row: clearCurrentMapping(origin, originHistory),
              expectedMappingId: saved.relocation.previousMappingId
            });
          }
        } else {
          canonical = { ...canonical, history: reconciledHistory(baselineRows[snapshot.index], canonical) };
        }
        canonicalByIndex.set(snapshot.index, canonical);
      }

      if (canonicalByIndex.size) {
        setBaselineRows((current) => current.map((row, index) => canonicalByIndex.get(index) ?? clearedByIndex.get(index)?.row ?? row));
        setRows((current) => current.map((row, index) => {
          const canonical = canonicalByIndex.get(index);
          const snapshot = snapshotByIndex.get(index);
          if (canonical && snapshot) {
            if (signature(row) === signature(snapshot.row)) return canonical;
            return row.workforceId === snapshot.row.workforceId ? { ...row, mappingId: canonical.mappingId } : row;
          }
          const cleared = clearedByIndex.get(index);
          return cleared && row.mappingId === cleared.expectedMappingId ? cleared.row : row;
        }));
        const workerUpdates = new Map<string, Partial<ProviderFirstWorker>>();
        const workerClears = new Map<string, string>();
        for (const snapshot of snapshots) {
          const canonical = canonicalByIndex.get(snapshot.index);
          if (!canonical) continue;
          if (snapshot.previousWorkforceId && snapshot.previousWorkforceId !== canonical.workforceId) {
            const remaining = baselineRows.find((candidate, candidateIndex) => candidateIndex !== snapshot.index
              && candidate.workforceId === snapshot.previousWorkforceId
              && candidate.mappingId);
            if (remaining) {
              const existingWorker = workerById.get(snapshot.previousWorkforceId);
              workerUpdates.set(snapshot.previousWorkforceId, {
                stationId: remaining.stationId,
                locationLabel: remaining.stationLabel,
                profileStationId: existingWorker?.profileStationId,
                profileLocationLabel: existingWorker?.profileLocationLabel,
                providerId: remaining.providerId,
                mappingId: remaining.mappingId,
                paymentMethodId: remaining.paymentMethodId,
                paymentValues: remaining.paymentValues,
                productionThresholdConfig: remaining.productionThresholdConfig,
                productionThresholdMinimumUnits: remaining.productionThresholdMinimumUnits,
                effectiveFrom: remaining.effectiveFrom,
                effectiveTo: remaining.effectiveTo,
                mappedProviderMemberId: remaining.providerMemberId
              });
            } else {
              workerClears.set(snapshot.previousWorkforceId, snapshot.row.providerMemberId);
            }
          }
          if (!canonical.workforceId) continue;
          const saved = result.savedRows.find((candidate) => candidate.clientKey === snapshot.key);
          workerUpdates.set(canonical.workforceId, { stationId: canonical.stationId, locationLabel: canonical.stationLabel, profileStationId: saved?.profileStationId ?? canonical.stationId, profileLocationLabel: saved?.profileLocationLabel ?? canonical.stationLabel, providerId: canonical.providerId, mappingId: canonical.mappingId, paymentMethodId: canonical.paymentMethodId, paymentValues: canonical.paymentValues, productionThresholdConfig: canonical.productionThresholdConfig, productionThresholdMinimumUnits: canonical.productionThresholdMinimumUnits, effectiveFrom: canonical.effectiveFrom, effectiveTo: canonical.effectiveTo, mappedProviderMemberId: canonical.providerMemberId });
        }
        setWorkerRows((current) => current.map((worker) => {
          const update = workerUpdates.get(worker.id);
          if (update) return { ...worker, ...update };
          const expectedMember = workerClears.get(worker.id);
          return expectedMember && providerMemberKey(worker.stationId, worker.mappedProviderMemberId) === providerMemberKey(worker.stationId, expectedMember)
            ? { ...worker, mappingId: "", paymentMethodId: "", paymentValues: {}, productionThresholdConfig: null, productionThresholdMinimumUnits: "", effectiveFrom: "", effectiveTo: "", mappedProviderMemberId: "" }
            : worker;
        }));
        setErrors((current) => {
          const next = { ...current };
          canonicalByIndex.forEach((_, index) => delete next[index]);
          clearedByIndex.forEach((_, index) => delete next[index]);
          return next;
        });
      }

      if (!result.ok && result.failedClientKey) {
        const failed = snapshotByKey.get(result.failedClientKey);
        if (failed) setErrors((current) => ({ ...current, [failed.index]: result.message }));
      }
      if (result.replacement) {
        const failed = snapshotByKey.get(result.replacement.clientKey);
        if (failed) {
          setReplacementConfirmation({
            indexes: [failed.index],
            replacements: [{ index: failed.index, replacement: result.replacement }],
            cursor: 0,
            confirmedMappingIds: {},
            confirmedActions: {}
          });
        }
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
        <MappingMultiFilter allLabel="All months" label="Outbound month" options={monthOptions} selected={monthFilters} setSelected={(values) => { setMonthFilters(values); resetPage(); }} />
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
        const locationRemap = providerFirstLocationRemap(row, selectedWorker);
        const locationMismatch = Boolean(selectedWorker && selectedWorker.stationId !== row.stationId && !locationRemap);
        const profileLocationDrift = Boolean(selectedWorker?.profileStationId && selectedWorker.profileStationId !== selectedWorker.stationId);
        const selectedPaymentMethod = paymentMethodById.get(row.paymentMethodId);
        const productionThresholdConfig = row.productionThresholdConfig ?? selectedPaymentMethod?.productionThresholdConfig ?? null;
        const rowPaymentOptions = selectedPaymentMethod?.isActive === false
          ? [{ value: selectedPaymentMethod.id, label: `${selectedPaymentMethod.name} (Inactive)`, helper: selectedPaymentMethod.code }, ...paymentOptions]
          : paymentOptions;
        const components = selectedPaymentMethod?.components ?? [];
        const roundedSourceId = isScientificProviderMemberId(row.providerMemberId);
        const canEditRow = canEdit && !roundedSourceId && !isSaving;
        return <div className={`mapping-row-card provider-first-row ${dirtyRows[index] ? "unsaved-row" : ""}`} key={providerMemberKey(row.stationId, row.providerMemberId)}>
          {dirtyRows[index] ? <span className="unsaved-badge mapping-unsaved-badge">Unsaved</span> : null}
          <div className="mapping-identity">
            <span className="mapping-identity-kicker">Provider ID</span>
            <span className="mapping-dropx-id mono" title={roundedSourceId ? "The source file contains a rounded ID. Import a report containing the full provider ID to resolve it." : undefined}>{row.providerMemberId}</span>
            {roundedSourceId ? <span className="mapping-source-warning">Exact ID unavailable</span> : null}
            <span className="mapping-provider-name">{row.providerMemberName}</span>
            <span className="mapping-station-label">{row.stationLabel}</span>
          </div>
          <div className="mapping-edit-grid">
            <div className="mapping-field mapping-payment-method-select provider-first-workforce-select provider-first-selection-field"><span className="mapping-field-label">DropX ID / name</span><SearchableSelect disabled={!canEditRow} maxOptions={5000} name={`provider_first_worker_${index}`} onValueChange={(value) => chooseWorker(index, value)} options={workerOptions} placeholder="Select DropX workforce" value={row.workforceId} />{row.workforceId ? <span className="provider-first-selected-detail" title={`${row.dropxId} · ${row.dropxName}`}>{row.dropxId} · {row.dropxName}</span> : row.mappingId ? <span className="provider-first-selected-detail">Save to clear this mapping. Its history will be preserved.</span> : null}</div>
            <div className="mapping-field mapping-payment-method-select provider-first-selection-field"><span className="mapping-field-label">Payment method</span><SearchableSelect disabled={!canEditRow || !row.workforceId} name={`provider_first_payment_method_${index}`} onValueChange={(value) => update(index, { paymentMethodId: value, paymentValues: {}, productionThresholdConfig: paymentMethodById.get(value)?.productionThresholdConfig ?? null, productionThresholdMinimumUnits: "" })} options={rowPaymentOptions} placeholder="Search payment method" required value={row.paymentMethodId} />{selectedPaymentMethod ? <span className="provider-first-selected-detail" title={`${selectedPaymentMethod.name} · ${selectedPaymentMethod.code}${selectedPaymentMethod.isActive === false ? " · Inactive" : ""}`}>{selectedPaymentMethod.name} · {selectedPaymentMethod.code}{selectedPaymentMethod.isActive === false ? " · Inactive" : ""}</span> : null}</div>
            {components.map((component) => <label key={component.code}>{component.label}<input className="worksheet-input" disabled={!canEditRow || !row.workforceId} min="0" onChange={(event) => update(index, { paymentValues: { ...row.paymentValues, [component.code]: event.target.value } })} placeholder="0.00" step="0.01" type="number" value={row.paymentValues[component.code] ?? ""} /></label>)}
            {productionThresholdConfig ? <label>
              Combined minimum / {productionThresholdConfig.period}
              <input className="worksheet-input" disabled={!canEditRow || !row.workforceId} min="1" onChange={(event) => update(index, { productionThresholdMinimumUnits: event.target.value })} placeholder="Enter minimum units" step="1" type="number" value={row.productionThresholdMinimumUnits} />
              <span className="provider-first-selected-detail">Combined across {productionThresholdConfig.component_codes.map((code) => components.find((component) => component.code === code)?.label ?? code).join(" + ")}</span>
            </label> : null}
            <div className="mapping-period-row"><label>Effective from<input className="worksheet-input" disabled={!canEditRow || !row.workforceId} onChange={(event) => update(index, { effectiveFrom: event.target.value })} required type="date" value={row.effectiveFrom} /></label><label>Effective to <span className="subtle">(optional)</span><input className="worksheet-input" disabled={!canEditRow || !row.workforceId} onChange={(event) => update(index, { effectiveTo: event.target.value })} type="date" value={row.effectiveTo} /></label><p className="mapping-period-help">To change method during a month, save the new method with its start date. The previous method automatically ends on the preceding day.</p></div>
            {row.workforceId && !providerFirstNamesMatch(row.providerMemberName, row.dropxName) ? <div className="mapping-row-error">Name mismatch</div> : null}
            {locationRemap ? <div className="mapping-period-help">Location change: {locationRemap.existingLocationLabel} → {locationRemap.newLocationLabel}. Confirmation is required when saving.</div> : null}
            {profileLocationDrift && !locationRemap ? <div className="mapping-period-help">Mapping location: {selectedWorker?.locationLabel}. Workforce current location: {selectedWorker?.profileLocationLabel}. Saving rates here will not move the Workforce profile; use its current-location provider row to move this mapping.</div> : null}
            {locationMismatch ? <div className="mapping-row-error">Location mismatch</div> : null}
            {mappingConflict ? <div className="mapping-row-error">This DropX ID is already mapped to Provider Member ID {selectedWorker?.mappedProviderMemberId}. Select another DropX ID. Save is blocked.</div> : null}
            {errors[index] ? <div className="mapping-row-error">{errors[index]}</div> : null}
          </div>
          <div className="mapping-row-actions"><PaymentAllocationHistoryButton entries={row.history} subjectLabel={`${row.providerMemberName} · ${row.providerMemberId}`} /><RowButton busy={isSaving} canEdit={canEdit && !roundedSourceId} dirty={dirtyRows[index]} index={index} nameMatches={(!row.workforceId || providerFirstNamesMatch(row.providerMemberName, row.dropxName)) && !mappingConflict && !locationMismatch} onSave={(rowIndex) => void saveIndexes([rowIndex])} /></div>
        </div>;
      })}{!paginatedIndexes.length ? <div className="empty-state"><strong>No matching provider members.</strong><p className="subtle">Change or clear the filters to see more records.</p></div> : null}</div>
      <div className="mapping-pagination">
        <span>Showing {pageWindow.shownFrom}–{pageWindow.shownTo} of {visibleIndexes.length}</span>
        <div className="mapping-pagination-actions"><button className="button secondary compact" disabled={pageWindow.page <= 1} onClick={() => setCurrentPage((page) => Math.max(1, page - 1))} type="button">Previous</button><span>Page {pageWindow.page} of {pageWindow.totalPages}</span><button className="button secondary compact" disabled={pageWindow.page >= pageWindow.totalPages} onClick={() => setCurrentPage((page) => Math.min(pageWindow.totalPages, page + 1))} type="button">Next</button></div>
      </div>
    </section>
    {replacementConfirmation ? (() => {
      const active = replacementConfirmation.replacements[replacementConfirmation.cursor];
      return <div className="modal-backdrop confirmation-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !isSaving) setReplacementConfirmation(null); }}>
        <section aria-labelledby="provider-replacement-title" aria-modal="true" className="modal-panel confirmation-dialog" role="alertdialog">
          <div className="modal-head"><div><h2 id="provider-replacement-title">{active.replacement.kind === "location" ? "Move mapping to new location?" : "Replace existing mapping?"}</h2></div></div>
          <div className="confirmation-body"><p style={{ whiteSpace: "pre-line" }}>{providerFirstMappingReplacementMessage(active.replacement)}</p></div>
          <div className="form-actions modal-actions confirmation-actions">
            <button className="button secondary" disabled={isSaving} onClick={() => setReplacementConfirmation(null)} type="button">Cancel</button>
            {active.replacement.kind === "location" && active.replacement.allowKeepAll !== false ? <button className="button secondary" disabled={isSaving} onClick={() => {
              const confirmedMappingIds = { ...replacementConfirmation.confirmedMappingIds, [active.index]: active.replacement.mappingId };
              const confirmedActions = { ...replacementConfirmation.confirmedActions, [active.index]: "keep" as const };
              const nextCursor = replacementConfirmation.cursor + 1;
              if (nextCursor < replacementConfirmation.replacements.length) {
                setReplacementConfirmation({ ...replacementConfirmation, cursor: nextCursor, confirmedMappingIds, confirmedActions });
                return;
              }
              const indexes = replacementConfirmation.indexes;
              setReplacementConfirmation(null);
              void saveIndexes(indexes, confirmedMappingIds, confirmedActions);
            }} type="button">Keep all</button> : null}
            <button className="button" disabled={isSaving} onClick={() => {
              const confirmedMappingIds = { ...replacementConfirmation.confirmedMappingIds, [active.index]: active.replacement.mappingId };
              const confirmedActions = { ...replacementConfirmation.confirmedActions, [active.index]: "move" as const };
              const nextCursor = replacementConfirmation.cursor + 1;
              if (nextCursor < replacementConfirmation.replacements.length) {
                setReplacementConfirmation({ ...replacementConfirmation, cursor: nextCursor, confirmedMappingIds, confirmedActions });
                return;
              }
              const indexes = replacementConfirmation.indexes;
              setReplacementConfirmation(null);
              void saveIndexes(indexes, confirmedMappingIds, confirmedActions);
            }} type="button">{active.replacement.kind === "location" ? "Move mapping" : "Replace mapping"}</button>
          </div>
        </section>
      </div>;
    })() : null}
  </div>;
}
