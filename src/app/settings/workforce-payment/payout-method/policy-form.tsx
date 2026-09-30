"use client";

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useFormStatus } from "react-dom";
import { SubmitButton } from "@/components/submit-button";
import {
  workforcePaymentMethodFields,
  workforcePaymentPolicyForDate,
  workforcePaymentMonthIsFinalized,
  type WorkforcePaymentFinalizedPeriod,
  type WorkforcePaymentMethod,
  type WorkforcePaymentPolicy
} from "@/lib/workforce-payment-policy";
import { saveWorkforcePaymentSettings } from "./actions";
import styles from "./policy-form.module.css";

const methodOptions: Array<{ value: WorkforcePaymentMethod; label: string }> = [
  { value: "calendar_days", label: "Calendar-day attendance" },
  { value: "fixed_paid_offs", label: "Fixed paid offs" },
  { value: "earned_paid_offs", label: "Earned paid offs" }
];

type EditablePolicy = Pick<
  WorkforcePaymentPolicy,
  "calculation_method" | "paid_off_days" | "work_units_per_paid_off" | "cap_at_monthly_amount" | "effective_from"
>;

function FormPendingState({ setPending }: { setPending: Dispatch<SetStateAction<boolean>> }) {
  const { pending } = useFormStatus();

  useEffect(() => {
    setPending(pending);
  }, [pending, setPending]);

  return null;
}

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
  const formRef = useRef<HTMLFormElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const firstFieldRef = useRef<HTMLSelectElement>(null);
  const effectiveMonthRef = useRef<HTMLInputElement>(null);
  const returnFocusToEditRef = useRef(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [effectiveMonth, setEffectiveMonth] = useState(currentMonth);
  const [method, setMethod] = useState<WorkforcePaymentMethod>(initialPolicy.calculation_method);
  const [paidOffDays, setPaidOffDays] = useState(String(initialPolicy.paid_off_days));
  const [workUnitsPerPaidOff, setWorkUnitsPerPaidOff] = useState(String(initialPolicy.work_units_per_paid_off));
  const [capAtMonthlyAmount, setCapAtMonthlyAmount] = useState(initialPolicy.cap_at_monthly_amount);
  const effectiveFrom = `${effectiveMonth}-01`;
  const fields = workforcePaymentMethodFields(method);
  const locked = workforcePaymentMonthIsFinalized(effectiveFrom, finalizedPeriods);
  const formDisabled = !canEdit || !isEditing || isSubmitting || locked;

  useEffect(() => {
    if (isEditing) {
      (locked ? effectiveMonthRef.current : firstFieldRef.current)?.focus();
      return;
    }
    if (returnFocusToEditRef.current) {
      returnFocusToEditRef.current = false;
      editButtonRef.current?.focus();
    }
  }, [isEditing, locked]);

  function cancelEditing() {
    setEffectiveMonth(currentMonth);
    setMethod(initialPolicy.calculation_method);
    setPaidOffDays(String(initialPolicy.paid_off_days));
    setWorkUnitsPerPaidOff(String(initialPolicy.work_units_per_paid_off));
    setCapAtMonthlyAmount(initialPolicy.cap_at_monthly_amount);
    formRef.current?.reset();
    returnFocusToEditRef.current = true;
    setIsEditing(false);
  }

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
    <form action={saveWorkforcePaymentSettings} className={`${styles.form} form-grid two`} ref={formRef}>
      <FormPendingState setPending={setIsSubmitting} />
      <div className={`${styles.editControls} span-2`}>
        {canEdit ? (
          isEditing ? (
            <button className="button secondary" disabled={isSubmitting} onClick={cancelEditing} type="button">Cancel editing</button>
          ) : (
            <button className="button" onClick={() => setIsEditing(true)} ref={editButtonRef} type="button">Edit</button>
          )
        ) : <span className="subtle" role="status">View only</span>}
      </div>
      <label className="span-2">Calculation method
        <select
          className="select"
          disabled={formDisabled}
          name="calculation_method"
          onChange={(event) => setMethod(event.target.value as WorkforcePaymentMethod)}
          ref={firstFieldRef}
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
          disabled={!canEdit || !isEditing || isSubmitting}
          name="effective_from"
          onChange={(event) => selectMonth(event.target.value)}
          ref={effectiveMonthRef}
          required
          type="month"
          value={effectiveMonth}
        />
        <span className="subtle">Applies from the selected month until another policy takes effect.</span>
        {locked ? <span className="subtle" role="status"><strong>Locked:</strong> payroll for this month is finalized.</span> : null}
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
      {isEditing ? (
        <div className="form-actions span-2 align-right">
          <SubmitButton disabled={formDisabled} disabledText={!canEdit ? "View only" : "Month locked"}>
            Save workforce payment policy
          </SubmitButton>
        </div>
      ) : null}
    </form>
  );
}
