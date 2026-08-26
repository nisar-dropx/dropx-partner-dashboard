"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SubmitButton } from "@/components/submit-button";

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
  const initialIds = useMemo(() => new Set(
    (initialMethod?.components ?? []).map((component) => component.payment_field_id).filter(Boolean) as string[]
  ), [initialMethod]);
  const [selectedIds, setSelectedIds] = useState(initialIds);
  const [search, setSearch] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const selectedFields = availableFields.filter((field) => selectedIds.has(field.id));
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

  function toggleField(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
            <div><strong>Payment fields</strong><p className="subtle">Select reusable fields for this payment method.</p></div>
            <span className="selection-count">{selectedIds.size} selected</span>
          </div>
          {selectedFields.map((field) => <input key={field.id} name="field_ids" type="hidden" value={field.id} />)}
          {availableFields.length ? (
            <div className="multi-select payment-field-multi-select" ref={pickerRef}>
              <button
                aria-expanded={pickerOpen}
                className={`multi-select-trigger payment-field-multi-trigger ${pickerOpen ? "open" : ""}`}
                onClick={() => setPickerOpen((current) => !current)}
                type="button"
              >
                {selectedFields.length ? (
                  <span className="payment-field-selected-tags">
                    {selectedFields.map((field) => (
                      <span className="payment-field-selected-tag" key={field.id}>
                        <span>{field.label}</span>
                        <span
                          aria-label={`Remove ${field.label}`}
                          className="payment-field-selected-remove"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            toggleField(field.id);
                          }}
                          role="button"
                          tabIndex={0}
                        >×</span>
                      </span>
                    ))}
                  </span>
                ) : <span className="payment-field-placeholder">Select payment fields</span>}
                <span aria-hidden="true" className="multi-select-chevron">⌄</span>
              </button>
              {pickerOpen ? (
                <div className="multi-select-menu payment-field-multi-menu">
                  <div className="multi-select-search">
                    <input autoFocus aria-label="Search payment fields" className="field multi-select-search-field" onChange={(event) => setSearch(event.target.value)} placeholder="Search field ID or label" type="search" value={search} />
                  </div>
                  <div className="multi-select-options payment-field-multi-options">
                    {visibleFields.map((field) => (
                      <label className={`multi-select-option payment-field-multi-option ${selectedIds.has(field.id) ? "selected" : ""}`} key={field.id}>
                        <input checked={selectedIds.has(field.id)} onChange={() => toggleField(field.id)} type="checkbox" />
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
          ) : <p className="empty-cell">Create a reusable payment field before adding a payment method.</p>}
        </div>
      </div>
      <div className="form-actions">
        <SubmitButton confirmationBlocked={!selectedIds.size} confirmMessage="Select at least one payment field.">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}
