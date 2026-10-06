export type AttendanceInputBasis = "hours" | "days";
export type RequiredAttendanceInputBasis = AttendanceInputBasis | "mixed";

export type AttendancePaymentComponentBasis = {
  calculationSource: unknown;
  paySchedule: unknown;
  componentType?: unknown;
  calculationType?: unknown;
  paymentFieldId?: unknown;
  fieldCode?: unknown;
};

export type EffectiveAttendanceAllocation = {
  sourceId: string;
  workforceId: string;
  locationId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  requiredBasis: RequiredAttendanceInputBasis | null;
  components?: AttendancePaymentComponentBasis[];
};

export type AttendanceRateOverrideBoundary = {
  workforceId: string;
  locationId: string;
  paymentFieldId: string;
  fieldCode: string;
  effectiveFrom: string;
  effectiveTo: string;
};

export type AttendancePaymentSetting = {
  effectiveFrom: string;
  calculationMethod: string;
  paidOffDays: number;
  workUnitsPerPaidOff: number;
  capAtMonthlyAmount: boolean;
};

type AttendanceImportRow = {
  rowNumber: number;
  action: string;
  dropxId: string;
  inputType: string;
  fieldCode: string;
  workforceId: string;
  locationId: string;
  effectiveDate?: string;
  effectiveFrom: string;
  effectiveTo: string;
  attendanceBasis: AttendanceInputBasis | null;
};

export type AttendanceBasisIssue = {
  rowNumber: number;
  dropxId: string;
  message: string;
};

function normalizedToken(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function requiredAttendanceBasisForComponents(
  components: AttendancePaymentComponentBasis[]
): RequiredAttendanceInputBasis | null {
  let hasHourlyAttendance = false;
  let hasDayBasedAttendance = false;
  for (const component of components) {
    if (normalizedToken(component.componentType) === "production"
      || normalizedToken(component.calculationSource) !== "attendance_eligibility") {
      continue;
    }
    const schedule = normalizedToken(component.paySchedule);
    if (schedule === "per_hour") hasHourlyAttendance = true;
    if (schedule === "per_day" || schedule === "per_month") hasDayBasedAttendance = true;
  }
  if (hasHourlyAttendance && hasDayBasedAttendance) return "mixed";
  if (hasHourlyAttendance) return "hours";
  return hasDayBasedAttendance ? "days" : null;
}

function allocationMatchesRow(
  allocation: EffectiveAttendanceAllocation,
  row: AttendanceImportRow
) {
  return allocation.workforceId === row.workforceId
    && (allocation.locationId === null || allocation.locationId === row.locationId);
}

function allocationOverlaps(
  allocation: EffectiveAttendanceAllocation,
  effectiveFrom: string,
  effectiveTo: string
) {
  return allocation.effectiveFrom <= effectiveTo
    && (allocation.effectiveTo === null || allocation.effectiveTo >= effectiveFrom);
}

function allocationCovers(
  allocation: EffectiveAttendanceAllocation,
  effectiveFrom: string,
  effectiveTo: string
) {
  return allocation.effectiveFrom <= effectiveFrom
    && (allocation.effectiveTo === null || allocation.effectiveTo >= effectiveTo);
}

function attendanceFieldCode(basis: AttendanceInputBasis) {
  return basis === "hours" ? "WORK_HOURS" : "WORK_DAYS";
}

function basisFromFieldCode(fieldCode: string) {
  const normalized = String(fieldCode ?? "").trim().toUpperCase();
  if (normalized === "WORK_HOURS") return "hours";
  if (normalized === "WORK_DAYS") return "days";
  return null;
}

function componentAttendanceBasis(component: AttendancePaymentComponentBasis): AttendanceInputBasis | null {
  if (normalizedToken(component.componentType) === "production"
    || normalizedToken(component.calculationSource) !== "attendance_eligibility") return null;
  const schedule = normalizedToken(component.paySchedule);
  if (schedule === "per_hour") return "hours";
  if (schedule === "per_day" || schedule === "per_month") return "days";
  return null;
}

function paymentSettingSignature(setting: AttendancePaymentSetting) {
  return JSON.stringify([
    setting.calculationMethod,
    setting.paidOffDays,
    setting.workUnitsPerPaidOff,
    setting.capAtMonthlyAmount
  ]);
}

function paymentSettingAt(settings: AttendancePaymentSetting[], date: string) {
  return settings
    .filter((setting) => setting.effectiveFrom <= date)
    .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom))[0] ?? {
      effectiveFrom: "",
      calculationMethod: "calendar_days",
      paidOffDays: 4,
      workUnitsPerPaidOff: 6,
      capAtMonthlyAmount: true
    };
}

