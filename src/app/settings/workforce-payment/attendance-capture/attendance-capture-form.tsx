"use client";

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useFormStatus } from "react-dom";
import { SubmitButton } from "@/components/submit-button";
import {
  workforceAttendanceCaptureSettingForDate,
  type WorkforceAttendanceCaptureMethod,
  type WorkforceAttendanceCaptureSetting
} from "@/lib/workforce-attendance-capture";
import {
  workforcePaymentMonthIsFinalized,
  type WorkforcePaymentFinalizedPeriod
} from "@/lib/workforce-payment-policy";
import { saveWorkforceAttendanceCaptureSetting } from "./actions";
import styles from "./attendance-capture-form.module.css";

const captureMethodOptions: Array<{ value: WorkforceAttendanceCaptureMethod; label: string }> = [
  { value: "biometric", label: "Biometric attendance" },
  { value: "shipment_data", label: "Shipment delivery data" }
];

function FormPendingState({ setPending }: { setPending: Dispatch<SetStateAction<boolean>> }) {
  const { pending } = useFormStatus();

  useEffect(() => {
    setPending(pending);
  }, [pending, setPending]);

  return null;
}

export function WorkforceAttendanceCaptureForm({
  canEdit,
  currentMonth,
  finalizedPeriods,
  settings
}: {
  canEdit: boolean;
  currentMonth: string;
  finalizedPeriods: WorkforcePaymentFinalizedPeriod[];
  settings: WorkforceAttendanceCaptureSetting[];
}) {
  const initialSetting = workforceAttendanceCaptureSettingForDate(settings, `${currentMonth}-01`);
  const formRef = useRef<HTMLFormElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const firstFieldRef = useRef<HTMLSelectElement>(null);
  const effectiveMonthRef = useRef<HTMLInputElement>(null);
  const returnFocusToEditRef = useRef(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [effectiveMonth, setEffectiveMonth] = useState(currentMonth);
  const [captureMethod, setCaptureMethod] = useState<WorkforceAttendanceCaptureMethod>(initialSetting.capture_method);
  const [minimumDailyDeliveries, setMinimumDailyDeliveries] = useState(
    initialSetting.minimum_daily_deliveries === null ? "" : String(initialSetting.minimum_daily_deliveries)
  );
  const effectiveFrom = `${effectiveMonth}-01`;
  const usesShipmentData = captureMethod === "shipment_data";
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
    setCaptureMethod(initialSetting.capture_method);
    setMinimumDailyDeliveries(
      initialSetting.minimum_daily_deliveries === null ? "" : String(initialSetting.minimum_daily_deliveries)
    );
    formRef.current?.reset();
    returnFocusToEditRef.current = true;
    setIsEditing(false);
  }

  function selectCaptureMethod(method: WorkforceAttendanceCaptureMethod) {
    setCaptureMethod(method);
    if (method === "shipment_data" && !minimumDailyDeliveries) setMinimumDailyDeliveries("1");
  }

  function selectMonth(month: string) {
    setEffectiveMonth(month);
    if (!/^\d{4}-\d{2}$/.test(month)) return;
    const selected = workforceAttendanceCaptureSettingForDate(settings, `${month}-01`);
    setCaptureMethod(selected.capture_method);
    setMinimumDailyDeliveries(selected.minimum_daily_deliveries === null ? "" : String(selected.minimum_daily_deliveries));
  }

  return (
    <form action={saveWorkforceAttendanceCaptureSetting} className={`${styles.form} form-grid two`} ref={formRef}>
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
      <label className="span-2">Capture method
        <select
          className="select"
          disabled={formDisabled}
          name="capture_method"
          onChange={(event) => selectCaptureMethod(event.target.value as WorkforceAttendanceCaptureMethod)}
          ref={firstFieldRef}
          required
          value={captureMethod}
        >
          {captureMethodOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <span className="subtle">Biometric uses recorded attendance punches. Shipment data uses completed deliveries to qualify each workday.</span>
      </label>
      <label>Minimum daily deliveries
        <input
          className={`field ${styles.threshold}`}
          disabled={formDisabled || !usesShipmentData}
          max={100000}
          min={1}
          name="minimum_daily_deliveries"
          onChange={(event) => setMinimumDailyDeliveries(event.target.value)}
          required={usesShipmentData}
          step={1}
          type="number"
          value={minimumDailyDeliveries}
        />
        <span className="subtle">Required only when shipment delivery data is selected.</span>
      </label>
      <label>Effective from
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
        <span className="subtle">Applies from the selected month until another attendance capture policy takes effect.</span>
        {locked ? <span className="subtle" role="status"><strong>Locked:</strong> payroll for this month is finalized.</span> : null}
      </label>
      <label className="span-2">Change reason
        <input
          className="field"
          disabled={formDisabled}
          maxLength={250}
          minLength={3}
          name="change_reason"
          placeholder="Why is the attendance source being changed?"
          required
        />
        <span className="subtle">Saved with the policy for payroll review and audit.</span>
      </label>
      {isEditing ? (
        <div className="form-actions span-2 align-right">
          <SubmitButton disabled={formDisabled} disabledText={!canEdit ? "View only" : "Month locked"}>
            Save attendance capture policy
          </SubmitButton>
        </div>
      ) : null}
    </form>
  );
}
