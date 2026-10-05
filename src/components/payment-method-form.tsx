"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, GripVertical, X } from "lucide-react";
import { SubmitButton } from "@/components/submit-button";
import {
  movePaymentField,
  movePaymentFieldByOffset,
  normalizePaymentFieldOrder,
  togglePaymentFieldSelection
} from "@/lib/payment-field-order";
import type { ProductionThresholdConfig, ProductionThresholdPeriod } from "@/lib/production-threshold-config";

export type PaymentFieldOption = {
  id: string;
  code: string;
  field_type: "amount" | "production";
  label: string;
  pay_schedule: "per_hour" | "per_day" | "per_month" | null;
};

type InitialPaymentMethod = {
  id: string;
  code: string;
  name: string;
  components: Array<{ payment_field_id: string | null }>;
  productionThresholdConfig: ProductionThresholdConfig | null;
};

function scheduleLabel(value: PaymentFieldOption["pay_schedule"]) {
  if (value === "per_hour") return "Per Hour";
  if (value === "per_day") return "Per Day";
  if (value === "per_month") return "Per Month";
  return null;
}

export function PaymentMethodForm({ action, availableFields, initialMethod, submitLabel = "Create payment method" }: {
  action: (formData: FormData) => Promise<void>;
  availableFields: PaymentFieldOption[];
  initialMethod?: InitialPaymentMethod;
  submitLabel?: string;
}) {
  const fieldById = useMemo(() => new Map(availableFields.map((field) => [field.id, field])), [availableFields]);
  const [selectedIds, setSelectedIds] = useState(() => normalizePaymentFieldOrder(
    (initialMethod?.components ?? []).map((component) => component.payment_field_id).filter(Boolean) as string[],
    availableFields.map((field) => field.id)
  ));
  const [search, setSearch] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; placement: "before" | "after" } | null>(null);
  const [thresholdEnabled, setThresholdEnabled] = useState(Boolean(initialMethod?.productionThresholdConfig));
  const [thresholdPeriod, setThresholdPeriod] = useState<ProductionThresholdPeriod>(initialMethod?.productionThresholdConfig?.period ?? "month");
  const [thresholdComponentIds, setThresholdComponentIds] = useState<string[]>(() => {
    const configuredCodes = new Set(initialMethod?.productionThresholdConfig?.component_codes ?? []);
    return availableFields
      .filter((field) => field.field_type === "production" && configuredCodes.has(field.code.trim().toUpperCase()))
      .map((field) => field.id);
  });
  const draggedIdRef = useRef<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedFields = selectedIds
    .map((id) => fieldById.get(id))
    .filter((field): field is PaymentFieldOption => Boolean(field));
  const selectedProductionFields = selectedFields.filter((field) => field.field_type === "production");
  const selectedProductionIdSet = useMemo(() => new Set(
    selectedIds.filter((id) => fieldById.get(id)?.field_type === "production")
  ), [fieldById, selectedIds]);
  const visibleFields = availableFields.filter((field) =>
    `${field.code} ${field.label}`.toLowerCase().includes(search.trim().toLowerCase())
  );

  useEffect(() => {
    function closePicker(event: globalThis.MouseEvent) {
      if (!pickerRef.current?.contains(event.target as Node)) setPickerOpen(false);
    }
    document.addEventListener("mousedown", closePicker);
    return () => document.removeEventListener("mousedown", closePicker);
  }, []);

  useEffect(() => {
    setThresholdComponentIds((current) => {
      const next = current.filter((id) => selectedProductionIdSet.has(id));
      return next.length === current.length ? current : next;
    });
    if (!selectedProductionIdSet.size) setThresholdEnabled(false);
  }, [selectedProductionIdSet]);

  function toggleField(id: string) {
    setSelectedIds((current) => togglePaymentFieldSelection(current, id));
  }

  function finishDrag() {
    draggedIdRef.current = null;
    setDraggedId(null);
    setDropTarget(null);
  }

  function toggleThresholdComponent(id: string) {
    setThresholdComponentIds((current) => current.includes(id)
      ? current.filter((componentId) => componentId !== id)
      : [...current, id]);
  }

  return (
    <form action={action} className="payment-method-form">
      {initialMethod ? <input type="hidden" name="id" value={initialMethod.id} /> : null}
      <div className="payment-method-layout">
        <div className="payment-method-fields">
          <label>Method ID<input className="field" defaultValue={initialMethod?.code} name="code" required /></label>
          <label>Method name<input className="field" defaultValue={initialMethod?.name} name="name" required /></label>
        </div>

        <div className="payment-field-picker">
          <div className="payment-component-head">
            <div><strong>Payment fields</strong><p className="subtle">Select fields, then drag them into the order used in ID Mapping and Workforce Payouts.</p></div>
            <span className="selection-count">{selectedIds.length} selected</span>
          </div>
          {selectedFields.map((field) => <input key={field.id} name="field_ids" type="hidden" value={field.id} />)}
          {availableFields.length ? (
            <>
              <div className="multi-select payment-field-multi-select" ref={pickerRef}>
                <button
                  aria-expanded={pickerOpen}
                  className={`multi-select-trigger payment-field-multi-trigger ${pickerOpen ? "open" : ""}`}
                  onClick={() => setPickerOpen((current) => !current)}
                  type="button"
                >
                  <span className={selectedFields.length ? "payment-field-picker-summary" : "payment-field-placeholder"}>
                    {selectedFields.length ? "Add or remove payment fields" : "Select payment fields"}
                  </span>
                  <ChevronDown aria-hidden="true" className="multi-select-chevron" size={16} />
                </button>
                {pickerOpen ? (
                  <div className="multi-select-menu payment-field-multi-menu">
                    <div className="multi-select-search">
                      <input autoFocus aria-label="Search payment fields" className="field multi-select-search-field" onChange={(event) => setSearch(event.target.value)} placeholder="Search field ID or label" type="search" value={search} />
                    </div>
                    <div className="multi-select-options payment-field-multi-options">
                      {visibleFields.map((field) => (
                        <label className={`multi-select-option payment-field-multi-option ${selectedIdSet.has(field.id) ? "selected" : ""}`} key={field.id}>
                          <input checked={selectedIdSet.has(field.id)} onChange={() => toggleField(field.id)} type="checkbox" />
                          <span className="payment-field-option-copy">
                            <strong>{field.label}</strong>
                            <small>{field.code} · {field.field_type === "amount" ? "Amount" : "Production"}{scheduleLabel(field.pay_schedule) ? ` · ${scheduleLabel(field.pay_schedule)}` : ""}</small>
                          </span>
                        </label>
                      ))}
                      {!visibleFields.length ? <p className="searchable-empty">No matching payment fields.</p> : null}
                    </div>
                  </div>
                ) : null}
              </div>
              {selectedFields.length ? (
                <div aria-label="Payment field order" className="payment-field-order-list" role="list">
                  {selectedFields.map((field, index) => {
                    const target = dropTarget?.id === field.id ? dropTarget.placement : null;
                    return (
                      <div
                        aria-label={`${field.label}, position ${index + 1} of ${selectedFields.length}`}
                        className={`payment-field-order-item ${draggedId === field.id ? "dragging" : ""} ${target ? `drop-${target}` : ""}`}
                        draggable
                        key={field.id}
                        onDragEnd={finishDrag}
                        onDragOver={(event) => {
                          const activeId = draggedIdRef.current ?? draggedId;
                          if (!activeId || activeId === field.id) return;
                          event.preventDefault();
                          const bounds = event.currentTarget.getBoundingClientRect();
                          setDropTarget({ id: field.id, placement: event.clientY < bounds.top + bounds.height / 2 ? "before" : "after" });
                        }}
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", field.id);
                          draggedIdRef.current = field.id;
                          setDraggedId(field.id);
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          const activeId = event.dataTransfer.getData("text/plain") || draggedIdRef.current || draggedId;
                          if (activeId && activeId !== field.id) {
                            const bounds = event.currentTarget.getBoundingClientRect();
                            const placement = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
                            setSelectedIds((current) => movePaymentField(current, activeId, field.id, placement));
                          }
                          finishDrag();
                        }}
                        role="listitem"
                      >
                        <span aria-hidden="true" className="payment-field-order-grip" title="Drag to reorder"><GripVertical size={16} /></span>
                        <span className="payment-field-order-copy"><strong>{field.label}</strong><small>{field.code}</small></span>
                        <span className="payment-field-order-actions">
                          <button aria-label={`Move ${field.label} up`} disabled={index === 0} onClick={() => setSelectedIds((current) => movePaymentFieldByOffset(current, field.id, -1))} title="Move up" type="button"><ArrowUp size={14} /></button>
                          <button aria-label={`Move ${field.label} down`} disabled={index === selectedFields.length - 1} onClick={() => setSelectedIds((current) => movePaymentFieldByOffset(current, field.id, 1))} title="Move down" type="button"><ArrowDown size={14} /></button>
                          <button aria-label={`Remove ${field.label}`} className="remove" onClick={() => toggleField(field.id)} title="Remove" type="button"><X size={14} /></button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : null}
              <div className={`payment-threshold-config ${thresholdEnabled ? "enabled" : ""}`}>
                <label className="payment-threshold-toggle">
                  <input
                    checked={thresholdEnabled}
                    disabled={!selectedProductionFields.length}
                    name="production_threshold_enabled"
                    onChange={(event) => {
                      const enabled = event.target.checked;
                      setThresholdEnabled(enabled);
                      if (enabled && !thresholdComponentIds.some((id) => selectedProductionIdSet.has(id))) {
                        setThresholdComponentIds(selectedProductionFields.map((field) => field.id));
                      }
                    }}
                    type="checkbox"
                    value="1"
                  />
                  <span><strong>Combined production minimum</strong><small>Pay only the production above one person-specific minimum.</small></span>
                </label>
                {!selectedProductionFields.length ? <p className="subtle payment-threshold-help">Select at least one production field to enable this rule.</p> : null}
                {thresholdEnabled ? (
                  <div className="payment-threshold-details">
                    <label className="payment-threshold-period">
                      <span>Minimum resets</span>
                      <select className="field" name="production_threshold_period" onChange={(event) => setThresholdPeriod(event.target.value as ProductionThresholdPeriod)} value={thresholdPeriod}>
                        <option value="day">Every day</option>
                        <option value="month">Every calendar month</option>
                      </select>
                    </label>
                    <fieldset className="payment-threshold-components">
                      <legend>Production included in the combined minimum</legend>
                      <div className="payment-threshold-component-list">
                        {selectedProductionFields.map((field) => (
                          <label key={field.id}>
                            <input
                              checked={thresholdComponentIds.includes(field.id)}
                              name="production_threshold_component_codes"
                              onChange={() => toggleThresholdComponent(field.id)}
                              type="checkbox"
                              value={field.code}
                            />
                            <span><strong>{field.label}</strong><small>{field.code}</small></span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    <p className="payment-threshold-note">The minimum unit count is entered separately for each person in ID Mapping. Rates remain separate for every payment field.</p>
                  </div>
                ) : null}
              </div>
            </>
          ) : <p className="empty-cell">Create a reusable payment field before adding a payment method.</p>}
        </div>
      </div>
      <div className="form-actions">
        <SubmitButton
          confirmationBlocked={!selectedIds.length || (thresholdEnabled && !thresholdComponentIds.length)}
          confirmMessage={!selectedIds.length ? "Select at least one payment field." : "Select at least one production field for the combined production minimum."}
        >{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}
