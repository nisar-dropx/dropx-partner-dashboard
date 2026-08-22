"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import { saveProviderMappingWorksheet } from "@/app/provider-mapping/actions";
import { SearchableSelect } from "@/components/searchable-select";
import { SubmitButton } from "@/components/submit-button";

export type LocationOption = {
  id: string;
  label: string;
  providerId?: string;
};

export type MappingWorksheetRow = {
  id: string;
  sourceType: "employee" | "contractor" | "field_executive";
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

type ProviderMemberLookupResult = {
  name: string | null;
  workDate: string | null;
};

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
    <form action={saveProviderMappingWorksheet} className="worksheet-form" onSubmit={handleSubmit}>
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
          <SubmitButton disabled={!canEdit || !hasDirtyRows || !allDirtyLookupsValid} disabledText={saveAllDisabledText}>
            Save all
          </SubmitButton>
        </div>

        <div className="mapping-rows">
          {rows.map((row, index) => (
            <div className={`mapping-row-card ${dirtyRows[index] ? "unsaved-row" : ""}`} key={`${row.id || row.dropxId}-${index}`}>
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

                  <RowSaveButton canEdit={canEdit} dirty={dirtyRows[index]} index={index} lookupValid={lookupValidRows[index]} />
                </div>
                {rowErrors[index] ? <div className="mapping-row-error">{rowErrors[index]}</div> : null}
              </div>
            </div>
          ))}
        </div>
      </section>
    </form>
  );
}