function periodContext(effectiveFrom: string, effectiveTo: string) {
  return effectiveFrom === effectiveTo ? `on ${effectiveFrom}` : `for ${effectiveFrom} to ${effectiveTo}`;
}

export function validateAttendanceImportBases(
  rows: AttendanceImportRow[],
  allocations: EffectiveAttendanceAllocation[]
): AttendanceBasisIssue[] {
  const issues: AttendanceBasisIssue[] = [];
  for (const row of rows) {
    if (row.inputType !== "ATTENDANCE" || row.action !== "UPSERT") continue;
    const suppliedBasis = basisFromFieldCode(row.fieldCode) ?? row.attendanceBasis;
    if (suppliedBasis === null) continue;
    const effectiveFrom = row.effectiveFrom || row.effectiveDate || "";
    const effectiveTo = row.effectiveTo;
    const suppliedFieldCode = attendanceFieldCode(suppliedBasis);
    if (!effectiveFrom || !effectiveTo) {
      issues.push({
        rowNumber: row.rowNumber,
        dropxId: row.dropxId,
        message: `EFFECTIVE_DATE and EFFECTIVE_TO are compulsory for attendance FIELD_CODE ${suppliedFieldCode}.`
      });
      continue;
    }
    if (effectiveTo < effectiveFrom) {
      issues.push({
        rowNumber: row.rowNumber,
        dropxId: row.dropxId,
        message: `EFFECTIVE_TO cannot be before EFFECTIVE_DATE for attendance FIELD_CODE ${suppliedFieldCode}.`
      });
      continue;
    }
    if (effectiveFrom.slice(0, 7) !== effectiveTo.slice(0, 7)) {
      issues.push({
        rowNumber: row.rowNumber,
        dropxId: row.dropxId,
        message: "ATTENDANCE must stay within one calendar month. Split the row at the month boundary."
      });
      continue;
    }

    const dateContext = periodContext(effectiveFrom, effectiveTo);
    const overlappingAllocations = allocations.filter((allocation) => allocationMatchesRow(allocation, row)
      && allocationOverlaps(allocation, effectiveFrom, effectiveTo));
    if (!overlappingAllocations.length) {
      issues.push({
        rowNumber: row.rowNumber,
        dropxId: row.dropxId,
        message: `No effective payment allocation applies ${dateContext} for this Workforce member and location. Configure an allocation before uploading FIELD_CODE ${suppliedFieldCode}.`
      });
      continue;
    }
    const attendanceAllocations = overlappingAllocations.filter((allocation) => allocation.requiredBasis !== null);
    if (!attendanceAllocations.length) {
      issues.push({
        rowNumber: row.rowNumber,
        dropxId: row.dropxId,
        message: `The effective payment allocation ${dateContext} has no attendance-eligible hourly, daily, or monthly component. Configure the allocation before uploading FIELD_CODE ${suppliedFieldCode}.`
      });
      continue;
    }
    if (attendanceAllocations.length !== 1
      || !allocationCovers(attendanceAllocations[0], effectiveFrom, effectiveTo)) {
      issues.push({
        rowNumber: row.rowNumber,
        dropxId: row.dropxId,
        message: `Attendance VALUE is one aggregate ${dateContext}, so exactly one attendance payment allocation must cover the entire range. Split the row at every payment-method or effective-date change, and correct overlapping allocations before uploading.`
      });
      continue;
    }
    const requiredBasis = attendanceAllocations[0].requiredBasis;
    if (requiredBasis === null) continue;
    if (requiredBasis === "mixed") {
      issues.push({
        rowNumber: row.rowNumber,
        dropxId: row.dropxId,
        message: `The effective payment allocation ${dateContext} mixes hourly and daily/monthly attendance pay. One attendance VALUE cannot represent both WORK_HOURS and WORK_DAYS; use a payment method with one attendance basis before uploading.`
      });
      continue;
    }
    if (requiredBasis !== suppliedBasis) {
      const requiredFieldCode = attendanceFieldCode(requiredBasis);
      issues.push({
        rowNumber: row.rowNumber,
        dropxId: row.dropxId,
        message: requiredBasis === "hours"
          ? `FIELD_CODE ${suppliedFieldCode} is not valid ${dateContext} because the effective payment allocation includes hourly attendance pay. Use FIELD_CODE ${requiredFieldCode}.`
          : `FIELD_CODE ${suppliedFieldCode} is not valid ${dateContext} because the effective payment allocation uses daily or monthly attendance pay. Use FIELD_CODE ${requiredFieldCode}.`
      });
    }
  }
  return issues;
}

