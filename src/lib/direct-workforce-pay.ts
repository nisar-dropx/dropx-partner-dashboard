import {
  monthlyAttendanceAmountForAggregateUnits,
  monthlyAttendanceAmountForDay,
  workforcePaymentPolicyForDate,
  type WorkforcePaymentPolicy
} from "./workforce-payment-policy.ts";

export type DirectPayComponent = {
  payment_field_id?: string | null;
  component_code: string;
  component_type: string;
  label?: string | null;
  pay_schedule?: string | null;
  calculation_type?: string | null;
  calculation_source?: string | null;
  is_custom_production?: boolean | null;
  sort_order?: number | string | null;
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
  sortOrder: number;
};

export type DirectPayAttendanceBasis = "hours" | "days";

type DirectPaySchedule = DirectPayLine["schedule"];

const rounded = (value: number) => Math.round(value * 100) / 100;

function directPaySchedule(component: DirectPayComponent): DirectPaySchedule | null {
  if (component.calculation_type === "fixed_monthly" || /month/i.test(String(component.pay_schedule ?? ""))) {
    return "per_month";
  }
  if (/hour/i.test(String(component.pay_schedule ?? ""))) return "per_hour";
  if (/day/i.test(String(component.pay_schedule ?? ""))) return "per_day";
  return null;
}

export function directPayAttendanceBasis(
  component: DirectPayComponent
): DirectPayAttendanceBasis | null {
  if (String(component.calculation_source ?? "").trim().toLowerCase() !== "attendance_eligibility"
    || String(component.component_type ?? "").trim().toLowerCase() === "production"
    || String(component.calculation_type ?? "").trim().toLowerCase() === "count_x_rate") {
    return null;
  }
  const schedule = directPaySchedule(component);
  if (schedule === "per_hour") return "hours";
  if (schedule === "per_day" || schedule === "per_month") return "days";
  return null;
}

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

export function cumulativeDirectPayAttendanceUnitsBefore(
  date: string,
  effectiveFrom: string,
  attendanceForDate: (candidateDate: string) => DirectPayAttendance | null | undefined
) {
  return cumulativeDirectPayUnitsBefore(date, effectiveFrom, (candidateDate) =>
    directPayAttendanceUnit(attendanceForDate(candidateDate)));
}

