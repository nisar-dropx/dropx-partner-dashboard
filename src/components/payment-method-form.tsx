"use client";

import { useMemo, useState } from "react";
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
  const visibleFields = availableFields.filter((field) =>
    `${field.code} ${field.label}`.toLowerCase().includes(search.trim().toLowerCase())
  );

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
          {availableFields.length ? <>
            <input aria-label="Search payment fields" className="field" onChange={(event) => setSearch(event.target.value)} placeholder="Search field ID or label" type="search" value={search} />
            <div className="payment-field-options">
              {visibleFields.map((field) => (
                <label className={`payment-field-option ${selectedIds.has(field.id) ? "selected" : ""}`} key={field.id}>
                  <input checked={selectedIds.has(field.id)} name="field_ids" onChange={() => toggleField(field.id)} type="checkbox" value={field.id} />
                  <span><strong>{field.label}</strong><small>{field.code} · {field.field_type === "amount" ? "Amount" : "Production"}{scheduleLabel(field.pay_schedule) ? ` · ${scheduleLabel(field.pay_schedule)}` : ""}</small></span>
                </label>
              ))}
              {!visibleFields.length ? <p className="empty-cell">No matching payment fields.</p> : null}
            </div>
          </> : <p className="empty-cell">Create a reusable payment field before adding a payment method.</p>}
        </div>
      </div>
      <div className="form-actions">
        <SubmitButton confirmationBlocked={!selectedIds.size} confirmMessage="Select at least one payment field.">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}
