"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { Download, FileSpreadsheet, FileText, X } from "lucide-react";
import { saveProviderFirstMappingsInline } from "@/app/provider-mapping/actions";
import { ProviderMappingSchedule, type SavedScheduleMappings } from "@/components/provider-mapping-schedule";
import { parseProductionThresholdSnapshot } from "@/lib/production-threshold-snapshot";
import { ProviderMappingLookup } from "@/components/provider-mapping-lookup";
import { mappingLookupToday } from "@/lib/provider-mapping-lookup";
import type { ProviderMappingLookupEntry } from "@/lib/provider-mapping-lookup";
import { SearchableSelect } from "@/components/searchable-select";
import { PaymentAllocationHistoryButton } from "@/components/payment-allocation-history-button";
import { MappingMultiFilter, type PaymentMethodOption } from "@/components/provider-mapping-worksheet";
import { paymentAllocationHistoryRates, uniquePaymentAllocationHistory } from "@/lib/payment-allocation-history";
import { buildProductionThresholdSnapshot } from "@/lib/production-threshold-snapshot";
import {
  buildProviderFirstWorkerSelectionIndex,
  filterProviderFirstRowIndexes,
  providerMappingMonthOptions,
  isScientificProviderMemberId,
  providerFirstNamesMatch,
  providerFirstLocationIsAllowed,
  providerFirstLocationNeedsDates,
  providerFirstWorkerIsSelectable,
  providerFirstLocationRemap,
  providerFirstMappingReferenceForRow,
  providerFirstPaymentTemplateForRow,
  providerFirstMappingReplacement,
  providerFirstMappingReplacementMessage,
  providerFirstPageWindow,
  providerFirstRowForMappingPeriod,
  providerFirstRowIssue,
  providerMemberKey,
  type ProviderFirstMappingReplacement,
  type ProviderFirstMappingRowView,
  type ProviderFirstPageSize,
  type ProviderFirstRegisteredMappingView,
  type ProviderFirstWorkerView
} from "@/lib/provider-first-mapping-view";

export type ProviderFirstWorker = ProviderFirstWorkerView;
export type ProviderFirstMappingRow = ProviderFirstMappingRowView;

function signature(row: ProviderFirstMappingRow) {
  return [row.providerMemberId, row.stationId, row.workforceId, row.mappingId, row.paymentMethodId, JSON.stringify(row.paymentValues), JSON.stringify(row.productionThresholdConfig), row.productionThresholdMinimumUnits, row.effectiveFrom, row.effectiveTo].join("|");
}

