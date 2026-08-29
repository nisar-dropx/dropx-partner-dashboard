"use client";

import { useState } from "react";
import { SubmitButton } from "@/components/submit-button";
import { WorkforceCategoryMultiSelect, type WorkforceCategoryOption } from "@/components/workforce-category-multi-select";

export type DeductionHead = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  calculation_type: "fixed" | "percentage" | "manual";
  default_value: number;
  percentage_without_pan: number;
  workforce_category_codes: string[];
  applies_to_all: boolean;
  is_system: boolean;
  is_active: boolean;
};

export function DeductionHeadForm({ action, head, compact = false, workforceCategories = [] }: {
  action: (formData: FormData) => Promise<void>;
  head?: DeductionHead;
  compact?: boolean;
  workforceCategories?: WorkforceCategoryOption[];
}) {
  const [calculationType, setCalculationType] = useState<DeductionHead["calculation_type"]>(head?.calculation_type ?? "fixed");
  const isSystemTds = Boolean(head?.is_system && head.code === "TDS");

  return <form action={action} className={`${compact ? "deduction-head-row" : "deduction-head-create"}${isSystemTds ? " system-tds-deduction" : ""}`}>
    {head ? <input type="hidden" name="id" value={head.id} /> : null}
    <label>Code<input className="field" name="code" defaultValue={head?.code} disabled={Boolean(head)} readOnly={isSystemTds} required /></label>
    <label>Name<input className="field" name="name" defaultValue={head?.name} disabled={isSystemTds} readOnly={isSystemTds} required /></label>
    {isSystemTds ? <label>Type<input className="field" disabled readOnly value="TDS percentage" /><input name="calculation_type" type="hidden" value="percentage" /></label> : <label>Type<select className="field" name="calculation_type" onChange={(event) => setCalculationType(event.target.value as DeductionHead["calculation_type"])} value={calculationType}>
      <option value="fixed">Fixed amount</option><option value="percentage">Percentage</option><option value="manual">Manual entry</option>
    </select></label>}
    {calculationType === "percentage" ? <>
      <label>Calculation base<select className="field" name="calculation_base" defaultValue="gross_earnings" required>
        <option value="gross_earnings">Gross Earnings</option>
      </select></label>
      <label>{isSystemTds ? "With PAN percentage" : "Percentage"}<input className="field" name="default_value" type="number" min="0" max="100" step="0.01" defaultValue={head?.default_value ?? 0} required /></label>
      {isSystemTds ? <label>Without PAN percentage<input className="field" name="percentage_without_pan" type="number" min="0" max="100" step="0.01" defaultValue={head?.percentage_without_pan ?? 0} required /></label> : null}
    </> : <label>{calculationType === "fixed" ? "Amount" : "Default value"}<input className="field" name="default_value" type="number" min="0" step="0.01" defaultValue={head?.default_value ?? 0} /></label>}
    {isSystemTds ? <label className="deduction-category-field">Applicable workforce categories<WorkforceCategoryMultiSelect defaultValue={head?.workforce_category_codes ?? []} options={workforceCategories} /><input name="applies_to_all" type="hidden" value="yes" /></label> : <label className={`deduction-apply-all${calculationType === "manual" ? " disabled" : ""}`}>
      <input defaultChecked={head?.applies_to_all ?? false} disabled={calculationType === "manual"} name="applies_to_all" type="checkbox" value="yes" />
      <span><strong>Apply to all workers</strong><small>{calculationType === "manual" ? "Manual deductions require individual entry." : "Deduct automatically without individual assignment."}</small></span>
    </label>}
    <label className="deduction-description">Description<input className="field" name="description" defaultValue={head?.description ?? ""} /></label>
    {head ? <label>Status<select className="field" name="is_active" defaultValue={String(head.is_active)}><option value="true">Active</option><option value="false">Inactive</option></select></label> : null}
    <SubmitButton className="button primary" pendingText="Saving">{head ? "Save" : "Add deduction head"}</SubmitButton>
  </form>;
}
