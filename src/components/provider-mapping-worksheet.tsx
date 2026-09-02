"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";
import { bulkUploadProviderIds, saveProviderMappingWorksheet } from "@/app/provider-mapping/actions";
import { SearchableSelect } from "@/components/searchable-select";
import { SubmitButton } from "@/components/submit-button";

export type LocationOption = {
  id: string;
  label: string;
  providerId?: string;
};

export type MappingWorksheetRow = {
  id: string;
  sourceType: "workforce";
  mappingId: string;
  dropxId: string;
  dropxName: string;
  providerMemberId: string;
  providerId: string;
  stationId: string;
  effectiveFrom: string;
  effectiveTo: string;
  paymentMethodId: string;
  paymentValues: Record<string, string>;
  deliveryRate: string;
  pickupRate: string;
  mfnRate: string;
  mfnReturnRate: string;
  guaranteeAmount: string;
  guaranteeSchedule: string;
  fuelRate: string;
  reason: string;
};

export type PaymentMethodComponentOption = {
  code: string;
  label: string;
  type: "amount" | "production";
};

export type PaymentMethodOption = {
  id: string;
  code: string;
  name: string;
  components: PaymentMethodComponentOption[];
};

function rowSignature(row: MappingWorksheetRow) {
  return [
    row.id,
    row.sourceType,
    row.mappingId,
    row.dropxId,
    row.dropxName,
    row.providerId,
    row.providerMemberId,
    row.stationId,
    row.effectiveFrom,
    row.effectiveTo,
    row.paymentMethodId,
    JSON.stringify(row.paymentValues),
    row.deliveryRate,
    row.pickupRate,
    row.mfnRate,
    row.mfnReturnRate,
    row.guaranteeAmount,
    row.guaranteeSchedule,
    row.fuelRate,
  ].join("|");
}

function RowSaveButton({ canEdit, dirty, index, lookupValid }: { canEdit: boolean; dirty: boolean; index: number; lookupValid: boolean }) {
  const { pending } = useFormStatus();

  return (
    <button
      className={`button compact mapping-row-save${dirty ? "" : " secondary"}`}
      disabled={pending || !canEdit || !dirty || !lookupValid}
      name="save_row"
      type="submit"
      value={index}
    >
      {pending ? <span className="button-spinner" aria-hidden="true" /> : null}
      <span>{pending ? "Saving" : "Save"}</span>
    </button>
  );
}

