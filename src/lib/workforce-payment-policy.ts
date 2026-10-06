export const WORKFORCE_PAYMENT_METHODS = [
  "calendar_days",
  "fixed_paid_offs",
  "earned_paid_offs"
] as const;

export type WorkforcePaymentMethod = (typeof WORKFORCE_PAYMENT_METHODS)[number];

export type WorkforcePaymentPolicy = {
  id?: string | number | null;
  calculation_method: WorkforcePaymentMethod;
  paid_off_days: number;
  work_units_per_paid_off: number;
  cap_at_monthly_amount: boolean;
  effective_from: string;
};

export type WorkforcePaymentFinalizedPeriod = {
  period_start: string;
  period_end: string;
};

export const DEFAULT_WORKFORCE_PAYMENT_POLICY: WorkforcePaymentPolicy = {
  calculation_method: "calendar_days",
  paid_off_days: 4,
  work_units_per_paid_off: 6,
  cap_at_monthly_amount: true,
  effective_from: "0001-01-01"
};

export function workforcePaymentMethodFields(method: WorkforcePaymentMethod) {
  return {
    paidOffDays: method === "fixed_paid_offs" || method === "earned_paid_offs",
    workUnitsPerPaidOff: method === "earned_paid_offs"
  };
}

export function workforcePaymentMonthIsFinalized(
  effectiveFrom: string,
  finalizedPeriods: WorkforcePaymentFinalizedPeriod[]
) {
  const [year, month] = effectiveFrom.slice(0, 7).split("-").map(Number);
  const nextMonth = month === 12
    ? `${String(year + 1).padStart(4, "0")}-01-01`
    : `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-01`;

  return finalizedPeriods.some((period) =>
    period.period_end >= effectiveFrom
    && period.period_start < nextMonth
  );
}

const rounded = (value: number) => Math.round(value * 100) / 100;

