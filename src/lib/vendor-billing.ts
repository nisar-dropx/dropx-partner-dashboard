export type VendorBillingMode = "fixed_cycle" | "daily_attendance";

export type VendorBillingAmounts = {
  expectedUnits: number;
  presentUnits: number;
  absentUnits: number;
  grossAmount: number;
  deductionAmount: number;
  payableAmount: number;
};

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function utcDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function isoDay(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function addMonths(value: string, months: number) {
  const date = utcDate(value);
  const originalDay = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(originalDay, lastDay));
  return isoDay(date);
}

export function previousDay(value: string) {
  const date = utcDate(value);
  date.setUTCDate(date.getUTCDate() - 1);
  return isoDay(date);
}

export function nextVendorPeriod(periodStart: string, frequencyMonths: number, contractEnd?: string | null) {
  const naturalEnd = previousDay(addMonths(periodStart, frequencyMonths));
  return {
    periodStart,
    periodEnd: contractEnd && contractEnd < naturalEnd ? contractEnd : naturalEnd,
    nextPeriodStart: addMonths(periodStart, frequencyMonths)
  };
}

export function dateRange(start: string, end: string) {
  const days: string[] = [];
  for (let cursor = utcDate(start), last = utcDate(end); cursor <= last; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    days.push(isoDay(cursor));
  }
  return days;
}

export function vendorBillingAmounts({
  attendanceRequired,
  expectedUnits,
  mode,
  presentUnits,
  rateAmount
}: {
  attendanceRequired: boolean;
  expectedUnits: number;
  mode: VendorBillingMode;
  presentUnits: number;
  rateAmount: number;
}): VendorBillingAmounts {
  if (!Number.isFinite(rateAmount) || rateAmount < 0) throw new Error("Rate amount must be zero or higher.");
  const expected = attendanceRequired ? Math.max(0, expectedUnits) : 1;
  const present = attendanceRequired ? Math.min(expected, Math.max(0, presentUnits)) : 1;
  const absent = Math.max(0, expected - present);

  if (mode === "daily_attendance") {
    const gross = rateAmount * expected;
    const payable = rateAmount * present;
    return {
      expectedUnits: expected,
      presentUnits: present,
      absentUnits: absent,
      grossAmount: roundMoney(gross),
      deductionAmount: roundMoney(gross - payable),
      payableAmount: roundMoney(payable)
    };
  }

  const gross = rateAmount;
  const deduction = attendanceRequired && expected > 0 ? (gross / expected) * absent : 0;
  return {
    expectedUnits: expected,
    presentUnits: present,
    absentUnits: absent,
    grossAmount: roundMoney(gross),
    deductionAmount: roundMoney(deduction),
    payableAmount: roundMoney(Math.max(0, gross - deduction))
  };
}

export function attendanceCredit(status: string | null | undefined, punchCount = 0) {
  const normalized = String(status ?? "").trim().toUpperCase();
  if (normalized === "HD" || normalized === "HALF_DAY") return 0.5;
  if (["P", "PRESENT", "APPROVED", "AVAILABLE", "DEPLOYED", "CONFIRMED", "WORKING"].includes(normalized)) return 1;
  return punchCount > 0 ? 1 : 0;
}
