import {
  workforceAdditionalPaymentLines,
  workforceAdditionalPaymentTotal,
  type WorkforceAdditionalPaymentField,
  type WorkforceAdditionalPaymentValue
} from "./workforce-additional-payment-overlay.ts";
import {
  workforcePayoutDeductionLines,
  workforcePayoutDeductionTotal,
  type WorkforcePayoutDeductionValue
} from "./workforce-deduction-overlay.ts";
import type { AutomaticDeductionHead, DeductionWorkerContext } from "./workforce-deductions.ts";

export type HelperPayoutAttendanceValue = {
  id?: string | null;
  helper_id: string;
  station_id: string;
  attendance_basis: "hours" | "days" | string;
  effective_from: string;
  effective_to: string;
  quantity: number | string;
};

export type HelperAdditionalPaymentValue = Omit<WorkforceAdditionalPaymentValue, "workforce_id"> & {
  helper_id: string;
};

export type HelperPayoutDeductionValue = Omit<WorkforcePayoutDeductionValue, "workforce_id"> & {
  helper_id: string;
};

function rounded(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Database exclusion constraints make one aggregate period authoritative.
 * Fixtures or partially migrated data fail closed when more than one period
 * claims the same Helper/location/date.
 */
export function helperPayoutAttendancePeriodForDate(
  values: readonly HelperPayoutAttendanceValue[],
  lookup: { helperId: string; stationId: string; date: string }
) {
  const matches = values.filter((value) => value.helper_id === lookup.helperId
    && value.station_id === lookup.stationId
    && value.effective_from <= lookup.date
    && value.effective_to >= lookup.date
    && (value.attendance_basis === "hours" || value.attendance_basis === "days")
    && Number.isFinite(Number(value.quantity))
    && Number(value.quantity) >= 0);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * A workbook attendance quantity is the total for its inclusive range. The
 * payout settles it once on the final date and sends zero on preceding dates,
 * preventing biometric attendance from being counted in addition to the
 * explicit aggregate.
 */
export function helperPayoutAttendanceInputForDate(
  period: HelperPayoutAttendanceValue | null | undefined,
  date: string
) {
  if (!period || (period.attendance_basis !== "hours" && period.attendance_basis !== "days")) return null;
  return {
    basis: period.attendance_basis,
    quantity: date === period.effective_to ? Math.max(0, Number(period.quantity) || 0) : 0
  } as const;
}

export function calculateHelperPayoutAdjustments(input: {
  baseAmount: number;
  additionalFields: WorkforceAdditionalPaymentField[];
  additionalValues: HelperAdditionalPaymentValue[];
  deductionHeads: AutomaticDeductionHead[];
  deductionValues: HelperPayoutDeductionValue[];
  deductionContext: DeductionWorkerContext;
  includeAutomaticDeductions?: boolean;
}) {
  const additionalValues: WorkforceAdditionalPaymentValue[] = input.additionalValues.map((value) => ({
    ...value,
    workforce_id: value.helper_id
  }));
  const deductionValues: WorkforcePayoutDeductionValue[] = input.deductionValues.map((value) => ({
    ...value,
    workforce_id: value.helper_id
  }));
  const additionalPaymentBreakdown = workforceAdditionalPaymentLines(
    input.baseAmount,
    input.additionalFields,
    additionalValues
  );
  const additions = workforceAdditionalPaymentTotal(additionalPaymentBreakdown);
  const grossPayment = rounded(input.baseAmount + additions);
  const deductionBreakdown = workforcePayoutDeductionLines(
    grossPayment,
    input.deductionHeads,
    input.deductionContext,
    deductionValues,
    { includeAutomaticDeductions: input.includeAutomaticDeductions }
  );
  const deductions = workforcePayoutDeductionTotal(deductionBreakdown);
  return {
    additionalPaymentBreakdown,
    additions,
    grossPayment,
    deductionBreakdown,
    deductions,
    netAmount: rounded(grossPayment - deductions)
  };
}