export function cumulativeDirectPayUnitsBefore(
  date: string,
  effectiveFrom: string,
  unitsForDate: (candidateDate: string) => number
) {
  const monthStart = `${date.slice(0, 7)}-01`;
  const periodStart = effectiveFrom > monthStart ? effectiveFrom : monthStart;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || periodStart >= date) return 0;
  let total = 0;
  for (let cursor = new Date(`${periodStart}T00:00:00.000Z`); cursor < new Date(`${date}T00:00:00.000Z`); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    total += Math.max(0, Number(unitsForDate(cursor.toISOString().slice(0, 10))) || 0);
  }
  return total;
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
    attendanceInput?: { basis: DirectPayAttendanceBasis; quantity: number } | null;
  }
) {
  const values = Object.fromEntries(Object.entries(paymentValues ?? {}).map(([key, value]) => [key.trim().toUpperCase(), value]));
  const sourceAttendanceUnit = directPayAttendanceUnit(attendance);
  const sourcePresent = sourceAttendanceUnit > 0;
  const sourceMinutes = sourcePresent ? Math.max(0, Number(attendance?.work_minutes ?? 0)) : 0;
  const importedQuantity = options?.attendanceInput
    ? Math.max(0, Number(options.attendanceInput.quantity) || 0)
    : null;
  const attendanceUnit = options?.attendanceInput?.basis === "days" ? importedQuantity ?? 0 : sourceAttendanceUnit;
  const present = options?.attendanceInput ? (importedQuantity ?? 0) > 0 : sourcePresent;
  const minutes = options?.attendanceInput?.basis === "hours" ? (importedQuantity ?? 0) * 60 : sourceMinutes;
  let missing = components.length === 0;
  const lines: DirectPayLine[] = [];

  const orderedComponents = components
    .map((component, index) => ({ component, index, rank: Number(component.sort_order) }))
    .sort((left, right) => {
      const leftRank = Number.isFinite(left.rank) ? left.rank : left.index;
      const rightRank = Number.isFinite(right.rank) ? right.rank : right.index;
      return leftRank - rightRank || left.index - right.index;
    });

  for (const { component, index } of orderedComponents) {
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
    const schedule = directPaySchedule(component);
    if (!schedule) {
      missing = true;
      continue;
    }
    const attendanceBasis = directPayAttendanceBasis(component);
    const attendanceBased = attendanceBasis !== null;
    const usesAggregateAttendance = attendanceBasis !== null
      && attendanceBasis === options?.attendanceInput?.basis;
    if (attendanceBased && schedule === "per_hour" && options?.attendanceSource === "shipment_data" && !usesAggregateAttendance) {
      // Shipment totals prove that the daily threshold was met, but they do
      // not contain worked minutes. Paying an hourly head from this source
      // would silently invent time, so leave the row incomplete for review.
      missing = true;
      continue;
    }
    if (attendanceBased && schedule === "per_hour" && sourcePresent && attendance?.work_minutes == null && !usesAggregateAttendance) {
      // A bulk attendance status can establish P/HD without supplying worked
      // minutes. Hourly pay must remain incomplete until real minutes exist.
      missing = true;
      continue;
    }
    const componentAttendanceUnit = usesAggregateAttendance && attendanceBasis === "days"
      ? importedQuantity ?? 0
      : sourceAttendanceUnit;
    const componentMinutes = usesAggregateAttendance && attendanceBasis === "hours"
      ? (importedQuantity ?? 0) * 60
      : sourceMinutes;
    const monthlyAttendance = schedule === "per_month" && attendanceBased
      ? usesAggregateAttendance
        ? monthlyAttendanceAmountForAggregateUnits({
          monthlyAmount: rate,
          date,
          attendanceUnits: componentAttendanceUnit,
          cumulativeAttendanceUnitsBefore: options?.cumulativeAttendanceUnitsBefore,
          policy: workforcePaymentPolicyForDate(options?.policyHistory, date)
        })
        : monthlyAttendanceAmountForDay({
          monthlyAmount: rate,
          date,
          attendanceUnit: componentAttendanceUnit,
          cumulativeAttendanceUnitsBefore: options?.cumulativeAttendanceUnitsBefore,
          policy: workforcePaymentPolicyForDate(options?.policyHistory, date)
        })
      : null;
    const count = schedule === "per_month"
      ? monthlyAttendance?.count ?? 1 / new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).getUTCDate()
      : schedule === "per_hour"
        ? componentMinutes / 60
        : componentAttendanceUnit;
    const amount = schedule === "per_month"
      ? monthlyAttendance?.amount ?? rounded(monthlyDailyAccrual(rate, date))
      : rounded(rate * count);
    const normalized = `${code} ${label}`.toUpperCase();
    const bucket = /VAN|VEHICLE|DOCK/.test(normalized) ? "van" : /FUEL|KILOMET|\bKM\b/.test(normalized) ? "fuel" : "salary";
    const configuredOrder = Number(component.sort_order);
    lines.push({ code, label, schedule, count, rate, amount, bucket, sortOrder: Number.isFinite(configuredOrder) ? configuredOrder : index });
  }

  return { lines, total: rounded(lines.reduce((sum, line) => sum + line.amount, 0)), missing, present, attendanceUnit, minutes };
}

export function allocationActiveOn(allocation: { effective_from: string; effective_to?: string | null }, date: string) {
  return allocation.effective_from <= date && (!allocation.effective_to || allocation.effective_to >= date);
}
