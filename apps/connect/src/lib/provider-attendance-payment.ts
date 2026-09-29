import {
  monthlyAttendanceAmountForDay,
  workforcePaymentMonthStart,
  workforcePaymentPolicyForDate,
  type WorkforcePaymentPolicy
} from "../../../../src/lib/workforce-payment-policy.ts";

type Relation<T> = T | T[] | null | undefined;

export type ProviderAttendanceField = {
  code?: string | null;
  label?: string | null;
  field_type?: string | null;
  pay_schedule?: string | null;
  calculation_type?: string | null;
  calculation_source?: string | null;
};

export type ProviderAttendanceComponent = {
  component_code: string;
  component_type: string;
  label?: string | null;
  pay_schedule?: string | null;
  calculation_type?: string | null;
  calculation_source?: string | null;
  sort_order?: number | null;
  is_active?: boolean | null;
  payment_fields?: Relation<ProviderAttendanceField>;
};

export type ProviderAttendanceMethod = {
  id?: string | null;
  name?: string | null;
  payment_method_components?: ProviderAttendanceComponent[] | null;
};

export type ProviderAttendanceMapping = {
  id: string;
  payment_method_id?: string | null;
  payment_values: Record<string, unknown> | null;
  effective_from: string | null;
  effective_to: string | null;
  status?: string | null;
  payment_methods?: Relation<ProviderAttendanceMethod>;
};

export type ProviderAttendanceRecord = {
  id: string;
  punch_date: string;
  status?: string | null;
  in_time?: string | null;
  out_time?: string | null;
  work_minutes?: number | string | null;
};

export type ProviderAttendanceLine = {
  code: string;
  label: string;
  count: number;
  rate: number;
  amount: number;
  schedule: "per_day" | "per_hour" | "per_month";
};

export type ProviderAttendancePaymentDay = {
  id: string;
  mappingId: string;
  date: string;
  workDayUnits: number;
  workMinutes: number;
  lines: ProviderAttendanceLine[];
  amount: number;
};

export function consumeProviderAttendanceAmount(
  attendanceDay: Pick<ProviderAttendancePaymentDay, "mappingId" | "date" | "amount"> | undefined,
  consumed: Set<string>
) {
  if (!attendanceDay) return 0;
  const key = `${attendanceDay.mappingId}|${attendanceDay.date}`;
  if (consumed.has(key)) return 0;
  consumed.add(key);
  return attendanceDay.amount;
}

const first = <T,>(value: Relation<T>) => Array.isArray(value) ? value[0] : value ?? null;

function validDate(value: unknown) {
  const text = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(text)
    && Number.isFinite(Date.parse(`${text}T00:00:00Z`))
    && new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text;
}

function cents(value: number) {
  const rounded = Math.round(value * 100);
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(rounded)) {
    throw new Error("Your provider attendance payment contains an invalid amount. Contact Workforce.");
  }
  return rounded;
}

function amount(value: number) {
  return cents(value) / 100;
}