function csvCell(value: string | number) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function BulkIdUpload({ canEdit }: { canEdit: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const [reportUrl, setReportUrl] = useState("");

  useEffect(() => () => {
    if (reportUrl) URL.revokeObjectURL(reportUrl);
  }, [reportUrl]);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage("");
    setError(false);
    if (reportUrl) URL.revokeObjectURL(reportUrl);
    setReportUrl("");
    try {
      const result = await bulkUploadProviderIds(new FormData(event.currentTarget));
      setMessage(result.message);
      setError(!result.ok);
      if (result.rows.length) {
        const csv = [
          ["ROW", "DROPX_ID", "PROVIDER_MEMBER_ID", "PAYMENT_METHOD_CODE", "RESULT", "REASON"].map(csvCell).join(","),
          ...result.rows.map((row) => [row.rowNumber, row.dropxId, row.providerMemberId, row.paymentMethodCode, row.result, row.reason].map(csvCell).join(","))
        ].join("\r\n");
        setReportUrl(URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" })));
      }
      if (result.ok) router.refresh();
    } catch (uploadError) {
      setError(true);
      setMessage(uploadError instanceof Error ? uploadError.message : "Unable to upload ID mappings.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="mapping-id-upload-form" onSubmit={upload}>
      <label>Excel / CSV file
        <input accept=".xlsx,.xls,.csv" disabled={!canEdit || pending} name="mapping_file" type="file" />
      </label>
      <button className="button" disabled={!canEdit || pending} type="submit">{pending ? "Uploading..." : "Upload mappings"}</button>
      {reportUrl ? <a className="button secondary" download={`provider-id-upload-report-${new Date().toISOString().slice(0, 10)}.csv`} href={reportUrl}>Download report</a> : null}
      {message ? <span className={error ? "mapping-upload-error" : "mapping-upload-success"}>{message}</span> : null}
    </form>
  );
}

type ProviderMemberLookupResult = {
  name: string | null;
  workDate: string | null;
};

type FilterOption = { value: string; label: string };

function MappingMultiFilter({
  allLabel,
  label,
  options,
  selected,
  setSelected
}: {
  allLabel: string;
  label: string;
  options: FilterOption[];
  selected: string[];
  setSelected: (values: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const visibleOptions = query.trim()
    ? options.filter((option) => option.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    : options;
  const optionByValue = new Map(options.map((option) => [option.value, option.label]));
  const summary = selected.length === 0
    ? allLabel
    : selected.length <= 2
      ? selected.map((value) => optionByValue.get(value) ?? value).join(", ")
      : `${selected.length} selected`;

  useEffect(() => {
    if (!open) return;
    function close(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function toggle(value: string) {
    setSelected(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  }

  return (
    <div className="mapping-filter-field mapping-bulk-filter" ref={rootRef}>
      <span className="mapping-field-label">{label}</span>
      <div className="bulk-multi-filter">
        <button aria-expanded={open} className={`bulk-multi-filter-trigger ${open ? "open" : ""}`} onClick={() => setOpen((current) => !current)} type="button">
          <strong>{summary}</strong><span aria-hidden="true">v</span>
        </button>
        {open ? <div className="bulk-multi-filter-menu mapping-filter-menu">
          <div className="bulk-multi-filter-search">
            <input autoFocus className="field" onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${label.toLocaleLowerCase()}`} type="search" value={query} />
          </div>
          <div className="bulk-multi-filter-options">
          <label className="bulk-multi-filter-option all">
            <input checked={selected.length === 0} onChange={() => setSelected([])} type="checkbox" />
            <span>All</span>
          </label>
            {visibleOptions.map((option) => <label className="bulk-multi-filter-option" key={option.value}>
              <input checked={selected.includes(option.value)} onChange={() => toggle(option.value)} type="checkbox" />
              <span>{option.label}</span>
            </label>)}
            {!visibleOptions.length ? <p className="subtle mapping-filter-empty">No matching options</p> : null}
          </div>
        </div> : null}
      </div>
    </div>
  );
}

type ProviderMemberLookupStatus = {
  providerMemberId: string;
  name: string | null;
  matches: boolean;
  loading: boolean;
};

function comparableName(value: string) {
  return value
    .split("/")[0]
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLocaleUpperCase();
}

function ProviderMemberName({
  dropxName,
  enabled,
  index,
  onLookupChange,
  providerMemberId
}: {
  dropxName: string;
  enabled: boolean;
  index: number;
  onLookupChange: (index: number, status: ProviderMemberLookupStatus) => void;
  providerMemberId: string;
}) {
  const [result, setResult] = useState<ProviderMemberLookupResult | null>(null);
  const [loading, setLoading] = useState(false);
  const normalizedId = providerMemberId.trim();

  useEffect(() => {
    if (!enabled || !normalizedId) {
      setResult(null);
      setLoading(false);
      onLookupChange(index, { providerMemberId: normalizedId, name: null, matches: false, loading: false });
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setLoading(true);
      onLookupChange(index, { providerMemberId: normalizedId, name: null, matches: false, loading: true });
      try {
        const response = await fetch(`/api/provider-mapping/member-lookup?providerMemberId=${encodeURIComponent(normalizedId)}`, {
          cache: "no-store",
          signal: controller.signal
        });
        if (!response.ok) {
          setResult({ name: null, workDate: null });
          onLookupChange(index, { providerMemberId: normalizedId, name: null, matches: false, loading: false });
          return;
        }
        const nextResult = await response.json() as ProviderMemberLookupResult;
        setResult(nextResult);
        onLookupChange(index, {
          providerMemberId: normalizedId,
          name: nextResult.name,
          matches: Boolean(nextResult.name) && comparableName(nextResult.name ?? "") === comparableName(dropxName),
          loading: false
        });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setResult({ name: null, workDate: null });
          onLookupChange(index, { providerMemberId: normalizedId, name: null, matches: false, loading: false });
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 350);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [dropxName, enabled, index, normalizedId, onLookupChange]);

  if (!enabled || !normalizedId) return null;
  if (loading) return <small className="mapping-provider-member-name pending">Checking uploaded data…</small>;
  if (!result) return null;
  if (!result.name) return <small className="mapping-provider-member-name missing">No uploaded holder found for this ID.</small>;

  const matches = comparableName(result.name) === comparableName(dropxName);
  const holderName = result.name.split("/")[0].trim();

  return (
    <small className={`mapping-provider-member-name ${matches ? "matched" : "missing"}`}>
      Holder name: {holderName}
      {!matches ? <span>Name does not match {dropxName}.</span> : null}
    </small>
  );
}

export function ProviderMappingWorksheet({
  canEdit,
  locations,
  mappings,
  paymentMethods
}: {
  canEdit: boolean;
  locations: LocationOption[];
  mappings: MappingWorksheetRow[];
  paymentMethods: PaymentMethodOption[];
}) {
  const initialRows = useMemo(() => mappings, [mappings]);
  const initialSignatures = useMemo(() => initialRows.map(rowSignature), [initialRows]);
  const [rows, setRows] = useState(initialRows);
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [memberLookupRows, setMemberLookupRows] = useState<Set<number>>(() => new Set());
  const [memberLookupStatuses, setMemberLookupStatuses] = useState<Record<number, ProviderMemberLookupStatus>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [locationFilters, setLocationFilters] = useState<string[]>([]);
  const [paymentMethodFilters, setPaymentMethodFilters] = useState<string[]>([]);
  const [mappingStatusFilters, setMappingStatusFilters] = useState<string[]>([]);
  const [pageSize, setPageSize] = useState("20");
  const [currentPage, setCurrentPage] = useState(1);

  const handleLookupChange = useCallback((index: number, status: ProviderMemberLookupStatus) => {
    setMemberLookupStatuses((current) => ({ ...current, [index]: status }));
  }, []);

  function dismissSuccessMessage() {
    document.getElementById("provider-mapping-success")?.remove();
  }

  function updateRow(index: number, field: keyof MappingWorksheetRow, value: string) {
    dismissSuccessMessage();
    setRowErrors((current) => {
      if (!current[index]) return current;
      const next = { ...current };
      delete next[index];
      return next;
    });
    setRows((current) => current.map((row, rowIndex) => {
      if (rowIndex !== index) {
        return row;
      }

      if (field === "stationId") {
        const locationProviderId = locations.find((location) => location.id === value)?.providerId ?? "";
        return {
          ...row,
          stationId: value,
          providerId: locationProviderId || row.providerId
        };
      }

      if (field === "paymentMethodId") {
        return { ...row, paymentMethodId: value, paymentValues: {} };
      }

      return { ...row, [field]: value };
    }));
    setMemberLookupRows((current) => new Set(current).add(index));
  }

  function updatePaymentValue(index: number, componentCode: string, value: string) {
    dismissSuccessMessage();
    setRowErrors((current) => {
      if (!current[index]) return current;
      const next = { ...current };
      delete next[index];
      return next;
    });
    setRows((current) => current.map((row, rowIndex) => rowIndex === index ? {
      ...row,
      paymentValues: {
        ...row.paymentValues,
        [componentCode]: value
      }
    } : row));
    setMemberLookupRows((current) => new Set(current).add(index));
  }

  function validateRow(row: MappingWorksheetRow, index: number) {
    const method = paymentMethodById.get(row.paymentMethodId);

    if (!row.providerMemberId.trim()) return `Row ${index + 1}: Provider Member ID is required.`;
    const lookupStatus = memberLookupStatuses[index];
    if (!lookupStatus || lookupStatus.providerMemberId !== row.providerMemberId.trim() || lookupStatus.loading) {
      return `Row ${index + 1}: Wait for the Provider Member ID lookup to finish.`;
    }
    if (!lookupStatus.name) return `Row ${index + 1}: No uploaded holder was found for this Provider Member ID.`;
    if (!lookupStatus.matches) return `Row ${index + 1}: Uploaded holder name does not match the DropX name.`;
    if (!row.providerId) return `Row ${index + 1}: Provider is missing from the selected location.`;
    if (!row.paymentMethodId) return `Row ${index + 1}: Payment method is required.`;
    if (!method) return `Row ${index + 1}: Selected payment method was not found.`;
    if (!row.effectiveFrom) return `Row ${index + 1}: Effective from is required.`;
    if (row.effectiveTo && row.effectiveTo < row.effectiveFrom) return `Row ${index + 1}: Effective to cannot be before effective from.`;

    for (const component of method.components) {
      const rawValue = row.paymentValues[component.code]?.trim() ?? "";
      const value = Number(rawValue);
      if (!rawValue) return `Row ${index + 1}: ${component.label} is required.`;
      if (!Number.isFinite(value) || value < 0) return `Row ${index + 1}: ${component.label} must be a valid amount.`;
    }

    return null;
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const rowIndexValue = submitter?.name === "save_row" ? submitter.value : null;
    const indexes = rowIndexValue !== null
      ? [Number(rowIndexValue)]
      : rows.map((_, index) => index).filter((index) => dirtyRows[index]);
    const nextErrors: Record<number, string> = {};

    indexes.forEach((index) => {
      const message = validateRow(rows[index], index);
      if (message) nextErrors[index] = message;
    });

    setRowErrors(nextErrors);

    if (Object.keys(nextErrors).length) {
      event.preventDefault();
    }
  }

  const dirtyRows = rows.map((row, index) => rowSignature(row) !== (initialSignatures[index] ?? ""));
  const hasDirtyRows = dirtyRows.some(Boolean);
  const lookupValidRows = rows.map((row, index) => {
    const status = memberLookupStatuses[index];
    return Boolean(status && !status.loading && status.name && status.matches && status.providerMemberId === row.providerMemberId.trim());
  });
  const allDirtyLookupsValid = dirtyRows.every((dirty, index) => !dirty || lookupValidRows[index]);
  const saveAllDisabledText = !canEdit ? "No edit access" : !hasDirtyRows ? "No edits" : "Verify holder names";
  const locationLabelById = useMemo(() => new Map(locations.map((location) => [location.id, location.label])), [locations]);
  const paymentMethodById = useMemo(() => new Map(paymentMethods.map((method) => [method.id, method])), [paymentMethods]);
  const paymentMethodOptions = useMemo(() => paymentMethods.map((method) => ({
    value: method.id,
    label: method.name,
    helper: method.code
  })), [paymentMethods]);
  const locationFilterOptions = useMemo(() => locations.map((location) => ({
    value: location.id,
    label: location.label
  })), [locations]);
  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase();
  const visibleRows = rows.map((row, index) => {
    const searchMatches = !normalizedSearchQuery || [
      row.dropxId,
      row.dropxName,
      row.providerMemberId,
      locationLabelById.get(row.stationId) ?? ""
    ].some((value) => value.toLocaleLowerCase().includes(normalizedSearchQuery));
    const locationMatches = !locationFilters.length || locationFilters.includes(row.stationId);
    const paymentMethodMatches = !paymentMethodFilters.length || paymentMethodFilters.includes(row.paymentMethodId);
    const isMapped = Boolean(row.mappingId || (row.providerMemberId && row.paymentMethodId));
    const statusMatches = !mappingStatusFilters.length
      || (mappingStatusFilters.includes("mapped") && isMapped)
      || (mappingStatusFilters.includes("unmapped") && !isMapped)
      || (mappingStatusFilters.includes("unsaved") && dirtyRows[index]);
    return searchMatches && locationMatches && paymentMethodMatches && statusMatches;
  });
  const visibleRowCount = visibleRows.filter(Boolean).length;
  const hasFilters = Boolean(searchQuery || locationFilters.length || paymentMethodFilters.length || mappingStatusFilters.length);
  const filteredIndexes = visibleRows.flatMap((visible, index) => visible ? [index] : []);
  const numericPageSize = pageSize === "all" ? Math.max(filteredIndexes.length, 1) : Number(pageSize);
  const totalPages = Math.max(1, Math.ceil(filteredIndexes.length / numericPageSize));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const pageStart = (safeCurrentPage - 1) * numericPageSize;
  const paginatedIndexes = new Set(filteredIndexes.slice(pageStart, pageStart + numericPageSize));
  const pageFrom = visibleRowCount ? pageStart + 1 : 0;
  const pageTo = Math.min(pageStart + numericPageSize, visibleRowCount);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, locationFilters, paymentMethodFilters, mappingStatusFilters, pageSize]);

  if (!rows.length) {
    return (
      <section className="panel">
        <div className="empty-state">
          <strong>No DropX IDs available for mapping.</strong>
          <p className="subtle">Add field executives or import mapping rows first, then maintain provider IDs and payment setup here.</p>
        </div>
      </section>
    );
  }

  return (
    <>
    <section className="panel mapping-id-upload-panel">
      <div>
        <h2>Bulk ID mapping</h2>
        <p className="subtle">Upload only DropX ID and Provider Member ID now. Payment method, rates and effective dates can be allocated later.</p>
      </div>
      <BulkIdUpload canEdit={canEdit} />
      <small className="subtle">Accepted headers: DROPX_ID and PROVIDER_MEMBER_ID. Empty or incomplete rows are skipped.</small>
    </section>
    <form action={saveProviderMappingWorksheet} autoComplete="off" className="worksheet-form" noValidate onSubmit={handleSubmit}>
      <input type="hidden" name="row_count" value={rows.length} />
      <input
        type="hidden"
        name="dirty_row_indexes"
        value={JSON.stringify(dirtyRows.flatMap((dirty, index) => dirty ? [index] : []))}
      />
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>ID & pay mapping worksheet</h2>
            <p className="subtle">DropX ID, name, and location are read-only. Select a payment method to show only its configured fields.</p>
          </div>
          <SubmitButton disabled={!canEdit || !hasDirtyRows || !allDirtyLookupsValid} disabledText={saveAllDisabledText} className="button mapping-save-all">
            Save all
          </SubmitButton>
        </div>

        <div className="mapping-filters">
          <label className="mapping-filter-search">Search
            <input
              autoComplete="off"
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="DropX ID, name or provider member ID"
              type="search"
              value={searchQuery}
            />
          </label>
          <MappingMultiFilter allLabel="All allocated locations" label="Location" options={locationFilterOptions} selected={locationFilters} setSelected={setLocationFilters} />
          <MappingMultiFilter allLabel="All payment methods" label="Payment method" options={paymentMethodOptions.map(({ value, label }) => ({ value, label }))} selected={paymentMethodFilters} setSelected={setPaymentMethodFilters} />
          <MappingMultiFilter allLabel="All statuses" label="Status" options={[
            { value: "mapped", label: "Mapped" },
            { value: "unmapped", label: "Unmapped" },
            { value: "unsaved", label: "Unsaved" }
          ]} selected={mappingStatusFilters} setSelected={setMappingStatusFilters} />
          <label className="mapping-page-size">Rows
            <select onChange={(event) => setPageSize(event.target.value)} value={pageSize}>
              <option value="20">20</option>
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="500">500</option>
              <option value="1000">1000</option>
              <option value="all">All</option>
            </select>
          </label>
          <div className="mapping-filter-summary">
            <span>{visibleRowCount} of {rows.length} records</span>
            {hasFilters ? <button className="button secondary compact" onClick={() => {
              setSearchQuery("");
              setLocationFilters([]);
              setPaymentMethodFilters([]);
              setMappingStatusFilters([]);
            }} type="button">Clear</button> : null}
          </div>
        </div>

        <div className="mapping-rows">
          {rows.map((row, index) => (
            <div className={`mapping-row-card ${dirtyRows[index] ? "unsaved-row" : ""}`} hidden={!paginatedIndexes.has(index)} key={`${row.id || row.dropxId}-${index}`}>
              <input type="hidden" name={`rows[${index}][id]`} value={row.id} />
              <input type="hidden" name={`rows[${index}][source_type]`} value={row.sourceType} />
              <input type="hidden" name={`rows[${index}][mapping_id]`} value={row.mappingId} />
              <input type="hidden" name={`rows[${index}][dropx_id]`} value={row.dropxId} />
              <input type="hidden" name={`rows[${index}][dropx_name]`} value={row.dropxName} />
              <input type="hidden" name={`rows[${index}][provider_id]`} value={row.providerId} />
              <input type="hidden" name={`rows[${index}][station_id]`} value={row.stationId} />
              <input type="hidden" name={`rows[${index}][payment_values_json]`} value={JSON.stringify(row.paymentValues)} />

              {dirtyRows[index] ? <span className="unsaved-badge mapping-unsaved-badge">Unsaved</span> : null}

              <div className="mapping-identity">
                <span className="mapping-dropx-id mono">{row.dropxId}</span>
                <strong>{row.dropxName || "-"}</strong>
                <span>{locationLabelById.get(row.stationId) ?? "No location"}</span>
                <label>Provider Member ID
                  <input
                    className="worksheet-input mono"
                    disabled={!canEdit}
                    name={`rows[${index}][provider_member_id]`}
                    onChange={(event) => updateRow(index, "providerMemberId", event.target.value)}
                    onFocus={() => setMemberLookupRows((current) => new Set(current).add(index))}
                    value={row.providerMemberId}
                  />
                  <ProviderMemberName
                    dropxName={row.dropxName}
                    enabled={memberLookupRows.has(index)}
                    index={index}
                    onLookupChange={handleLookupChange}
                    providerMemberId={row.providerMemberId}
                  />
                </label>
              </div>

              <div className="mapping-edit-grid">
                <div className="mapping-field mapping-payment-method-select">
                  <span className="mapping-field-label">Payment method</span>
                  <SearchableSelect
                    disabled={!canEdit}
                    name={`rows[${index}][payment_method_id]`}
                    onValueChange={(value) => updateRow(index, "paymentMethodId", value)}
                    options={paymentMethodOptions}
                    placeholder="Search payment method"
                    required
                    value={row.paymentMethodId}
                  />
                </div>

                {(paymentMethodById.get(row.paymentMethodId)?.components ?? []).map((component) => (
                  <label key={component.code}>{component.label}
                    <input
                      className="worksheet-input"
                      disabled={!canEdit}
                      min="0"
                      name={`rows[${index}][payment_values][${component.code}]`}
                      onChange={(event) => updatePaymentValue(index, component.code, event.target.value)}
                      placeholder="0.00"
                      step="0.01"
                      type="number"
                      value={row.paymentValues[component.code] ?? ""}
                    />
                  </label>
                ))}
                <div className="mapping-period-row">
                  <label>Effective from
                    <input
                      className="worksheet-input"
                      disabled={!canEdit}
                      name={`rows[${index}][effective_from]`}
                      onChange={(event) => updateRow(index, "effectiveFrom", event.target.value)}
                      type="date"
                      value={row.effectiveFrom}
                    />
                  </label>

                  <label>Effective to
                    <input
                      className="worksheet-input"
                      disabled={!canEdit}
                      name={`rows[${index}][effective_to]`}
                      onChange={(event) => updateRow(index, "effectiveTo", event.target.value)}
                      type="date"
                      value={row.effectiveTo}
                    />
                  </label>

                </div>
                {rowErrors[index] ? <div className="mapping-row-error">{rowErrors[index]}</div> : null}
              </div>
              <div className="mapping-row-actions">
                <RowSaveButton canEdit={canEdit} dirty={dirtyRows[index]} index={index} lookupValid={lookupValidRows[index]} />
              </div>
            </div>
          ))}
        </div>
        <div className="mapping-pagination">
          <span>Showing {pageFrom}–{pageTo} of {visibleRowCount}</span>
          <div className="mapping-pagination-actions">
            <button className="button secondary compact" disabled={safeCurrentPage <= 1} onClick={() => setCurrentPage((page) => Math.max(1, page - 1))} type="button">Previous</button>
            <span>Page {safeCurrentPage} of {totalPages}</span>
            <button className="button secondary compact" disabled={safeCurrentPage >= totalPages} onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))} type="button">Next</button>
          </div>
        </div>
        <div className="mapping-bulk-actions">
          <span>{hasDirtyRows ? `${dirtyRows.filter(Boolean).length} unsaved row${dirtyRows.filter(Boolean).length === 1 ? "" : "s"}` : "All changes saved"}</span>
          <SubmitButton disabled={!canEdit || !hasDirtyRows || !allDirtyLookupsValid} disabledText={saveAllDisabledText} className="button mapping-save-all">
            Save all
          </SubmitButton>
        </div>
      </section>
    </form>
    </>
  );
}
