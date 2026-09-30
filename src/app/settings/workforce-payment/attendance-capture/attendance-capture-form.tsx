"use client";

import { useState } from "react";
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
  const [effectiveMonth, setEffectiveMonth] = useState(currentMonth);
  const [captureMethod, setCaptureMethod] = useState<WorkforceAttendanceCaptureMethod>(initialSetting.capture_method);
  const [minimumDailyDeliveries, setMinimumDailyDeliveries] = useState(
    initialSetting.minimum_daily_deliveries === null ? "" : String(initialSetting.minimum_daily_deliveries)
  );
  const effectiveFrom = `${effectiveMonth}-01`;
  const usesShipmentData = captureMethod === "shipment_data";
  const locked = workforcePaymentMonthIsFinalized(effectiveFrom, finalizedPeriods);
  const formDisabled = !canEdit || locked;

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
    <form action={saveWorkforceAttendanceCaptureSetting} className={`${styles.form} form-grid two`}>
      <label className="span-2">Capture method
        <select
          className="select"
          disabled={formDisabled}
          name="capture_method"
          onChange={(event) => selectCaptureMethod(event.target.value as WorkforceAttendanceCaptureMethod)}
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
          disabled={!canEdit}
          name="effective_from"
          onChange={(event) => selectMonth(event.target.value)}
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
      <div className="form-actions span-2 align-right">
        <SubmitButton disabled={formDisabled} disabledText={!canEdit ? "View only" : "Month locked"}>
          Save attendance capture policy
        </SubmitButton>
      </div>
    </form>
  );
}