function daysInMonth(date: string) {
  const [year, month] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthlyDailyAccrual(rate: number, date: string) {
  const days = daysInMonth(date);
  const day = Number(date.slice(8, 10));
  return amount(rate * day / days) - amount(rate * (day - 1) / days);
}

function workDayUnits(attendance?: ProviderAttendanceRecord | null) {
  if (!attendance) return 0;
  const normalized = String(attendance.status ?? "").trim().toUpperCase();
  if (["A", "ABSENT", "L", "LEAVE", "U", "UNPAID"].includes(normalized)) return 0;
  if (["P", "PRESENT"].includes(normalized)) return 1;
  if (["HD", "HLF", "HALF_DAY", "HALF DAY"].includes(normalized)) return 0.5;
  return attendance.in_time ? 1 : 0;
}

function preferredAttendance(current: ProviderAttendanceRecord | undefined, candidate: ProviderAttendanceRecord) {
  if (!current) return candidate;
  const currentMinutes = Number(current.work_minutes ?? 0);
  const candidateMinutes = Number(candidate.work_minutes ?? 0);
  if (candidateMinutes !== currentMinutes) return candidateMinutes > currentMinutes ? candidate : current;
  const currentUnits = workDayUnits(current);
  const candidateUnits = workDayUnits(candidate);
  if (candidateUnits !== currentUnits) return candidateUnits > currentUnits ? candidate : current;
  return candidate.in_time && !current.in_time ? candidate : current;
}

function fieldFor(component: ProviderAttendanceComponent) {
  return first(component.payment_fields);
}

function attendanceComponents(mapping: ProviderAttendanceMapping) {
  const method = first(mapping.payment_methods);
  return [...(method?.payment_method_components ?? [])]
    .filter((component) => component.is_active !== false)
    .filter((component) => {
      const field = fieldFor(component);
      const source = String(field?.calculation_source ?? component.calculation_source ?? "").trim().toLowerCase();
      const calculation = String(field?.calculation_type ?? component.calculation_type ?? "").trim().toLowerCase();
      return component.component_type !== "production"
        && field?.field_type !== "production"
        && calculation !== "count_x_rate"
        && source === "attendance_eligibility";
    })
    .sort((left, right) => Number(left.sort_order ?? 0) - Number(right.sort_order ?? 0)
      || left.component_code.localeCompare(right.component_code));
}

function componentCode(component: ProviderAttendanceComponent) {
  return String(component.component_code || fieldFor(component)?.code || "").trim();
}

function paymentValue(values: Record<string, unknown> | null, code: string) {
  const source = values ?? {};
  const direct = source[code];
  const raw = direct === undefined
    ? Object.entries(source).find(([key]) => key.trim().toUpperCase() === code.trim().toUpperCase())?.[1]
    : direct;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    throw new Error("Your provider attendance payment is missing a required rate. Contact Workforce.");
  }
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error("Your provider attendance payment contains an invalid rate. Contact Workforce.");
  }
  return numeric;
}

function componentSchedule(component: ProviderAttendanceComponent) {
  const field = fieldFor(component);
  const calculation = String(field?.calculation_type ?? component.calculation_type ?? "").trim().toLowerCase();
  const configured = String(field?.pay_schedule || component.pay_schedule || "").trim().toLowerCase();
  if (calculation === "fixed_monthly" || configured === "per_month") return "per_month" as const;
  if (configured === "per_hour") return "per_hour" as const;
  if (calculation === "fixed_daily" || configured === "per_day") return "per_day" as const;
  throw new Error("Your provider attendance payment is missing a per-hour, per-day or per-month schedule. Contact Workforce.");
}

function setupSignature(mapping: ProviderAttendanceMapping, components: ProviderAttendanceComponent[]) {
  return JSON.stringify(components.map((component) => {
    const code = componentCode(component);
    const field = fieldFor(component);
    return [
      code.toUpperCase(),
      String(field?.calculation_source ?? component.calculation_source ?? "").toLowerCase(),
      componentSchedule(component),
      paymentValue(mapping.payment_values, code)
    ];
  }));
}

function activeOn(mapping: ProviderAttendanceMapping, date: string) {
  return mapping.status !== "cancelled"
    && Boolean(mapping.effective_from)
    && mapping.effective_from! <= date
    && (!mapping.effective_to || mapping.effective_to >= date);
}

export function hasProviderAttendanceComponents(mapping: ProviderAttendanceMapping) {
  return attendanceComponents(mapping).length > 0;
}

