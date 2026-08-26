"use client";

import { useState } from "react";
import { SubmitButton } from "@/components/submit-button";

type PaymentField = { id: string; code: string; field_type: "amount" | "production"; label: string; pay_schedule: "per_hour" | "per_day" | "per_month" | null; usage_count?: number };

export function PaymentFieldForm({ action, initialField, submitLabel }: { action: (formData: FormData) => Promise<void>; initialField?: PaymentField; submitLabel: string }) {
  const [type, setType] = useState<"amount" | "production">(initialField?.field_type ?? "production");
  return (
    <form action={action} className="payment-field-form">
      {initialField ? <input name="field_id" type="hidden" value={initialField.id} /> : null}
      <label>Field ID<input className="field mono" defaultValue={initialField?.code} name="field_code" readOnly={Boolean(initialField?.usage_count)} required title={initialField?.usage_count ? "Field ID is locked because this field is already used." : undefined} /></label>
      <label>Field label<input className="field" defaultValue={initialField?.label} name="field_label" required /></label>
      <label>Type<select className="select" name="field_type" onChange={(event) => setType(event.target.value as "amount" | "production")} value={type}><option value="production">Production</option><option value="amount">Amount</option></select></label>
      {type === "amount" ? <label>Pay schedule<select className="select" defaultValue={initialField?.pay_schedule ?? "per_month"} name="pay_schedule" required><option value="per_hour">Per Hour</option><option value="per_day">Per Day</option><option value="per_month">Per Month</option></select></label> : <span />}
      <SubmitButton className="button compact">{submitLabel}</SubmitButton>
    </form>
  );
}
