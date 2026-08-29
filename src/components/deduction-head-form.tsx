"use client";

import { useState } from "react";
import { SubmitButton } from "@/components/submit-button";

export type DeductionHead = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  calculation_type: "fixed" | "percentage" | "manual";
  default_value: number;
  applies_to_all: boolean;
  is_active: boolean;
};

export function DeductionHeadForm({ action, head, compact = false }: {
  action: (formData: FormData) => Promise<void>;
  head?: DeductionHead;
  compact?: boolean;
}) {
  const [calculationType, setCalculationType] = useState<DeductionHead["calculation_type"]>(head?.calculation_type ?? "fixed");

  return <form action={action} className={compact ? "deduction-head-row" : "deduction-head-create"}>
    {head ? <input type="hidden" name="id" value={head.id} /> : null}
    <label>Code<input className="field" name="code" defaultValue={head?.code} disabled={Boolean(head)} required /></label>
    <label>Name<input className="field" name="name" defaultValue={head?.name} required /></label>
    <label>Type<select className="field" name="calculation_type" onChange={(event) => setCalculationType(event.target.value as DeductionHead["calculation_type"])} value={calculationType}>
      <option value="fixed">Fixed amount</option><option value="percentage">Percentage</option><option value="manual">Manual entry</option>
    </select></label>
    {calculationType === "percentage" ? <>
      <label>Calculation base<input className="field" value="Gross Earnings" disabled readOnly /></label>
      <label>Percentage<input className="field" name="default_value" type="number" min="0" max="100" step="0.01" defaultValue={head?.default_value ?? 0} required /></label>
    </> : <label>{calculationType === "fixed" ? "Amount" : "Default value"}<input className="field" name="default_value" type="number" min="0" step="0.01" defaultValue={head?.default_value ?? 0} /></label>}
    <label className={`deduction-apply-all${calculationType === "manual" ? " disabled" : ""}`}>
      <input defaultChecked={head?.applies_to_all ?? false} disabled={calculationType === "manual"} name="applies_to_all" type="checkbox" value="yes" />
      <span><strong>Apply to all workers</strong><small>{calculationType === "manual" ? "Manual deductions require individual entry." : "Deduct automatically without individual assignment."}</small></span>
    </label>
    <label className="deduction-description">Description<input className="field" name="description" defaultValue={head?.description ?? ""} /></label>
    {head ? <label>Status<select className="field" name="is_active" defaultValue={String(head.is_active)}><option value="true">Active</option><option value="false">Inactive</option></select></label> : null}
    <SubmitButton className="button primary" pendingText="Saving">{head ? "Save" : "Add deduction head"}</SubmitButton>
  </form>;
}