export function calculateProviderAttendancePayments(input: {
  mappings: ProviderAttendanceMapping[];
  attendance: ProviderAttendanceRecord[];
  policyHistory?: Array<Partial<WorkforcePaymentPolicy>> | null;
  from: string;
  to: string;
}) {
  if (!validDate(input.from) || !validDate(input.to) || input.to < input.from) {
    throw new Error("Choose a valid provider attendance payment period.");
  }

  const attendanceIds = new Set<string>();
  const attendanceByDate = new Map<string, ProviderAttendanceRecord>();
  for (const attendance of input.attendance) {
    if (!attendance.id || !validDate(attendance.punch_date)) {
      throw new Error("Invalid attendance needs Workforce reconciliation before payment.");
    }
    if (attendanceIds.has(attendance.id)) continue;
    attendanceIds.add(attendance.id);
    attendanceByDate.set(attendance.punch_date, preferredAttendance(attendanceByDate.get(attendance.punch_date), attendance));
  }

  const days: ProviderAttendancePaymentDay[] = [];
  const cursor = new Date(`${workforcePaymentMonthStart(input.from)}T00:00:00Z`);
  const final = new Date(`${input.to}T00:00:00Z`);
  if ((final.getTime() - cursor.getTime()) / 86_400_000 > 366) {
    throw new Error("Provider attendance payment period is too large to reconcile safely.");
  }

  let cumulativeMonth = "";
  let cumulativeAttendanceUnits = 0;
  for (; cursor <= final; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = cursor.toISOString().slice(0, 10);
    const attendance = attendanceByDate.get(date);
    const units = workDayUnits(attendance);
    const month = date.slice(0, 7);
    if (month !== cumulativeMonth) {
      cumulativeMonth = month;
      cumulativeAttendanceUnits = 0;
    }
    const cumulativeAttendanceUnitsBefore = cumulativeAttendanceUnits;
    cumulativeAttendanceUnits += units;
    if (date < input.from) continue;
    const candidates = input.mappings
      .filter((mapping) => activeOn(mapping, date))
      .map((mapping) => ({ mapping, components: attendanceComponents(mapping) }))
      .filter((entry) => entry.components.length)
      .sort((left, right) => String(right.mapping.effective_from).localeCompare(String(left.mapping.effective_from))
        || right.mapping.id.localeCompare(left.mapping.id));
    if (!candidates.length) continue;

    const latestFrom = candidates[0].mapping.effective_from;
    const current = candidates.filter((entry) => entry.mapping.effective_from === latestFrom);
    if (new Set(current.map((entry) => setupSignature(entry.mapping, entry.components))).size > 1) {
      throw new Error("Conflicting provider attendance payment allocations need Workforce reconciliation.");
    }

    const { mapping, components } = current[0];
    const minutes = units > 0 ? Number(attendance?.work_minutes ?? 0) : 0;
    if (!Number.isFinite(minutes) || minutes < 0) {
      throw new Error("Attendance work time is invalid. Contact Workforce.");
    }

    const lines = components.map((component): ProviderAttendanceLine => {
      const field = fieldFor(component);
      const code = componentCode(component);
      if (!code) throw new Error("A provider attendance payment component is missing its code. Contact Workforce.");
      const label = String(field?.label || component.label || code).trim();
      const rate = paymentValue(mapping.payment_values, code);
      const schedule = componentSchedule(component);
      const monthlyAttendance = schedule === "per_month"
        ? monthlyAttendanceAmountForDay({
          monthlyAmount: rate,
          date,
          attendanceUnit: units,
          cumulativeAttendanceUnitsBefore,
          policy: workforcePaymentPolicyForDate(input.policyHistory, date)
        })
        : null;
      const count = schedule === "per_month"
        ? monthlyAttendance!.count
        : schedule === "per_hour"
          ? minutes / 60
          : units;
      const calculated = schedule === "per_month"
        ? monthlyAttendance!.amount
        : rate * count;
      return { code, label, count, rate, amount: amount(calculated), schedule };
    });
    const totalCents = lines.reduce((sum, line) => sum + cents(line.amount), 0);
    if (!Number.isSafeInteger(totalCents)) {
      throw new Error("Provider attendance earnings exceed the supported calculation range.");
    }
    if (totalCents === 0 && units <= 0) continue;
    days.push({
      id: `provider-attendance:${mapping.id}:${attendance?.id ?? `calendar:${date}`}`,
      mappingId: mapping.id,
      date,
      workDayUnits: units,
      workMinutes: minutes,
      lines,
      amount: totalCents / 100
    });
  }

  return days;
}