function previousIsoDate(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function isMappedToAnotherMember(row: ProviderFirstMappingRow, worker: ProviderFirstWorker | undefined) {
  const reference = providerFirstMappingReferenceForRow(row, worker);
  return Boolean(reference && (
    reference.providerId !== row.providerId
      || providerMemberKey("", reference.mappedProviderMemberId) !== providerMemberKey("", row.providerMemberId)
  ));
}

function appendRow(
  formData: FormData,
  position: number,
  row: ProviderFirstMappingRow,
  replacementMappingId = "",
  replacementAction: "move" | "keep" | "" = "",
  paidHistoryDecision?: PaidHistoryDecision,
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
  formData.set(`${prefix}[payment_transfer_action]`, paidHistoryDecision?.action ?? "");
  formData.set(`${prefix}[payment_transfer_fingerprint]`, paidHistoryDecision?.paymentFingerprint ?? "");
  formData.set(`${prefix}[payment_transfer_operation_id]`, paidHistoryDecision?.operationId ?? "");
  formData.set(`${prefix}[clear_mapping]`, !row.workforceId && row.mappingId ? "yes" : "");
  formData.set(`${prefix}[clear_workforce_id]`, clearWorkforceId);
}

type ExportFilters = { months: string[]; stations: string[]; methods: string[]; mapping: string[]; validation: string[] };
const emptyExportFilters: ExportFilters = { months: [], stations: [], methods: [], mapping: [], validation: [] };

type ReplacementSaveConfirmation = {
  indexes: number[];
  replacements: Array<{ index: number; replacement: ProviderFirstMappingReplacement }>;
  cursor: number;
  confirmedMappingIds: Record<number, string>;
  confirmedActions: Record<number, "move" | "keep">;
};

type PaidHistoryAction = "transfer" | "keep";

type PaidHistoryDecision = {
  action: PaidHistoryAction;
  paymentFingerprint: string;
  operationId: string;
};

type PaidHistoryTransferConfirmation = {
  clientKey: string;
  providerMemberId: string;
  providerMemberName: string;
  existingWorkforceId: string;
  existingDropxId: string;
  existingDropxName: string;
  newWorkforceId: string;
  newDropxId: string;
  newDropxName: string;
  paidAmount: number | string;
  paymentCount?: number;
  paymentFingerprint: string;
  operationId: string;
  transferAllowed: boolean;
  transferBlockedReason?: string;
};

type PaidHistorySaveConfirmation = {
  indexes: number[];
  index: number;
  confirmation: PaidHistoryTransferConfirmation;
  confirmedMappingIds: Record<number, string>;
  confirmedActions: Record<number, "move" | "keep">;
  confirmedPaidHistoryDecisions: Record<number, PaidHistoryDecision>;
};

const rupees = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

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

export function ProviderFirstMappingWorksheet({ initialQuery = "", initialStationId = "", initialOutboundMonth, lookupEntries = [], canEdit, mappings, workers, paymentMethods, shipmentMonths }: {
  shipmentMonths: string[];
  lookupEntries?: ProviderMappingLookupEntry[];
  initialOutboundMonth: string;
  initialQuery?: string;
  initialStationId?: string;
  canEdit: boolean;
  mappings: ProviderFirstMappingRow[];
  workers: ProviderFirstWorker[];
  paymentMethods: PaymentMethodOption[];
}) {
  const [scheduleIndex, setScheduleIndex] = useState<number | null>(null);
  const [rows, setRows] = useState(() => mappings);
  const [baselineRows, setBaselineRows] = useState(() => mappings);
  const [workerRows, setWorkerRows] = useState(() => workers);
  const [query, setQuery] = useState(initialQuery);
  const deferredQuery = useDeferredValue(query);
  const [stationFilters, setStationFilters] = useState<string[]>(initialStationId ? [initialStationId] : []);
  const [monthFilters, setMonthFilters] = useState<string[]>([initialOutboundMonth]);
  const monthOptions = useMemo(() => providerMappingMonthOptions([...shipmentMonths, initialOutboundMonth]), [shipmentMonths, initialOutboundMonth]);
  const [methodFilters, setMethodFilters] = useState<string[]>([]);
  const [mappingFilters, setMappingFilters] = useState<string[]>(["unmapped"]);
  const [validationFilters, setValidationFilters] = useState<string[]>([]);
  const [pageSize, setPageSize] = useState<ProviderFirstPageSize>(50);
  const [currentPage, setCurrentPage] = useState(1);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [savingIndexes, setSavingIndexes] = useState<Set<number>>(() => new Set());
  const [saveNotice, setSaveNotice] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [paymentTemplateSources, setPaymentTemplateSources] = useState<Record<number, ProviderFirstRegisteredMappingView>>({});
  const [replacementConfirmation, setReplacementConfirmation] = useState<ReplacementSaveConfirmation | null>(null);
  const [paidHistoryConfirmation, setPaidHistoryConfirmation] = useState<PaidHistorySaveConfirmation | null>(null);

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
  const workerSelectionIndex = useMemo(
    () => buildProviderFirstWorkerSelectionIndex(workerRows, rows),
    [workerRows, rows]
  );
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
      && !providerFirstLocationNeedsDates(rows[index], selectedWorker)
      && !providerFirstLocationIsAllowed(rows[index], selectedWorker);
  });
  const isSaving = savingIndexes.size > 0;

  // Filter persisted values: selecting an associate or changing a rate card must
  // not remove an unfinished row. A successful save updates baselineRows.
  const visibleIndexes = useMemo(() => filterProviderFirstRowIndexes({
    rows: baselineRows,
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
  }), [baselineRows, workerById, paymentMethodById, deferredQuery, monthFilters, stationFilters, methodFilters, mappingFilters, validationFilters]);
  const pageWindow = providerFirstPageWindow(visibleIndexes.length, currentPage, pageSize);
  const paginatedIndexes = useMemo(() => visibleIndexes.slice(pageWindow.fromIndex, pageWindow.toIndex), [visibleIndexes, pageWindow.fromIndex, pageWindow.toIndex]);
  const selectableWorkerOptionsByIndex = useMemo(() => new Map(paginatedIndexes.map((index) => {
    const row = rows[index];
    return [index, workerOptions.filter((option) => providerFirstWorkerIsSelectable(
      row,
      workerById.get(option.value)!,
      rows,
      workerSelectionIndex
    ))] as const;
  })), [paginatedIndexes, rows, workerOptions, workerById, workerSelectionIndex]);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<"xlsx" | "csv">("xlsx");
  const [exportFilters, setExportFilters] = useState<ExportFilters>(emptyExportFilters);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
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

  // The download dialog has its own filters, starting at "all", so a download is
  // never silently limited by whatever the worksheet happens to be filtered to.
  const exportIndexes = useMemo(() => exportOpen ? filterProviderFirstRowIndexes({
    rows: baselineRows,
    workerById,
    paymentMethodById,
    filters: {
      outboundMonths: exportFilters.months,
      query: "",
      stationIds: exportFilters.stations,
      paymentMethodIds: exportFilters.methods,
      mappingStatuses: exportFilters.mapping,
      validationStatuses: exportFilters.validation
    }
  }) : [], [exportOpen, baselineRows, workerById, paymentMethodById, exportFilters]);

  function openExport() {
    setExportFilters(emptyExportFilters);
    setExportError("");
    setExportOpen(true);
  }

  async function downloadMappings() {
    setExporting(true);
    setExportError("");
    try {
      const exportRows = exportIndexes.map((index) => baselineRows[index]);
      const paymentKeys = Array.from(new Set(exportRows.flatMap((row) => Object.keys(row.paymentValues ?? {})))).sort();
      const head = ["Provider member ID", "Provider member name", "Location", "Provider ID", "DropX ID", "DropX name", "Mapping status", "Payment method", "Payment method code", ...paymentKeys, "Minimum units", "Effective from", "Effective to", "Outbound months"];
      const body = exportRows.map((row) => {
        const method = paymentMethodById.get(row.paymentMethodId);
        return [
          row.providerMemberId, row.providerMemberName, row.stationLabel, row.providerId, row.dropxId, row.dropxName,
          row.workforceId ? "Mapped" : "Unmapped", method?.name ?? "", method?.code ?? "",
          ...paymentKeys.map((key) => row.paymentValues?.[key] ?? ""),
          row.productionThresholdMinimumUnits, row.effectiveFrom, row.effectiveTo, (row.outboundMonths ?? []).join(", ")
        ].map((value) => String(value ?? ""));
      });
      const fileBase = `provider-member-mapping-${new Date().toISOString().slice(0, 10)}`;
      if (exportFormat === "xlsx") {
        const XLSX = await import("xlsx");
        const sheet = XLSX.utils.aoa_to_sheet([head, ...body]);
        sheet["!cols"] = head.map((title) => ({ wch: Math.min(40, Math.max(12, title.length + 2)) }));
        sheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: body.length, c: head.length - 1 } }) };
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, sheet, "Provider mapping");
        XLSX.writeFile(workbook, `${fileBase}.xlsx`, { compression: true });
      } else {
        // Quote when needed and neutralise spreadsheet formulas in text cells.
        const cell = (value: string) => {
          const safe = /^[=+\-@\t\r]/.test(value) && !/^-?\d+(\.\d+)?$/.test(value) ? `'${value}` : value;
          return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, "\"\"")}"` : safe;
        };
        const csv = "﻿" + [head, ...body].map((line) => line.map(cell).join(",")).join("\r\n");
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = `${fileBase}.csv`;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setExportOpen(false);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "The download could not be prepared.");
    } finally {
      setExporting(false);
    }
  }

  function update(index: number, change: Partial<ProviderFirstMappingRow>) {
    setErrors((current) => { const next = { ...current }; delete next[index]; return next; });
    if (Object.prototype.hasOwnProperty.call(change, "paymentMethodId")) {
      setPaymentTemplateSources(current => { const next = { ...current }; delete next[index]; return next; });
    }
    setSaveNotice(null);
    setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...change } : row));
  }

  function updateEffectivePeriod(index: number, change: Pick<ProviderFirstMappingRow, "effectiveFrom"> | Pick<ProviderFirstMappingRow, "effectiveTo">) {
    setErrors((current) => { const next = { ...current }; delete next[index]; return next; });
    setSaveNotice(null);
    setRows((current) => current.map((row, rowIndex) => {
      if (rowIndex !== index) return row;
      const next = { ...row, ...change };
      // A new assignment is entered explicitly. Dates must not turn an old
      // closed period into the edit target or overwrite the user's rates.
      if (!baselineRows[index].workforceId) return next;
      return providerFirstRowForMappingPeriod(next, workerById.get(next.workforceId));
    }));
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

  function registeredMappingFromRow(row: ProviderFirstMappingRow): ProviderFirstRegisteredMappingView {
    return {
      mappingId: row.mappingId,
      stationId: row.stationId,
      locationLabel: row.stationLabel,
      providerId: row.providerId,
      mappedProviderMemberId: row.providerMemberId,
      paymentMethodId: row.paymentMethodId,
      paymentValues: row.paymentValues,
      productionThresholdConfig: row.productionThresholdConfig,
      productionThresholdMinimumUnits: row.productionThresholdMinimumUnits,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      status: row.effectiveTo ? "closed" : "active"
    };
  }

  function registeredMappingsAfterSave(worker: ProviderFirstWorker, saved: ProviderFirstMappingRow) {
    const stored = worker.registeredLocationMappings?.length
      ? worker.registeredLocationMappings
      : worker.registeredLocationMapping
        ? [worker.registeredLocationMapping]
        : [];
    const next = registeredMappingFromRow(saved);
    return [next, ...stored.filter((mapping) => mapping.mappingId !== next.mappingId)]
      .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom));
  }

  function currentMappingsAfterSave(worker: ProviderFirstWorker, saved: ProviderFirstMappingRow) {
    const next = registeredMappingFromRow(saved);
    return [next, ...(worker.currentMappings ?? []).filter((mapping) => mapping.mappingId !== next.mappingId)]
      .filter((mapping) => mapping.status === "active" && !mapping.effectiveTo)
      .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom));
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

  const currentLookupEntries = useMemo(() => {
    const live = new Map(lookupEntries.map(entry => [entry.key, entry]));
    for (const [index,row] of baselineRows.entries()) {
      if (row === mappings[index]) continue;
      const worker = workerById.get(row.workforceId);
      for (const [key,entry] of live) {
        if (!entry.history.length && ((entry.stationId === row.stationId && entry.providerMemberId === row.providerMemberId) || (row.workforceId && entry.workforceId === row.workforceId))) live.delete(key);
      }
      for (const entry of row.history) {
        const previousEntry = lookupEntries.find(item => item.history.some(record => record.id === entry.id));
        if (previousEntry) {
          live.set(entry.id,{...previousEntry,history:[entry]});
        } else if (!entry.locationLabel || entry.locationLabel === row.stationLabel) {
          live.set(entry.id,{key:entry.id,stationId:row.stationId,stationLabel:row.stationLabel,workforceId:row.workforceId,dropxId:row.dropxId,fullName:row.dropxName,providerMemberId:row.providerMemberId,providerMemberName:row.providerMemberName,profileLocationLabel:worker?.profileLocationLabel ?? worker?.locationLabel ?? '',history:[entry]});
        }
      }
      if (!row.workforceId) live.set(`provider:${row.stationId}:${row.providerMemberId}`,{key:`provider:${row.stationId}:${row.providerMemberId}`,stationId:row.stationId,stationLabel:row.stationLabel,workforceId:'',dropxId:'',fullName:'',providerMemberId:row.providerMemberId,providerMemberName:row.providerMemberName,profileLocationLabel:'',history:[]});
    }
    return [...live.values()];
  }, [lookupEntries,baselineRows,mappings,workerById]);

  function applySavedSchedule(index: number, saved: SavedScheduleMappings) {
    const original = rows[index];
    const worker = workerById.get(original.workforceId);
    const savedRows = saved.filter(stored => stored.status !== "cancelled").map(stored => {
      const snapshot = parseProductionThresholdSnapshot(stored.production_threshold_config);
      return { ...original, mappingId: stored.id, paymentMethodId: stored.payment_method_id, paymentValues: Object.fromEntries(Object.entries(stored.payment_values ?? {}).map(([key,value]) => [key,String(value)])), effectiveFrom: stored.effective_from, effectiveTo: stored.effective_to ?? "", productionThresholdConfig: snapshot ? { period:snapshot.period,component_codes:snapshot.component_codes } : null, productionThresholdMinimumUnits: snapshot ? String(snapshot.minimum_units) : "" };
    });
    let history = original.history;
    for (const savedRow of savedRows) history = reconciledHistory(savedRow,savedRow,history);
    const current = savedRows.find(item => !item.effectiveTo) ?? savedRows.filter(item => item.effectiveTo >= mappingLookupToday()).at(-1);
    const canonical = current ? {...current,history} : clearCurrentMapping(original,history);
    setRows(previous => previous.map((item,i) => i === index ? canonical : item));
    setBaselineRows(previous => previous.map((item,i) => i === index ? canonical : item));
    if (worker) setWorkerRows(previous => previous.map(item => {
      if (item.id !== original.workforceId) return item;
      const periods = savedRows.map(registeredMappingFromRow);
      const ids = new Set(periods.map(period => period.mappingId));
      const currentMappings = [...(item.currentMappings ?? []).filter(period => !ids.has(period.mappingId)), ...periods.filter(period => !period.effectiveTo)];
      const mappingHistory = [...(item.mappingHistory ?? []).filter(period => !ids.has(period.mappingId)),...periods];
      const registeredLocationMappings = item.profileStationId === original.stationId ? [...(item.registeredLocationMappings ?? []).filter(period => !ids.has(period.mappingId)),...periods] : item.registeredLocationMappings;
      return {...item,currentMappings,mappingHistory,registeredLocationMappings,registeredLocationMapping:registeredLocationMappings?.[0], ...(current ? {mappingId:current.mappingId,paymentMethodId:current.paymentMethodId,paymentValues:current.paymentValues,effectiveFrom:current.effectiveFrom,effectiveTo:current.effectiveTo,mappedProviderMemberId:current.providerMemberId} : {mappingId:"",mappedProviderMemberId:""})};
    }));
    setScheduleIndex(null); setSaveNotice({kind:"success",message:"Payment periods saved together. The scheduled methods will apply on their effective dates."});
  }

  function chooseWorker(index: number, workerId: string) {
    const worker = workerById.get(workerId);
    if (worker && rows[index].workforceId === worker.id) return;
    setPaymentTemplateSources(current => { const next = { ...current }; delete next[index]; return next; });
    if (!worker) {
      update(index, { workforceId: "", dropxId: "", dropxName: "", mappingId: baselineRows[index].mappingId, paymentMethodId: "", paymentValues: {}, productionThresholdConfig: null, productionThresholdMinimumUnits: "", effectiveFrom: "", effectiveTo: "" });
      return;
    }
    const row = rows[index];
    if (!baselineRows[index].workforceId) {
      update(index, {
        workforceId: worker.id,
        dropxId: worker.dropxId,
        dropxName: worker.fullName,
        providerId: row.providerId || worker.providerId,
        mappingId: "",
        paymentMethodId: "",
        paymentValues: {},
        productionThresholdConfig: null,
        productionThresholdMinimumUnits: "",
        effectiveFrom: "",
        effectiveTo: ""
      });
      return;
    }
    // Keep active mapping state independent from registered-location evidence.
    // A third location must inherit the exact registered anchor, even when the
    // worker also has an active mapping at a different additional location.
    const mappingReference = providerFirstMappingReferenceForRow(row, worker);
    const targetHasMappingReference = Boolean(mappingReference?.mappingId);
    update(index, {
      workforceId: worker.id,
      dropxId: worker.dropxId,
      dropxName: worker.fullName,
      mappingId: mappingReference?.mappingId ?? "",
      providerId: row.providerId || mappingReference?.providerId || worker.providerId,
      paymentMethodId: targetHasMappingReference ? mappingReference?.paymentMethodId ?? "" : row.paymentMethodId,
      paymentValues: targetHasMappingReference ? mappingReference?.paymentValues ?? {} : row.paymentValues,
      productionThresholdConfig: targetHasMappingReference ? mappingReference?.productionThresholdConfig ?? null : row.productionThresholdConfig,
      productionThresholdMinimumUnits: targetHasMappingReference ? mappingReference?.productionThresholdMinimumUnits ?? "" : row.productionThresholdMinimumUnits,
      effectiveFrom: targetHasMappingReference ? mappingReference?.effectiveFrom ?? "" : row.effectiveFrom || worker.dateOfJoin,
      effectiveTo: targetHasMappingReference ? mappingReference?.effectiveTo ?? "" : row.effectiveTo
    });
  }

  function usePreviousPaymentDetails(index: number) {
    const row = rows[index];
    const previous = providerFirstPaymentTemplateForRow(row, workerById.get(row.workforceId));
    if (!previous || baselineRows[index].workforceId || !paymentMethodById.has(previous.paymentMethodId)) return;
    update(index, {
      paymentMethodId: previous.paymentMethodId,
      paymentValues: { ...previous.paymentValues },
      productionThresholdConfig: previous.productionThresholdConfig,
      productionThresholdMinimumUnits: previous.productionThresholdMinimumUnits
    });
    setPaymentTemplateSources(current => ({ ...current, [index]: previous }));
  }

  async function saveIndexes(
    indexes: number[],
    confirmedMappingIds: Record<number, string> = {},
    confirmedActions: Record<number, "move" | "keep"> = {},
    confirmedPaidHistoryDecisions: Record<number, PaidHistoryDecision> = {}
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
      replacementAction: confirmedActions[index] ?? "" as const,
      paidHistoryDecision: confirmedPaidHistoryDecisions[index]
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
      snapshot.paidHistoryDecision,
      snapshot.previousWorkforceId
    ));
    setSavingIndexes(new Set(selected));
    setSaveNotice(null);

    try {
      const result = await saveProviderFirstMappingsInline(data) as Awaited<ReturnType<typeof saveProviderFirstMappingsInline>> & {
        paidHistoryTransfer?: PaidHistoryTransferConfirmation;
      };
      const canonicalByIndex = new Map<number, ProviderFirstMappingRow>();
      const boundedHistoryByIndex = new Map<number, ProviderFirstMappingRow>();
      const clearedByIndex = new Map<number, { row: ProviderFirstMappingRow; expectedMappingId: string }>();
      const mappingClosuresByWorker = new Map<string, Array<{ mappingId: string; effectiveTo: string; status: "closed" | "cancelled" }>>();
      const rememberClosure = (workforceId: string, mappingId: string, effectiveTo: string, status: "closed" | "cancelled") => {
        if (!workforceId || !mappingId) return;
        mappingClosuresByWorker.set(workforceId, [
          ...(mappingClosuresByWorker.get(workforceId) ?? []).filter((closure) => closure.mappingId !== mappingId),
          { mappingId, effectiveTo, status }
        ]);
      };
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
          const closedWorkerId = saved.cleared.previousWorkforceId || snapshot.previousWorkforceId;
          rememberClosure(closedWorkerId, saved.cleared.previousMappingId, saved.cleared.previousEffectiveTo, saved.cleared.previousStatus);
          continue;
        }
        const baseline = baselineRows[snapshot.index];
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
          rememberClosure(
            origin?.workforceId || snapshot.previousWorkforceId || canonical.workforceId,
            saved.relocation.previousMappingId,
            saved.relocation.previousEffectiveTo,
            saved.relocation.previousStatus
          );
        } else {
          canonical = { ...canonical, history: reconciledHistory(baseline, canonical) };
          // Ordinary versioning can close an active row without returning a
          // relocation payload. Mirror that closure immediately so a second
          // edit cannot target the stale active mapping before a reload.
          if (snapshot.replacementAction !== "keep" && baseline.mappingId && baseline.workforceId) {
            if (baseline.mappingId === canonical.mappingId && canonical.effectiveTo) {
              rememberClosure(baseline.workforceId, baseline.mappingId, canonical.effectiveTo, "closed");
            } else if (baseline.mappingId !== canonical.mappingId
              && baseline.effectiveFrom
              && canonical.effectiveFrom > baseline.effectiveFrom) {
              rememberClosure(baseline.workforceId, baseline.mappingId, previousIsoDate(canonical.effectiveFrom), "closed");
            }
          }
        }
        if (canonical.effectiveTo) {
          // Closed mappings belong in history. Keeping one in the current row
          // or worker state makes the no-refresh view disagree with a reload
          // and can later target a historical ID as though it were active.
          boundedHistoryByIndex.set(snapshot.index, canonical);
          const preservesLaterCurrent = snapshot.replacementAction === "keep"
            && Boolean(baseline.mappingId)
            && baseline.mappingId !== canonical.mappingId
            && baseline.workforceId === canonical.workforceId
            && !baseline.effectiveTo
            && baseline.stationId === canonical.stationId
            && baseline.providerId === canonical.providerId
            && providerMemberKey("", baseline.providerMemberId) === providerMemberKey("", canonical.providerMemberId);
          canonicalByIndex.set(
            snapshot.index,
            preservesLaterCurrent
              ? { ...baseline, history: canonical.history }
              : clearCurrentMapping(canonical, canonical.history)
          );
        } else {
          canonicalByIndex.set(snapshot.index, canonical);
        }
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
        const rememberRegisteredMapping = (saved: ProviderFirstMappingRow, profileStationId: string) => {
          if (!saved.workforceId || saved.stationId !== profileStationId) return;
          const worker = workerById.get(saved.workforceId);
          if (!worker) return;
          const pending = workerUpdates.get(saved.workforceId) ?? {};
          const workerWithPendingHistory = {
            ...worker,
            registeredLocationMappings: pending.registeredLocationMappings ?? worker.registeredLocationMappings,
            registeredLocationMapping: pending.registeredLocationMapping ?? worker.registeredLocationMapping
          };
          const registeredLocationMappings = registeredMappingsAfterSave(workerWithPendingHistory, saved);
          workerUpdates.set(saved.workforceId, {
            ...pending,
            registeredLocationMappings,
            registeredLocationMapping: registeredLocationMappings[0]
          });
        };
        for (const snapshot of snapshots) {
          const canonical = canonicalByIndex.get(snapshot.index);
          if (!canonical) continue;
          const boundedHistory = boundedHistoryByIndex.get(snapshot.index);
          const saved = result.savedRows.find((candidate) => candidate.clientKey === snapshot.key);
          if (boundedHistory) {
            rememberRegisteredMapping(boundedHistory, saved?.profileStationId ?? "");
            continue;
          }
          if (snapshot.previousWorkforceId && snapshot.previousWorkforceId !== canonical.workforceId) {
            const remaining = baselineRows.find((candidate, candidateIndex) => candidateIndex !== snapshot.index
              && candidate.workforceId === snapshot.previousWorkforceId
              && candidate.mappingId
              && !candidate.effectiveTo);
            if (remaining) {
              const existingWorker = workerById.get(snapshot.previousWorkforceId);
              workerUpdates.set(snapshot.previousWorkforceId, {
                ...(workerUpdates.get(snapshot.previousWorkforceId) ?? {}),
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
              workerClears.set(snapshot.previousWorkforceId, saved?.cleared?.previousMappingId ?? snapshot.row.mappingId);
            }
          }
          if (!canonical.workforceId) continue;
          const existingWorker = workerById.get(canonical.workforceId);
          const pending = workerUpdates.get(canonical.workforceId) ?? {};
          const currentMappings = existingWorker
            ? currentMappingsAfterSave({ ...existingWorker, currentMappings: pending.currentMappings ?? existingWorker.currentMappings }, canonical)
            : [];
          const profileStationId = saved?.profileStationId ?? canonical.stationId;
          const preferredCurrent = currentMappings.find((mapping) => mapping.stationId === profileStationId)
            ?? currentMappings[0]
            ?? registeredMappingFromRow(canonical);
          workerUpdates.set(canonical.workforceId, { ...pending, stationId: preferredCurrent.stationId, locationLabel: preferredCurrent.locationLabel, profileStationId, profileLocationLabel: saved?.profileLocationLabel ?? canonical.stationLabel, providerId: preferredCurrent.providerId, mappingId: preferredCurrent.mappingId, paymentMethodId: preferredCurrent.paymentMethodId, paymentValues: preferredCurrent.paymentValues, productionThresholdConfig: preferredCurrent.productionThresholdConfig, productionThresholdMinimumUnits: preferredCurrent.productionThresholdMinimumUnits, effectiveFrom: preferredCurrent.effectiveFrom, effectiveTo: preferredCurrent.effectiveTo, mappedProviderMemberId: preferredCurrent.mappedProviderMemberId, currentMappings });
          rememberRegisteredMapping(canonical, profileStationId);
        }
        setWorkerRows((current) => current.map((worker) => {
          const update = workerUpdates.get(worker.id);
          let next = update ? { ...worker, ...update } : worker;
          const clearedMappingId = workerClears.get(worker.id);
          if (clearedMappingId && next.mappingId === clearedMappingId) {
            next = { ...next, mappingId: "", paymentMethodId: "", paymentValues: {}, productionThresholdConfig: null, productionThresholdMinimumUnits: "", effectiveFrom: "", effectiveTo: "", mappedProviderMemberId: "" };
          }
          const closures = mappingClosuresByWorker.get(worker.id) ?? [];
          if (!closures.length) return next;
          const closureById = new Map(closures.map((closure) => [closure.mappingId, closure]));
          const currentMappings = (next.currentMappings ?? []).filter((mapping) => !closureById.has(mapping.mappingId));
          const registeredLocationMappings = (next.registeredLocationMappings ?? []).flatMap((mapping) => {
            const closure = closureById.get(mapping.mappingId);
            if (!closure) return [mapping];
            if (closure.status === "cancelled") return [];
            return [{ ...mapping, effectiveTo: closure.effectiveTo, status: "closed" as const }];
          });
          const preferredCurrent = currentMappings.find((mapping) => mapping.stationId === next.profileStationId)
            ?? currentMappings[0];
          const closedPrimary = closureById.has(next.mappingId);
          return {
            ...next,
            ...(preferredCurrent ? {
              stationId: preferredCurrent.stationId,
              locationLabel: preferredCurrent.locationLabel,
              providerId: preferredCurrent.providerId,
              mappingId: preferredCurrent.mappingId,
              paymentMethodId: preferredCurrent.paymentMethodId,
              paymentValues: preferredCurrent.paymentValues,
              productionThresholdConfig: preferredCurrent.productionThresholdConfig,
              productionThresholdMinimumUnits: preferredCurrent.productionThresholdMinimumUnits,
              effectiveFrom: preferredCurrent.effectiveFrom,
              effectiveTo: preferredCurrent.effectiveTo,
              mappedProviderMemberId: preferredCurrent.mappedProviderMemberId
            } : closedPrimary ? {
              stationId: next.profileStationId ?? next.stationId,
              locationLabel: next.profileLocationLabel ?? next.locationLabel,
              providerId: "",
              mappingId: "",
              paymentMethodId: "",
              paymentValues: {},
              productionThresholdConfig: null,
              productionThresholdMinimumUnits: "",
              effectiveFrom: "",
              effectiveTo: "",
              mappedProviderMemberId: ""
            } : {}),
            currentMappings,
            registeredLocationMappings,
            registeredLocationMapping: registeredLocationMappings[0]
          };
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
      if (result.paidHistoryTransfer) {
        const failed = snapshotByKey.get(result.paidHistoryTransfer.clientKey);
        if (failed) {
          setPaidHistoryConfirmation({
            indexes: selected,
            index: failed.index,
            confirmation: result.paidHistoryTransfer,
            confirmedMappingIds,
            confirmedActions,
            confirmedPaidHistoryDecisions
          });
        }
      } else if (result.ok) {
        setPaidHistoryConfirmation(null);
      }
      setSaveNotice({ kind: result.ok ? "success" : "error", message: result.message });
    } catch (error) {
      setSaveNotice({ kind: "error", message: error instanceof Error ? error.message : "Unable to save provider mappings." });
    } finally {
      setSavingIndexes(new Set());
    }
  }



  return <div className="worksheet-form">
    <ProviderMappingLookup entries={currentLookupEntries} onShowMapping={(stationId, providerId) => { clearFilters(); setStationFilters([stationId]); setQuery(providerId); }} />
    <section className="panel">
      <div className="panel-head provider-first-panel-head">
        <div><h2>Provider member mapping</h2><p className="subtle">Available associates across your permitted locations. Use Find mapping to locate an ID already assigned.</p>{saveNotice ? <p aria-live="polite" className={saveNotice.kind === "error" ? "mapping-upload-error" : "mapping-upload-success"}>{saveNotice.message}</p> : null}</div>
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
        <div className="provider-first-filter-summary"><strong>{visibleIndexes.length}</strong><span>of {rows.length}</span><button className="button secondary compact provider-mapping-download-trigger" disabled={!rows.length} onClick={openExport} type="button"><Download aria-hidden="true" size={15} /> Download</button>{hasFilters ? <button className="button secondary compact" onClick={clearFilters} type="button">Clear</button> : null}</div>
        {exportOpen ? <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target && !exporting) setExportOpen(false); }}>
          <section aria-labelledby="provider-mapping-download-title" aria-modal="true" className="modal-panel provider-mapping-download-dialog" role="dialog">
            <div className="panel-head">
              <div>
                <h2 id="provider-mapping-download-title">Download provider mapping</h2>
                <p className="subtle">All saved records are included by default. Narrow with the filters below if needed.</p>
              </div>
              <button aria-label="Close download" className="icon-button" disabled={exporting} onClick={() => setExportOpen(false)} type="button"><X aria-hidden="true" size={18} /></button>
            </div>
            <div className="provider-mapping-download-body">
              <div className="provider-mapping-download-filters">
                <MappingMultiFilter allLabel="All months" label="Outbound month" options={monthOptions} selected={exportFilters.months} setSelected={(months) => setExportFilters((current) => ({ ...current, months }))} />
                <MappingMultiFilter allLabel="All locations" label="Location" options={stations.map(([value, label]) => ({ value, label, searchText: label }))} selected={exportFilters.stations} setSelected={(stations) => setExportFilters((current) => ({ ...current, stations }))} />
                <MappingMultiFilter allLabel="All methods" label="Payment method" options={[{ value: "unassigned", label: "No payment method", searchText: "unassigned no payment method" }, ...paymentMethods.map((method) => ({ value: method.id, label: `${method.name}${method.isActive === false ? " (Inactive)" : ""}`, searchText: `${method.name} ${method.code}` }))]} selected={exportFilters.methods} setSelected={(methods) => setExportFilters((current) => ({ ...current, methods }))} />
                <MappingMultiFilter allLabel="All records" label="Mapping" options={[{ value: "mapped", label: "Mapped" }, { value: "unmapped", label: "Unmapped" }]} selected={exportFilters.mapping} setSelected={(mapping) => setExportFilters((current) => ({ ...current, mapping }))} />
                <MappingMultiFilter allLabel="All statuses" label="Validation" options={[{ value: "ready", label: "Ready" }, { value: "needs_attention", label: "Needs attention" }, { value: "unmapped", label: "Unmapped" }]} selected={exportFilters.validation} setSelected={(validation) => setExportFilters((current) => ({ ...current, validation }))} />
              </div>
              <fieldset className="provider-mapping-download-formats">
                <legend>Format</legend>
                <label className={exportFormat === "xlsx" ? "is-selected" : undefined}>
                  <input checked={exportFormat === "xlsx"} name="provider-mapping-format" onChange={() => setExportFormat("xlsx")} type="radio" />
                  <FileSpreadsheet aria-hidden="true" size={20} />
                  <span><strong>Excel (.xlsx)</strong><small>Formatted sheet with column filters</small></span>
                </label>
                <label className={exportFormat === "csv" ? "is-selected" : undefined}>
                  <input checked={exportFormat === "csv"} name="provider-mapping-format" onChange={() => setExportFormat("csv")} type="radio" />
                  <FileText aria-hidden="true" size={20} />
                  <span><strong>CSV (.csv)</strong><small>Plain text for any tool or import</small></span>
                </label>
              </fieldset>
              {exportError ? <p className="mapping-upload-error" role="alert">{exportError}</p> : null}
            </div>
            <div className="provider-mapping-download-actions">
              <span className="subtle"><strong>{exportIndexes.length}</strong> of {baselineRows.length} records</span>
              <div>
                {Object.values(exportFilters).some((values) => values.length) ? <button className="button secondary" disabled={exporting} onClick={() => setExportFilters(emptyExportFilters)} type="button">Reset to all</button> : null}
                <button className="button secondary" disabled={exporting} onClick={() => setExportOpen(false)} type="button">Cancel</button>
                <button className="button" disabled={exporting || !exportIndexes.length} onClick={() => void downloadMappings()} type="button"><Download aria-hidden="true" size={16} /> {exporting ? "Preparing..." : `Download ${exportFormat === "xlsx" ? "Excel" : "CSV"}`}</button>
              </div>
            </div>
          </section>
        </div> : null}
      </div>
      <div className="mapping-rows provider-first-rows">{paginatedIndexes.map((index) => {
        const row = rows[index];
        const selectedWorker = workerById.get(row.workforceId);
        const previousPayment = !baselineRows[index].workforceId ? providerFirstPaymentTemplateForRow(row, selectedWorker) : undefined;
        const copiedPayment = !baselineRows[index].workforceId ? paymentTemplateSources[index] : undefined;
        const mappingConflict = isMappedToAnotherMember(row, selectedWorker);
        const locationRemap = providerFirstLocationRemap(row, selectedWorker);
        const locationNeedsDates = providerFirstLocationNeedsDates(row, selectedWorker);
        const locationMismatch = Boolean(selectedWorker && !locationNeedsDates && !providerFirstLocationIsAllowed(row, selectedWorker));
        const profileLocationDrift = Boolean(selectedWorker?.profileStationId && selectedWorker.profileStationId !== selectedWorker.stationId);
        const priorMappingLocations = [...new Set(row.history.map((entry) => entry.locationLabel).filter(Boolean))];
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
            <div className="mapping-field mapping-payment-method-select provider-first-workforce-select provider-first-selection-field"><span className="mapping-field-label">DropX ID / name</span><SearchableSelect disabled={!canEditRow} maxOptions={50} name={`provider_first_worker_${index}`} onValueChange={(value) => chooseWorker(index, value)} options={selectableWorkerOptionsByIndex.get(index) ?? []} placeholder="Select available DropX associate" value={row.workforceId} />{row.workforceId ? <span className="provider-first-selected-detail" title={`${row.dropxId} · ${row.dropxName}`}>{row.dropxId} · {row.dropxName}</span> : row.mappingId ? <span className="provider-first-selected-detail">Save to clear this mapping. Its history will be preserved.</span> : null}</div>
            <div className="mapping-field mapping-payment-method-select provider-first-selection-field"><span className="mapping-field-label">Payment method</span><SearchableSelect disabled={!canEditRow || !row.workforceId} name={`provider_first_payment_method_${index}`} onValueChange={(value) => update(index, { paymentMethodId: value, paymentValues: {}, productionThresholdConfig: paymentMethodById.get(value)?.productionThresholdConfig ?? null, productionThresholdMinimumUnits: "" })} options={rowPaymentOptions} placeholder="Search payment method" required value={row.paymentMethodId} />{selectedPaymentMethod ? <span className="provider-first-selected-detail" title={`${selectedPaymentMethod.name} · ${selectedPaymentMethod.code}${selectedPaymentMethod.isActive === false ? " · Inactive" : ""}`}>{selectedPaymentMethod.name} · {selectedPaymentMethod.code}{selectedPaymentMethod.isActive === false ? " · Inactive" : ""}</span> : null}</div>
            {components.map((component) => <label key={component.code}>{component.label}<input className="worksheet-input" disabled={!canEditRow || !row.workforceId} min="0" onChange={(event) => update(index, { paymentValues: { ...row.paymentValues, [component.code]: event.target.value } })} placeholder="0.00" step="0.01" type="number" value={row.paymentValues[component.code] ?? ""} /></label>)}
            {productionThresholdConfig ? <label>
              Combined minimum / {productionThresholdConfig.period}
              <input className="worksheet-input" disabled={!canEditRow || !row.workforceId} min="1" onChange={(event) => update(index, { productionThresholdMinimumUnits: event.target.value })} placeholder="Enter minimum units" step="1" type="number" value={row.productionThresholdMinimumUnits} />
              <span className="provider-first-selected-detail">Combined across {productionThresholdConfig.component_codes.map((code) => components.find((component) => component.code === code)?.label ?? code).join(" + ")}</span>
            </label> : null}
            <div className="mapping-period-row"><label>Effective from<input className="worksheet-input" disabled={!canEditRow || !row.workforceId} onChange={(event) => updateEffectivePeriod(index, { effectiveFrom: event.target.value })} required type="date" value={row.effectiveFrom} /></label><label>Effective to <span className="subtle">(optional)</span><input className="worksheet-input" disabled={!canEditRow || !row.workforceId} onChange={(event) => updateEffectivePeriod(index, { effectiveTo: event.target.value })} type="date" value={row.effectiveTo} /></label><p className="mapping-period-help">{!baselineRows[index].workforceId && !row.paymentMethodId ? "Choose the payment method, rates and start date. Previous payment details are in History. " : ""}Set an end date to plan another payment method with + Add payment period. The final period can stay ongoing.</p></div>
            {copiedPayment ? <div className="mapping-period-help" role="status"><strong>Previous payment details loaded.</strong> Method and rates copied from {paymentMethodById.get(copiedPayment.paymentMethodId)?.name ?? "previous payment method"} · {copiedPayment.locationLabel} · {copiedPayment.effectiveFrom} to {copiedPayment.effectiveTo || "Ongoing"}. Review the rates and choose dates for this assignment before saving. Previous dates were not copied.</div> : previousPayment ? <div className="mapping-period-help">Previous payment details are available from {previousPayment.effectiveFrom} to {previousPayment.effectiveTo || "Ongoing"}. Use them below to copy the method and rates; enter dates for this assignment.</div> : null}
            {!row.mappingId && priorMappingLocations.length ? <div className="mapping-period-help"><strong>Existing mapping history:</strong> {priorMappingLocations.join(", ")}. This {row.stationLabel} row is not mapped; save its own effective-dated mapping before using this location&apos;s activity for payout.</div> : null}
            {row.workforceId && !providerFirstNamesMatch(row.providerMemberName, row.dropxName) ? <div className="mapping-row-error">Name mismatch</div> : null}
            {locationNeedsDates ? <div className="mapping-period-help" role="status">Registered at {selectedWorker?.profileLocationLabel}. This provider ID already has a mapping there. Enter the effective dates to validate the additional {row.stationLabel} assignment. Location is checked from the Workforce record, not the prefix of the DropX ID.</div> : null}
            {locationRemap ? <div className="mapping-period-help">{locationRemap.allowMove === false ? `Additional location: ${locationRemap.newLocationLabel}. Use Keep all when saving to preserve the existing ${locationRemap.existingLocationLabel} mapping.` : `Location change: ${locationRemap.existingLocationLabel} → ${locationRemap.newLocationLabel}.`} Save this location mapping before adding payment periods.</div> : null}
            {profileLocationDrift && !locationRemap ? <div className="mapping-period-help">Mapping location: {selectedWorker?.locationLabel}. Workforce current location: {selectedWorker?.profileLocationLabel}. Saving rates here will not move the Workforce profile; use its current-location provider row to move this mapping.</div> : null}
            {locationMismatch ? <div className="mapping-row-error">Location mismatch</div> : null}
            {mappingConflict ? <div className="mapping-row-error">This DropX ID is already mapped to Provider Member ID {selectedWorker?.mappedProviderMemberId}. Select another DropX ID. Save is blocked.</div> : null}
            {errors[index] ? <div className="mapping-row-error">{errors[index]}</div> : null}
          </div>
          <div className="mapping-row-actions">{previousPayment && !row.paymentMethodId && paymentMethodById.has(previousPayment.paymentMethodId) ? <button type="button" className="button secondary compact" disabled={!canEditRow} onClick={() => usePreviousPaymentDetails(index)}>Use previous payment details</button> : null}<button type="button" className="button secondary compact" title={row.effectiveTo ? "Plan consecutive payment methods together" : "Enter an end date to add another payment period"} disabled={!canEditRow || !row.workforceId || !row.effectiveFrom || !row.effectiveTo || mappingConflict || locationMismatch || Boolean(locationRemap) || !providerFirstNamesMatch(row.providerMemberName,row.dropxName) || Boolean(baselineRows[index].workforceId && baselineRows[index].workforceId !== row.workforceId)} onClick={() => setScheduleIndex(index)}>+ Add payment period</button><PaymentAllocationHistoryButton loadMappingAudit entries={row.history} subjectLabel={`${row.providerMemberName} · ${row.providerMemberId}`} /><RowButton busy={isSaving} canEdit={canEdit && !roundedSourceId} dirty={dirtyRows[index]} index={index} nameMatches={(!row.workforceId || providerFirstNamesMatch(row.providerMemberName, row.dropxName)) && !mappingConflict && !locationMismatch} onSave={(rowIndex) => void saveIndexes([rowIndex])} /></div>
        </div>;
      })}{!paginatedIndexes.length ? <div className="empty-state"><strong>No matching provider members.</strong><p className="subtle">Change or clear the filters to see more records.</p></div> : null}</div>
      <div className="mapping-pagination">
        <span>Showing {pageWindow.shownFrom}–{pageWindow.shownTo} of {visibleIndexes.length}</span>
        <div className="mapping-pagination-actions"><button className="button secondary compact" disabled={pageWindow.page <= 1} onClick={() => setCurrentPage((page) => Math.max(1, page - 1))} type="button">Previous</button><span>Page {pageWindow.page} of {pageWindow.totalPages}</span><button className="button secondary compact" disabled={pageWindow.page >= pageWindow.totalPages} onClick={() => setCurrentPage((page) => Math.min(pageWindow.totalPages, page + 1))} type="button">Next</button></div>
      </div>
    </section>
    {scheduleIndex !== null ? <ProviderMappingSchedule row={rows[scheduleIndex]} methods={paymentMethods} onClose={() => setScheduleIndex(null)} onSaved={(saved) => applySavedSchedule(scheduleIndex,saved)} /> : null}
    {replacementConfirmation ? (() => {
      const active = replacementConfirmation.replacements[replacementConfirmation.cursor];
      return <div className="modal-backdrop confirmation-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !isSaving) setReplacementConfirmation(null); }}>
        <section aria-labelledby="provider-replacement-title" aria-modal="true" className="modal-panel confirmation-dialog" role="alertdialog">
          <div className="modal-head"><div><h2 id="provider-replacement-title">{active.replacement.kind === "location" ? "Choose location mapping action" : "Replace existing mapping?"}</h2></div></div>
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
            {active.replacement.allowMove !== false ? <button className="button" disabled={isSaving} onClick={() => {
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
            }} type="button">{active.replacement.kind === "location" ? "Move mapping" : "Replace mapping"}</button> : null}
          </div>
        </section>
      </div>;
    })() : null}
    {paidHistoryConfirmation ? (() => {
      const payment = paidHistoryConfirmation.confirmation;
      const paidAmount = Number(payment.paidAmount);
      const paymentLabel = payment.paymentCount && payment.paymentCount > 1
        ? `${payment.paymentCount} completed bank payments totalling ${rupees.format(Number.isFinite(paidAmount) ? paidAmount : 0)}`
        : `${rupees.format(Number.isFinite(paidAmount) ? paidAmount : 0)} already paid`;
      const choosePaidHistoryAction = (action: PaidHistoryAction) => {
        const confirmedPaidHistoryDecisions = {
          ...paidHistoryConfirmation.confirmedPaidHistoryDecisions,
          [paidHistoryConfirmation.index]: {
            action,
            paymentFingerprint: payment.paymentFingerprint,
            operationId: payment.operationId
          }
        };
        const indexes = paidHistoryConfirmation.indexes;
        const mappingIds = paidHistoryConfirmation.confirmedMappingIds;
        const mappingActions = paidHistoryConfirmation.confirmedActions;
        setPaidHistoryConfirmation({ ...paidHistoryConfirmation, confirmedPaidHistoryDecisions });
        void saveIndexes(indexes, mappingIds, mappingActions, confirmedPaidHistoryDecisions);
      };
      return <div className="modal-backdrop confirmation-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !isSaving) setPaidHistoryConfirmation(null); }}>
        <section aria-labelledby="paid-history-transfer-title" aria-modal="true" className="modal-panel confirmation-dialog" role="alertdialog">
          <div className="modal-head"><div><h2 id="paid-history-transfer-title">What should happen to the paid amount?</h2></div></div>
          <div className="confirmation-body">
            <p><strong>{payment.providerMemberId}</strong>{payment.providerMemberName ? ` · ${payment.providerMemberName}` : ""} has {paymentLabel} under <strong>{payment.existingDropxId}</strong>{payment.existingDropxName ? ` · ${payment.existingDropxName}` : ""}.</p>
            <p>You are mapping it to <strong>{payment.newDropxId}</strong>{payment.newDropxName ? ` · ${payment.newDropxName}` : ""}. Choose whether its paid credit should transfer to the new ID or remain with the existing ID.</p>
            <p className="subtle">Transferring does not create, reverse or rewrite a bank payment. The original bank reference and UTR remain unchanged, and an audited paid credit is applied to the new ID so the amount is not paid twice.</p>
            {!payment.transferAllowed && payment.transferBlockedReason ? <div className="mapping-row-error">{payment.transferBlockedReason}</div> : null}
          </div>
          <div className="form-actions modal-actions confirmation-actions">
            <button className="button secondary" disabled={isSaving} onClick={() => setPaidHistoryConfirmation(null)} type="button">Cancel</button>
            <button className="button secondary" disabled={isSaving} onClick={() => choosePaidHistoryAction("keep")} type="button">Keep paid credit with {payment.existingDropxId}</button>
            <button className="button" disabled={isSaving || !payment.transferAllowed} onClick={() => choosePaidHistoryAction("transfer")} type="button">Transfer payment details to {payment.newDropxId}</button>
          </div>
        </section>
      </div>;
    })() : null}
  </div>;
}
