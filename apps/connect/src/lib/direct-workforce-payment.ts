type Relation<T> = T | T[] | null | undefined;

export type DirectPaymentField = {
  code?: string | null;
  label?: string | null;
  field_type?: string | null;
  pay_schedule?: string | null;
  calculation_type?: string | null;
  calculation_source?: string | null;
};

export type DirectPaymentComponent = {
  component_code: string;
  component_type: string;
  label?: string | null;
  pay_schedule?: string | null;
  sort_order?: number | null;
  is_active?: boolean | null;
  payment_fields?: Relation<DirectPaymentField>;
};

export type DirectPaymentMethod = {
  id: string;
  code?: string | null;
  name?: string | null;
  payment_method_components?: DirectPaymentComponent[] | null;
};

export type DirectPaymentAllocation = {
  id: string;
  workforce_id: string;
  station_id?: string | null;
  station_code_snapshot?: string | null;
  designation_id?: string | null;
  designation_code_snapshot?: string | null;
  designation_name_snapshot?: string | null;
  payment_method_id: string;
  payment_values: Record<string, unknown> | null;
  payment_components?: DirectPaymentComponent[] | null;
  effective_from: string;
  effective_to?: string | null;
  status: string;
};

export type DirectAttendanceDay = {
  id: string;
  punch_date: string;
  status?: string | null;
  in_time?: string | null;
  out_time?: string | null;
  work_minutes?: number | null;
};

export type DirectPaymentLine = {
  code: string;
  label: string;
  count: number;
  rate: number;
  amount: number;
  schedule: "per_day" | "per_hour" | "per_month";
};

export type DirectPaymentDay = {
  id: string;
  allocationId: string;
  paymentMethodId: string;
  date: string;
  workDayUnits: number;
  workMinutes: number;
  lines: DirectPaymentLine[];
  amount: number;
};

const first = <T,>(value: Relation<T>) => Array.isArray(value) ? value[0] : value ?? null;

function validDate(value: unknown) {
  const text = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && Number.isFinite(Date.parse(`${text}T00:00:00Z`)) && new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text;
}

function cents(value: number) {
  const rounded = Math.round(value * 100);
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(rounded)) {
    throw new Error("Your direct payment allocation contains an invalid amount. Contact Workforce.");
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

function workDayUnits(attendance?: DirectAttendanceDay | null) {
  if (!attendance) return 0;
  const normalized = String(attendance.status ?? "").trim().toUpperCase();
  if (["A", "ABSENT", "L", "LEAVE", "U", "UNPAID"].includes(normalized)) return 0;
  if (["P", "PRESENT"].includes(normalized)) return 1;
  if (["HD", "HLF", "HALF_DAY", "HALF DAY"].includes(normalized)) return 0.5;
  return attendance.in_time ? 1 : 0;
}

function preferredAttendance(current: DirectAttendanceDay | undefined, candidate: DirectAttendanceDay) {
  if (!current) return candidate;
  const currentMinutes = Number(current.work_minutes ?? 0);
  const candidateMinutes = Number(candidate.work_minutes ?? 0);
  if (candidateMinutes !== currentMinutes) return candidateMinutes > currentMinutes ? candidate : current;
  const currentUnits = workDayUnits(current);
  const candidateUnits = workDayUnits(candidate);
  if (candidateUnits !== currentUnits) return candidateUnits > currentUnits ? candidate : current;
  return candidate.in_time && !current.in_time ? candidate : current;
}

function allocationForDate(allocations: DirectPaymentAllocation[], date: string) {
  const matches = allocations
    .filter((allocation) => allocation.status !== "cancelled")
    .filter((allocation) => allocation.effective_from <= date && (!allocation.effective_to || allocation.effective_to >= date))
    .sort((left, right) => right.effective_from.localeCompare(left.effective_from) || right.id.localeCompare(left.id));
  if (matches.length > 1) {
    throw new Error("Overlapping direct payment allocations need Workforce reconciliation.");
  }
  return matches[0] ?? null;
}

function paymentValue(values: Record<string, unknown> | null, code: string) {
  const source = values ?? {};
  const direct = source[code];
  const raw = direct === undefined
    ? Object.entries(source).find(([key]) => key.trim().toUpperCase() === code.trim().toUpperCase())?.[1]
    : direct;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    throw new Error("Your direct payment allocation is missing a required rate. Contact Workforce.");
  }
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error("Your direct payment allocation contains an invalid rate. Contact Workforce.");
  }
  return numeric;
}

function componentSchedule(component: DirectPaymentComponent, field: DirectPaymentField | null) {
  const calculation = String(field?.calculation_type ?? "").trim().toLowerCase();
  const configured = String(field?.pay_schedule || component.pay_schedule || "").trim().toLowerCase();
  if (calculation === "fixed_monthly" || configured === "per_month") return "per_month" as const;
  if (configured === "per_hour") return "per_hour" as const;
  if (calculation === "fixed_daily" || configured === "per_day") return "per_day" as const;
  if (["percentage", "count_x_rate"].includes(calculation)) {
    throw new Error("This direct payment method needs a supported attendance or fixed calculation. Contact Workforce.");
  }
  throw new Error("This direct payment method is missing a per-hour, per-day or per-month schedule. Contact Workforce.");
}