export function workforcePaymentMonthStart(date: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date.slice(0, 7)}-01` : date;
}

export function daysInWorkforcePaymentMonth(date: string) {
  const [year, month] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function normalizeWorkforcePaymentPolicy(
  value?: Partial<WorkforcePaymentPolicy> | null
): WorkforcePaymentPolicy {
  const method = WORKFORCE_PAYMENT_METHODS.includes(value?.calculation_method as WorkforcePaymentMethod)
    ? value!.calculation_method as WorkforcePaymentMethod
    : DEFAULT_WORKFORCE_PAYMENT_POLICY.calculation_method;
  const paidOffDays = Number(value?.paid_off_days);
  const workUnitsPerPaidOff = Number(value?.work_units_per_paid_off);
  return {
    id: value?.id ?? null,
    calculation_method: method,
    paid_off_days: Number.isFinite(paidOffDays) && paidOffDays >= 0 && paidOffDays <= 10
      ? paidOffDays
      : DEFAULT_WORKFORCE_PAYMENT_POLICY.paid_off_days,
    work_units_per_paid_off: Number.isFinite(workUnitsPerPaidOff) && workUnitsPerPaidOff > 0 && workUnitsPerPaidOff <= 31
      ? workUnitsPerPaidOff
      : DEFAULT_WORKFORCE_PAYMENT_POLICY.work_units_per_paid_off,
    cap_at_monthly_amount: value?.cap_at_monthly_amount !== false,
    effective_from: /^\d{4}-\d{2}-01$/.test(String(value?.effective_from ?? ""))
      ? String(value!.effective_from)
      : DEFAULT_WORKFORCE_PAYMENT_POLICY.effective_from
  };
}

export function workforcePaymentPolicyForDate(
  history: Array<Partial<WorkforcePaymentPolicy>> | null | undefined,
  date: string
) {
  const selected = [...(history ?? [])]
    .filter((policy) => String(policy.effective_from ?? "") <= date)
    .sort((left, right) => String(right.effective_from ?? "").localeCompare(String(left.effective_from ?? "")))[0];
  return normalizeWorkforcePaymentPolicy(selected);
}

export function monthlyAttendanceAmountForDay(input: {
  monthlyAmount: number;
  date: string;
  attendanceUnit: number;
  cumulativeAttendanceUnitsBefore?: number;
  policy?: Partial<WorkforcePaymentPolicy> | null;
  /** @deprecated Use monthlyAttendanceAmountForAggregateUnits for period totals. */
  aggregateAttendance?: boolean;
}) {
  const monthlyAmount = Number(input.monthlyAmount);
  const attendanceUnit = Math.max(0, Number(input.attendanceUnit) || 0);
  const policy = normalizeWorkforcePaymentPolicy(input.policy);
  const calendarDays = daysInWorkforcePaymentMonth(input.date);

  if (!Number.isFinite(monthlyAmount) || monthlyAmount < 0 || !calendarDays) {
    throw new Error("Attendance-based monthly payment contains an invalid amount or date.");
  }

  if (input.aggregateAttendance) {
    return monthlyAttendanceAmountForAggregateUnits({
      monthlyAmount,
      date: input.date,
      attendanceUnits: attendanceUnit,
      cumulativeAttendanceUnitsBefore: input.cumulativeAttendanceUnitsBefore,
      policy
    });
  }

  if (policy.calculation_method === "calendar_days") {
    const day = Number(input.date.slice(8, 10));
    const dailyAccrual = rounded(monthlyAmount * day / calendarDays)
      - rounded(monthlyAmount * (day - 1) / calendarDays);
    return {
      amount: rounded(dailyAccrual * attendanceUnit),
      count: attendanceUnit / calendarDays,
      creditedPaidOffUnits: 0,
      payableUnits: attendanceUnit
    };
  }

  const delta = monthlyAttendanceAmountForAggregateUnits({
    monthlyAmount,
    date: input.date,
    attendanceUnits: attendanceUnit,
    cumulativeAttendanceUnitsBefore: input.cumulativeAttendanceUnitsBefore,
    policy
  });
  return {
    ...delta,
    // Preserve the existing per-day line-count contract. Aggregate callers
    // receive the exact entitlement fraction from the dedicated helper.
    count: monthlyAmount > 0 ? delta.amount / monthlyAmount : 0
  };
}

/**
 * Calculates one period total as the delta between the worker's cumulative
 * monthly entitlement before and after the supplied aggregate units. Unlike a
 * daily accrual, this does not invent which calendar dates the units belong to.
 */
export function monthlyAttendanceAmountForAggregateUnits(input: {
  monthlyAmount: number;
  date: string;
  attendanceUnits: number;
  cumulativeAttendanceUnitsBefore?: number;
  policy?: Partial<WorkforcePaymentPolicy> | null;
}) {
  const monthlyAmount = Number(input.monthlyAmount);
  const attendanceUnits = Math.max(0, Number(input.attendanceUnits) || 0);
  const cumulativeBefore = Math.max(0, Number(input.cumulativeAttendanceUnitsBefore) || 0);
  const policy = normalizeWorkforcePaymentPolicy(input.policy);
  const calendarDays = daysInWorkforcePaymentMonth(input.date);

  if (!Number.isFinite(monthlyAmount) || monthlyAmount < 0 || !calendarDays) {
    throw new Error("Attendance-based monthly payment contains an invalid amount or date.");
  }

  const target = (attendanceUnits: number) => {
    let payableUnits = attendanceUnits;
    let creditedPaidOffUnits = 0;
    let divisor = calendarDays;
    if (policy.calculation_method === "fixed_paid_offs") {
      divisor = Math.max(1, calendarDays - policy.paid_off_days);
    } else if (policy.calculation_method === "earned_paid_offs") {
      creditedPaidOffUnits = Math.min(
        policy.paid_off_days,
        Math.floor((attendanceUnits + Number.EPSILON) / policy.work_units_per_paid_off)
      );
      payableUnits += creditedPaidOffUnits;
    }
    const fraction = payableUnits / divisor;
    const cappedFraction = policy.cap_at_monthly_amount ? Math.min(1, fraction) : fraction;
    return {
      amount: rounded(monthlyAmount * cappedFraction),
      fraction: cappedFraction,
      creditedPaidOffUnits,
      payableUnits
    };
  };

  const before = target(cumulativeBefore);
  const after = target(cumulativeBefore + attendanceUnits);
  const amount = rounded(Math.max(0, after.amount - before.amount));
  return {
    amount,
    count: Math.max(0, after.fraction - before.fraction),
    creditedPaidOffUnits: Math.max(0, after.creditedPaidOffUnits - before.creditedPaidOffUnits),
    payableUnits: Math.max(0, after.payableUnits - before.payableUnits)
  };
}

export function workforcePaymentExample(
  policy: Partial<WorkforcePaymentPolicy>,
  attendanceUnits: number,
  monthlyAmount = 18_000,
  date = "2026-09-30"
) {
  const normalized = normalizeWorkforcePaymentPolicy(policy);
  if (normalized.calculation_method === "calendar_days") {
    return rounded(monthlyAmount * attendanceUnits / daysInWorkforcePaymentMonth(date));
  }
  return monthlyAttendanceAmountForDay({
    monthlyAmount,
    date,
    attendanceUnit: attendanceUnits,
    cumulativeAttendanceUnitsBefore: 0,
    policy: normalized
  }).amount;
}