/**
 * Aggregate attendance has one quantity for the whole range. It cannot be
 * apportioned safely when an effective rate or monthly payment policy changes
 * inside that range, so reject those rows before the atomic RPC repeats the
 * same checks under its database locks.
 */
export function validateAttendanceImportStability(
  rows: AttendanceImportRow[],
  allocations: EffectiveAttendanceAllocation[],
  rateOverrides: AttendanceRateOverrideBoundary[],
  paymentSettings: AttendancePaymentSetting[]
): AttendanceBasisIssue[] {
  const issues: AttendanceBasisIssue[] = [];
  for (const row of rows) {
    if (row.inputType !== "ATTENDANCE" || row.action !== "UPSERT") continue;
    const suppliedBasis = basisFromFieldCode(row.fieldCode) ?? row.attendanceBasis;
    if (!suppliedBasis || !row.effectiveFrom || !row.effectiveTo) continue;
    const covering = allocations.filter((allocation) => allocationMatchesRow(allocation, row)
      && allocation.requiredBasis === suppliedBasis
      && allocationCovers(allocation, row.effectiveFrom, row.effectiveTo));
    if (covering.length !== 1) continue;

    const components = (covering[0].components ?? [])
      .filter((component) => componentAttendanceBasis(component) === suppliedBasis);
    const componentIds = new Set(components.map((component) => String(component.paymentFieldId ?? "").trim()).filter(Boolean));
    const componentCodes = new Set(components.map((component) => String(component.fieldCode ?? "").trim().toUpperCase()).filter(Boolean));
    const hasRateBoundary = rateOverrides.some((override) =>
      override.workforceId === row.workforceId
      && override.locationId === row.locationId
      && override.effectiveFrom <= row.effectiveTo
      && override.effectiveTo >= row.effectiveFrom
      && (override.effectiveFrom > row.effectiveFrom || override.effectiveTo < row.effectiveTo)
      && (componentIds.has(override.paymentFieldId) || componentCodes.has(override.fieldCode.toUpperCase())));
    if (hasRateBoundary) {
      issues.push({
        rowNumber: row.rowNumber,
        dropxId: row.dropxId,
        message: "An attendance payment-field rate override begins or ends inside this effective range. Split the attendance row at every rate boundary."
      });
      continue;
    }

    const usesMonthlyAttendance = components.some((component) =>
      normalizedToken(component.paySchedule) === "per_month"
      || normalizedToken(component.calculationType) === "fixed_monthly");
    if (!usesMonthlyAttendance) continue;
    const startSignature = paymentSettingSignature(paymentSettingAt(paymentSettings, row.effectiveFrom));
    const policyChangesInsideRange = paymentSettings.some((setting) =>
      setting.effectiveFrom > row.effectiveFrom
      && setting.effectiveFrom <= row.effectiveTo
      && paymentSettingSignature(setting) !== startSignature);
    if (policyChangesInsideRange) {
      issues.push({
        rowNumber: row.rowNumber,
        dropxId: row.dropxId,
        message: "The monthly attendance payment policy changes inside this effective range. Split the attendance row at every policy effective date."
      });
    }
  }
  return issues;
}
