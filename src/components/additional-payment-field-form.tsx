"use client";

import { useState } from "react";
import { SubmitButton } from "@/components/submit-button";
import type { AdditionalPaymentCalculationType } from "@/lib/workforce-additional-payments";

export type AdditionalPaymentField = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  calculation_type: AdditionalPaymentCalculationType;
  default_rate_value: number | null;
  is_active: boolean;
};

export function AdditionalPaymentFieldForm({ action, field, compact = false }: {
  action: (formData: FormData) => Promise<void>;
  field?: AdditionalPaymentField;
  compact?: boolean;
}) {
  const [calculationType, setCalculationType] = useState<AdditionalPaymentCalculationType>(field?.calculation_type ?? "manual_amount");
  const usesDefaultRate = calculationType !== "manual_amount";

  return <form action={action} className={`additional-payment-field-form ${compact ? "compact" : "create"}`}>
    {field ? <input name="id" type="hidden" value={field.id} /> : null}
    <label>Code<input className="field mono" defaultValue={field?.code} name="code" readOnly={Boolean(field)} required title={field ? "The code is locked after this field is created." : undefined} /></label>
    <label>Name<input className="field" defaultValue={field?.name} name="name" required /></label>
    <label>Calculation<select className="field" name="calculation_type" onChange={(event) => setCalculationType(event.target.value as AdditionalPaymentCalculationType)} value={calculationType}>
      <option value="manual_amount">Custom amount per workforce</option>
      <option value="units_x_rate">Units × rate</option>
    </select></label>
    <label className={!usesDefaultRate ? "additional-payment-rate-disabled" : undefined}>{usesDefaultRate ? "Rate per unit" : "Value source"}<input
      className="field"
      defaultValue={usesDefaultRate ? field?.default_rate_value ?? "" : ""}
      disabled={!usesDefaultRate}
      min="0"
      name="default_rate_value"
      placeholder={usesDefaultRate ? "Required" : "Uploaded per workforce and period"}
      required={usesDefaultRate}
      step="0.0001"
      type={usesDefaultRate ? "number" : "text"}
    /></label>
    <label className="additional-payment-description">Description<input className="field" defaultValue={field?.description ?? ""} name="description" /></label>
    <label>Status<select className="field" defaultValue={String(field?.is_active ?? true)} name="is_active"><option value="true">Active</option><option value="false">Inactive</option></select></label>
    <div className="additional-payment-global-note" role="note"><strong>Available to all workforce</strong><span>This field is independent of payment-method and Provider ID mapping.</span></div>
    <SubmitButton className="button primary" pendingText="Saving">{field ? "Save" : "Add additional field"}</SubmitButton>
  </form>;
}
