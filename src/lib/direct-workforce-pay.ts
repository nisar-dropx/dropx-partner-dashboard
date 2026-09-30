import {
  monthlyAttendanceAmountForDay,
  workforcePaymentPolicyForDate,
  type WorkforcePaymentPolicy
} from "./workforce-payment-policy.ts";

export type DirectPayComponent = {
  component_code: string;
  component_type: string;
  label?: string | null;
  pay_schedule?: string | null;
  calculation_type?: string | null;
  calculation_source?: string | null;
};

export type DirectPayAttendance = {
  punch_date: string;
  status?: string | null;
  in_time?: string | null;
  out_time?: string | null;
  work_minutes?: number | string | null;
};

export type DirectPayLine = {
  code: string;
  label: string;
  schedule: "per_month" | "per_day" | "per_hour";
  count: number;
  rate: number;
  amount: number;
  bucket: "salary" | "fuel" | "van";
};

const rounded = (value: number) => Math.round(value * 100) / 100;

export function monthlyDailyAccrual(amount: number, date: string) {
  const [year, month, day] = date.split("-").map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return rounded(amount * day / days) - rounded(amount * (day - 1) / days);
}

export function isPresentDirectPayDay(attendance?: DirectPayAttendance | null) {
  if (!attendance) return false;
  const status = String(attendance.status ?? "").trim().toUpperCase();
  if (["A", "ABSENT", "L", "LEAVE", "U", "UNPAID"].includes(status)) return false;
  if (["P", "PRESENT", "HD", "HLF", "HALF_DAY", "HALF DAY"].includes(status)) return true;
  return Boolean(attendance.in_time);
}

export function directPayAttendanceUnit(attendance?: DirectPayAttendance | null) {
  if (!isPresentDirectPayDay(attendance)) return 0;
  const status = String(attendance?.status ?? "").trim().toUpperCase();
  return ["HD", "HLF", "HALF_DAY", "HALF DAY"].includes(status) ? 0.5 : 1;
}

export function preferredDirectPayAttendance(
  current: DirectPayAttendance | null | undefined,
  candidate: DirectPayAttendance
) {
  if (!current) return candidate;
  const currentMinutes = Number(current.work_minutes ?? 0);
  const candidateMinutes = Number(candidate.work_minutes ?? 0);
  if (candidateMinutes !== currentMinutes) return candidateMinutes > currentMinutes ? candidate : current;
  const currentUnit = directPayAttendanceUnit(current);
  const candidateUnit = directPayAttendanceUnit(candidate);
  if (candidateUnit !== currentUnit) return candidateUnit > currentUnit ? candidate : current;
  return candidate.in_time && !current.in_time ? candidate : current;
}

export function directPayForDay(
  paymentValues: Record<string, unknown> | null | undefined,
  components: DirectPayComponent[],
  date: string,
  attendance?: DirectPayAttendance | null,
  options?: {
    policyHistory?: Array<Partial<WorkforcePaymentPolicy>> | null;
    cumulativeAttendanceUnitsBefore?: number;
    attendanceSource?: "biometric" | "shipment_data";
  }
) {
  const values = Object.fromEntries(Object.entries(paymentValues ?? {}).map(([key, value]) => [key.trim().toUpperCase(), value]));
  const attendanceUnit = directPayAttendanceUnit(attendance);
  const present = attendanceUnit > 0;
  const minutes = present ? Math.max(0, Number(attendance?.work_minutes ?? 0)) : 0;
  let missing = components.length === 0;
  const lines: DirectPayLine[] = [];

  for (const component of components) {
    const code = String(component.component_code ?? "").trim().toUpperCase();
    const label = String(component.label ?? code).trim() || code;
    if (!code || component.component_type === "production" || component.calculation_type === "count_x_rate") {
      missing = true;
      continue;
    }
    const rawRate = values[code];
    const rate = Number(rawRate);
    if (rawRate == null || String(rawRate).trim() === "" || !Number.isFinite(rate) || rate < 0) {
      missing = true;
      continue;
    }
    const schedule = component.calculation_type === "fixed_monthly" || /month/i.test(String(component.pay_schedule ?? ""))
      ? "per_month"
      : /hour/i.test(String(component.pay_schedule ?? ""))
        ? "per_hour"
        : /day/i.test(String(component.pay_schedule ?? ""))
          ? "per_day"
          : null;
    if (!schedule) {
      missing = true;
      continue;
    }
    const attendanceBased = component.calculation_source === "attendance_eligibility";
    if (attendanceBased && schedule === "per_hour" && options?.attendanceSource === "shipment_data") {
      // Shipment totals prove that the daily threshold was met, but they do
      // not contain worked minutes. Paying an hourly head from this source
      // would silently invent time, so leave the row incomplete for review.
      missing = true;
      continue;
    }
    const monthlyAttendance = schedule === "per_month" && attendanceBased
      ? monthlyAttendanceAmountForDay({
        monthlyAmount: rate,
        date,
        attendanceUnit,
        cumulativeAttendanceUnitsBefore: options?.cumulativeAttendanceUnitsBefore,
        policy: workforcePaymentPolicyForDate(options?.policyHistory, date)
      })
      : null;
    const count = schedule === "per_month"
      ? monthlyAttendance?.count ?? 1 / new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).getUTCDate()
      : schedule === "per_hour"
        ? minutes / 60
        : attendanceUnit;
    const amount = schedule === "per_month"
      ? monthlyAttendance?.amount ?? rounded(monthlyDailyAccrual(rate, date))
      : rounded(rate * count);
    const normalized = `${code} ${label}`.toUpperCase();
    const bucket = /VAN|VEHICLE|DOCK/.test(normalized) ? "van" : /FUEL|KILOMET|\bKM\b/.test(normalized) ? "fuel" : "salary";
    lines.push({ code, label, schedule, count, rate, amount, bucket });
  }

  return { lines, total: rounded(lines.reduce((sum, line) => sum + line.amount, 0)), missing, present, attendanceUnit, minutes };
}

export function allocationActiveOn(allocation: { effective_from: string; effective_to?: string | null }, date: string) {
  return allocation.effective_from <= date && (!allocation.effective_to || allocation.effective_to >= date);
}