export function calculateDirectWorkforcePayments(input: {
  allocations: DirectPaymentAllocation[];
  methods: DirectPaymentMethod[];
  attendance: DirectAttendanceDay[];
  from: string;
  to: string;
}) {
  if (!validDate(input.from) || !validDate(input.to) || input.to < input.from) {
    throw new Error("Choose a valid direct payment period.");
  }
  const methods = new Map(input.methods.map((method) => [method.id, method]));
  const attendanceIds = new Set<string>();
  const attendanceByDate = new Map<string, DirectAttendanceDay>();
  const days: DirectPaymentDay[] = [];

  for (const attendance of input.attendance) {
    if (!attendance.id || !validDate(attendance.punch_date)) {
      throw new Error("Invalid attendance needs Workforce reconciliation before payment.");
    }
    if (attendanceIds.has(attendance.id)) continue;
    attendanceIds.add(attendance.id);
    attendanceByDate.set(attendance.punch_date, preferredAttendance(attendanceByDate.get(attendance.punch_date), attendance));
  }

  const cursor = new Date(`${input.from}T00:00:00Z`);
  const final = new Date(`${input.to}T00:00:00Z`);
  if ((final.getTime() - cursor.getTime()) / 86_400_000 > 366) throw new Error("Direct payment period is too large to reconcile safely.");
  for (; cursor <= final; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = cursor.toISOString().slice(0, 10);
    const attendance = attendanceByDate.get(date);
    const allocation = allocationForDate(input.allocations, date);
    const units = workDayUnits(attendance);
    if (!allocation) continue;
    const snapshotComponents = Array.isArray(allocation.payment_components)
      ? allocation.payment_components.filter((component): component is DirectPaymentComponent => Boolean(component && typeof component === "object"))
      : [];
    const method = methods.get(allocation.payment_method_id);
    if (!snapshotComponents.length && !method) throw new Error("Your direct payment method is unavailable. Contact Workforce.");
    const minutes = Number(attendance?.work_minutes ?? 0);
    if (!Number.isFinite(minutes) || minutes < 0) throw new Error("Attendance work time is invalid. Contact Workforce.");
    const components = [...(snapshotComponents.length ? snapshotComponents : method?.payment_method_components ?? [])]
      .filter((component) => component.is_active !== false)
      .sort((left, right) => Number(left.sort_order ?? 0) - Number(right.sort_order ?? 0) || left.component_code.localeCompare(right.component_code));
    const lines = components.map((component): DirectPaymentLine => {
      const field = first(component.payment_fields);
      const calculation = String(field?.calculation_type ?? "").trim().toLowerCase();
      if (component.component_type === "production" || field?.field_type === "production" || calculation === "count_x_rate") {
        throw new Error("Production components cannot be used in a direct workforce payment allocation.");
      }
      const code = String(component.component_code || field?.code).trim();
      if (!code) throw new Error("A direct payment component is missing its code. Contact Workforce.");
      const label = String(field?.label || component.label || code).trim();
      const rate = paymentValue(allocation.payment_values, code);
      const schedule = componentSchedule(component, field);
      const count = schedule === "per_month" ? 1 / daysInMonth(date) : schedule === "per_hour" ? (units > 0 ? minutes / 60 : 0) : units;
      const calculated = schedule === "per_month"
        ? monthlyDailyAccrual(rate, date)
        : rate * count;
      return { code, label, count, rate, amount: amount(calculated), schedule };
    });
    const totalCents = lines.reduce((sum, line) => sum + cents(line.amount), 0);
    if (!Number.isSafeInteger(totalCents)) throw new Error("Direct earnings exceed the supported calculation range.");
    if (totalCents === 0 && units <= 0) continue;
    days.push({
      id: `direct:${allocation.id}:${attendance?.id ?? `calendar:${date}`}`,
      allocationId: allocation.id,
      paymentMethodId: allocation.payment_method_id,
      date,
      workDayUnits: units,
      workMinutes: minutes,
      lines,
      amount: totalCents / 100
    });
  }

  return days;
}

export function assertNoProviderDirectOverlap(input: {
  allocations: Array<Pick<DirectPaymentAllocation, "id" | "effective_from" | "effective_to" | "status">>;
  mappings: Array<{ id: string; effective_from: string | null; effective_to: string | null }>;
  from: string;
  to: string;
}) {
  for (const allocation of input.allocations.filter((row) => row.status !== "cancelled")) {
    const allocationFrom = allocation.effective_from > input.from ? allocation.effective_from : input.from;
    const allocationTo = allocation.effective_to && allocation.effective_to < input.to ? allocation.effective_to : input.to;
    for (const mapping of input.mappings) {
      if (!mapping.effective_from) continue;
      const mappingFrom = mapping.effective_from > input.from ? mapping.effective_from : input.from;
      const mappingTo = mapping.effective_to && mapping.effective_to < input.to ? mapping.effective_to : input.to;
      if (allocationFrom <= mappingTo && mappingFrom <= allocationTo) {
        throw new Error("Provider and direct payment allocations overlap. Contact Workforce before relying on earnings.");
      }
    }
  }
}

export function directAllocationForDate(allocations: DirectPaymentAllocation[], date: string) {
  if (!validDate(date)) throw new Error("Choose a valid payment date.");
  return allocationForDate(allocations, date);
}
