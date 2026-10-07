import type { DirectPayAttendance } from "./direct-workforce-pay.ts";

export const WORKFORCE_ATTENDANCE_CAPTURE_METHODS = [
  "biometric",
  "shipment_data"
] as const;

export type WorkforceAttendanceCaptureMethod =
  (typeof WORKFORCE_ATTENDANCE_CAPTURE_METHODS)[number];

export type WorkforceAttendanceCaptureSetting = {
  id?: string | number | null;
  capture_method: WorkforceAttendanceCaptureMethod;
  minimum_daily_deliveries: number | null;
  effective_from: string;
  review_below_deliveries?: number | null;
};

export type WorkforceShipmentDeliveryRow = {
  workforce_id?: string | null;
  work_date: string;
  total_delivery?: number | string | null;
};

export const DEFAULT_MINIMUM_DAILY_DELIVERIES = 1;

export const DEFAULT_WORKFORCE_ATTENDANCE_CAPTURE_SETTING: WorkforceAttendanceCaptureSetting = {
  id: null,
  capture_method: "biometric",
  minimum_daily_deliveries: null,
  effective_from: "0001-01-01"
};

function positiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function normalizeWorkforceAttendanceCaptureSetting(
  value?: Partial<WorkforceAttendanceCaptureSetting> | null
): WorkforceAttendanceCaptureSetting {
  const captureMethod = WORKFORCE_ATTENDANCE_CAPTURE_METHODS.includes(
    value?.capture_method as WorkforceAttendanceCaptureMethod
  )
    ? value!.capture_method as WorkforceAttendanceCaptureMethod
    : DEFAULT_WORKFORCE_ATTENDANCE_CAPTURE_SETTING.capture_method;
  const minimumDailyDeliveries = captureMethod === "shipment_data"
    ? positiveInteger(value?.minimum_daily_deliveries) ?? DEFAULT_MINIMUM_DAILY_DELIVERIES
    : null;

  return {
    id: value?.id ?? null,
    capture_method: captureMethod,
    minimum_daily_deliveries: minimumDailyDeliveries,
    ...(positiveInteger(value?.review_below_deliveries) ? { review_below_deliveries: positiveInteger(value?.review_below_deliveries) } : {}),
    effective_from: /^\d{4}-\d{2}-01$/.test(String(value?.effective_from ?? ""))
      ? String(value!.effective_from)
      : DEFAULT_WORKFORCE_ATTENDANCE_CAPTURE_SETTING.effective_from
  };
}

export function workforceAttendanceCaptureSettingForDate(
  history: Array<Partial<WorkforceAttendanceCaptureSetting>> | null | undefined,
  date: string
) {
  const selected = [...(history ?? [])]
    .filter((setting) => String(setting.effective_from ?? "") <= date)
    .sort((left, right) =>
      String(right.effective_from ?? "").localeCompare(String(left.effective_from ?? ""))
    )[0];
  return normalizeWorkforceAttendanceCaptureSetting(selected);
}

export function aggregateShipmentDeliveriesByWorkforceDay(
  rows: WorkforceShipmentDeliveryRow[] | null | undefined
) {
  const totals = new Map<string, number>();

  for (const row of rows ?? []) {
    const workforceId = String(row.workforce_id ?? "").trim();
    const workDate = String(row.work_date ?? "").trim();
    const deliveries = Number(row.total_delivery ?? 0);
    if (!workforceId || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) continue;
    if (!Number.isFinite(deliveries) || deliveries < 0) continue;

    const key = `${workforceId}|${workDate}`;
    totals.set(key, (totals.get(key) ?? 0) + deliveries);
  }

  return totals;
}

export function shipmentAttendanceUnit(
  totalDeliveries: unknown,
  setting?: Partial<WorkforceAttendanceCaptureSetting> | null
): 0 | 1 {
  const normalized = normalizeWorkforceAttendanceCaptureSetting(setting);
  const deliveries = Number(totalDeliveries);
  if (
    normalized.capture_method !== "shipment_data"
    || !Number.isFinite(deliveries)
    || deliveries < normalized.minimum_daily_deliveries!
  ) {
    return 0;
  }
  return 1;
}

export function shipmentAttendanceRecord(
  date: string,
  totalDeliveries: unknown,
  setting?: Partial<WorkforceAttendanceCaptureSetting> | null
): DirectPayAttendance {
  // The effective-dated company policy is authoritative. When shipment data
  // is selected, biometric punches cannot silently change eligibility.
  const unit = shipmentAttendanceUnit(totalDeliveries, setting);
  return {
    punch_date: date,
    status: unit === 1 ? "P" : "A",
    work_minutes: 0
  };
}

/** A review signal only; it never changes attendance eligibility or pay. */
export function shipmentAttendanceReview(totalDeliveries: unknown, setting?: Partial<WorkforceAttendanceCaptureSetting> | null) {
  const threshold = positiveInteger(setting?.review_below_deliveries);
  const deliveries = Number(totalDeliveries);
  return threshold !== null && Number.isFinite(deliveries) && deliveries >= 0 && deliveries < threshold
    ? { deliveries, threshold } : null;
}
