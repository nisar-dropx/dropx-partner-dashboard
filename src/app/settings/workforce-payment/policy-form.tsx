"use client";

import { useState } from "react";
import { SubmitButton } from "@/components/submit-button";
import {
  workforcePaymentMethodFields,
  workforcePaymentPolicyForDate,
  workforcePaymentPolicyIntervalIsFinalized,
  type WorkforcePaymentFinalizedPeriod,
  type WorkforcePaymentMethod,
  type WorkforcePaymentPolicy
} from "@/lib/workforce-payment-policy";
import { saveWorkforcePaymentSettings } from "./actions";

const methodOptions: Array<{ value: WorkforcePaymentMethod; label: string }> = [
  { value: "calendar_days", label: "Calendar-day attendance" },
  { value: "fixed_paid_offs", label: "Fixed paid offs" },
  { value: "earned_paid_offs", label: "Earned paid offs" }
];

type EditablePolicy = Pick<
  WorkforcePaymentPolicy,
  "calculation_method" | "paid_off_days" | "work_units_per_paid_off" | "cap_at_monthly_amount" | "effective_from"
>;

export function WorkforcePaymentPolicyForm({
  canEdit,
  currentMonth,
  finalizedPeriods,
  policies
}: {
  canEdit: boolean;
  currentMonth: string;
  finalizedPeriods: WorkforcePaymentFinalizedPeriod[];
  policies: EditablePolicy[];
}) {
  const initialPolicy = workforcePaymentPolicyForDate(policies, `${currentMonth}-01`);
  const [effectiveMonth, setEffectiveMonth] = useState(currentMonth);
  const [method, setMethod] = useState<WorkforcePaymentMethod>(initialPolicy.calculation_method);
  const [paidOffDays, setPaidOffDays] = useState(String(initialPolicy.paid_off_days));
  const [workUnitsPerPaidOff, setWorkUnitsPerPaidOff] = useState(String(initialPolicy.work_units_per_paid_off));
  const [capAtMonthlyAmount, setCapAtMonthlyAmount] = useState(initialPolicy.cap_at_monthly_amount);
  const effectiveFrom = `${effectiveMonth}-01`;
  const fields = workforcePaymentMethodFields(method);
  const locked = workforcePaymentPolicyIntervalIsFinalized(policies, effectiveFrom, finalizedPeriods);
  const formDisabled = !canEdit || locked;

  function selectMonth(month: string) {
    setEffectiveMonth(month);
    if (!/^\d{4}-\d{2}$/.test(month)) return;
    const selected = workforcePaymentPolicyForDate(policies, `${month}-01`);
    setMethod(selected.calculation_method);
    setPaidOffDays(String(selected.paid_off_days));
    setWorkUnitsPerPaidOff(String(selected.work_units_per_paid_off));
    setCapAtMonthlyAmount(selected.cap_at_monthly_amount);
  }

  return (
    <form action={saveWorkforcePaymentSettings} className="form-grid two">
      <label className="span-2">Calculation method
        <select
          className="select"
          disabled={formDisabled}
          name="calculation_method"
          onChange={(event) => setMethod(event.target.value as WorkforcePaymentMethod)}
          required
          value={method}
        >
          {methodOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <label>Paid off days per month
        <input
          className="field"
          disabled={formDisabled || !fields.paidOffDays}
          max={10}
          min={0}
          name="paid_off_days"
          onChange={(event) => setPaidOffDays(event.target.value)}
          required={fields.paidOffDays}
          step={1}
          type="number"
          value={paidOffDays}
        />
        <span className="subtle">Required for fixed and earned paid offs. Default: 4.</span>
      </label>
      <label>Work units per paid off
        <input
          className="field"
          disabled={formDisabled || !fields.workUnitsPerPaidOff}
          max={31}
          min={0.5}
          name="work_units_per_paid_off"
          onChange={(event) => setWorkUnitsPerPaidOff(event.target.value)}
          required={fields.workUnitsPerPaidOff}
          step={0.5}
          type="number"
          value={workUnitsPerPaidOff}
        />
        <span className="subtle">Required only for earned paid offs. Default: 6 attendance units.</span>
      </label>
      <label>Effective month
        <input
          className="field"
          disabled={!canEdit}
          name="effective_from"
          onChange={(event) => selectMonth(event.target.value)}
          required
          type="month"
          value={effectiveMonth}
        />
        <span className="subtle">Applies from the selected month until another policy takes effect.</span>
        {locked ? <span className="subtle" role="status"><strong>Locked:</strong> finalized payroll depends on this policy period.</span> : null}
      </label>
      <label>Change reason
        <input
          className="field"
          disabled={formDisabled}
          maxLength={250}
          minLength={3}
          name="change_reason"
          placeholder="Why is this payment rule being changed?"
          required
        />
        <span className="subtle">Saved with the policy for payroll review and audit.</span>
      </label>
      <label className="checkbox-row">
        <input
          checked={capAtMonthlyAmount}
          disabled={formDisabled}
          name="cap_at_monthly_amount"
          onChange={(event) => setCapAtMonthlyAmount(event.target.checked)}
          type="checkbox"
        />
        <span>Cap calculated base pay at the configured monthly amount</span>
      </label>
      <div className="form-actions span-2 align-right">
        <SubmitButton disabled={formDisabled} disabledText={!canEdit ? "View only" : "Month locked"}>
          Save workforce payment policy
        </SubmitButton>
      </div>
    </form>
  );
}
