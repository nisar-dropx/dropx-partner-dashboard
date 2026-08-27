"use client";

import { useState } from "react";
import { SubmitButton } from "@/components/submit-button";
import {
  calculationNeedsSource,
  PAYMENT_CALCULATION_SOURCES,
  PAYMENT_CALCULATION_TYPES,
  type PaymentCalculationSource,
  type PaymentCalculationType
} from "@/lib/payment-calculation";

type PaymentField = {
  id: string;
  code: string;
  field_type: "amount" | "production";
  label: string;
  pay_schedule: "per_hour" | "per_day" | "per_month" | null;
  calculation_type: PaymentCalculationType;
  calculation_source: PaymentCalculationSource | null;
  usage_count?: number;
};

export function PaymentFieldForm({ action, initialField, submitLabel }: { action: (formData: FormData) => Promise<void>; initialField?: PaymentField; submitLabel: string }) {
  const [type, setType] = useState<"amount" | "production">(initialField?.field_type ?? "production");
  const [calculationType, setCalculationType] = useState<PaymentCalculationType>(initialField?.calculation_type ?? "manual_input");
  const needsSource = calculationNeedsSource(calculationType);
  const calculationHelp = needsSource
    ? "Choose which uploaded count or eligibility result should drive this field."
    : calculationType === "manual_input"
      ? "The configured value in ID mapping will be used directly."
      : "This calculation does not need a shipment source.";

  return (
    <form action={action} className="payment-field-form">
      {initialField ? <input name="field_id" type="hidden" value={initialField.id} /> : null}
      <div className="payment-field-form-section payment-field-identity">
        <span className="payment-field-section-title">Field details</span>
        <label>Field ID<input className="field mono" defaultValue={initialField?.code} name="field_code" readOnly={Boolean(initialField?.usage_count)} required title={initialField?.usage_count ? "Field ID is locked because this field is already used." : undefined} /></label>
        <label>Display name<input className="field" defaultValue={initialField?.label} name="field_label" required /></label>
        <label>Value type<select className="select" name="field_type" onChange={(event) => setType(event.target.value as "amount" | "production")} value={type}><option value="production">Production count / rate</option><option value="amount">Amount</option></select></label>
        {type === "amount" ? <label>Payment frequency<select className="select" defaultValue={initialField?.pay_schedule ?? "per_month"} name="pay_schedule" required><option value="per_hour">Per hour</option><option value="per_day">Per day</option><option value="per_month">Per month</option></select></label> : null}
      </div>

      <div className="payment-field-form-section payment-field-calculation">
        <span className="payment-field-section-title">How payment is calculated</span>
        <label>Calculation rule<select className="select" name="calculation_type" onChange={(event) => setCalculationType(event.target.value as PaymentCalculationType)} value={calculationType}>{PAYMENT_CALCULATION_TYPES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        {needsSource ? <label>Data source<select className="select" defaultValue={initialField?.calculation_source ?? ""} name="calculation_source" required><option value="">Select shipment or eligibility source</option>{PAYMENT_CALCULATION_SOURCES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label> : <input name="calculation_source" type="hidden" value="" />}
        <p className="payment-field-calculation-help">{calculationHelp}</p>
      </div>

      <div className="payment-field-form-actions"><SubmitButton className="button compact">{submitLabel}</SubmitButton></div>
    </form>
  );
}
