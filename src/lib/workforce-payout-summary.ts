import type { WorkforceAttendanceCaptureMethod } from "./workforce-attendance-capture.ts";

export type WorkDaySummaryInput = {
  date: string;
  attendanceUnit: number;
  source: WorkforceAttendanceCaptureMethod;
};

export type PaymentMethodAmountInput = {
  methodId: string;
  label: string;
  amount: number;
};

export type PayoutBreakdownLine = {
  code: string;
  label: string;
  componentType: "production" | "amount";
  count: number;
  rate: number;
  amount: number;
  sortOrder?: number;
};

const rounded = (value: number) => Math.round(value * 100) / 100;

export function attendanceCaptureLabel(source: WorkforceAttendanceCaptureMethod) {
  return source === "shipment_data" ? "Shipment data" : "Biometric";
}

export function summarizeWorkDays(inputs: WorkDaySummaryInput[]) {
  const byDate = new Map<string, WorkDaySummaryInput>();

  for (const input of inputs) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) continue;
    const attendanceUnit = Number.isFinite(input.attendanceUnit)
      ? Math.max(0, Math.min(1, input.attendanceUnit))
      : 0;
    const current = byDate.get(input.date);
    if (!current || attendanceUnit > current.attendanceUnit) {
      byDate.set(input.date, { ...input, attendanceUnit });
    }
  }

  const sources = new Set([...byDate.values()].map((input) => input.source));
  return {
    workDays: rounded([...byDate.values()].reduce((sum, input) => sum + input.attendanceUnit, 0)),
    source: sources.size > 1
      ? "Mixed"
      : sources.size === 1
        ? attendanceCaptureLabel([...sources][0])
        : "-"
  };
}

export function summarizePaymentMethodAmounts(inputs: PaymentMethodAmountInput[]) {
  const values = new Map<string, { id: string; label: string; amount: number }>();

  for (const input of inputs) {
    const id = String(input.methodId ?? "").trim();
    if (!id) continue;
    const current = values.get(id) ?? {
      id,
      label: String(input.label ?? "").trim() || "Unnamed payment method",
      amount: 0
    };
    current.amount += Number.isFinite(input.amount) ? input.amount : 0;
    values.set(id, current);
  }

  return [...values.values()]
    .map((value) => ({ ...value, amount: rounded(value.amount) }))
    .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
}

export function summarizePayoutBreakdownLines(lines: PayoutBreakdownLine[]) {
  const values = new Map<string, PayoutBreakdownLine>();
  for (const line of lines) {
    const key = `${line.code.trim().toUpperCase()}|${line.componentType}|${Number(line.rate)}`;
    const current = values.get(key) ?? { ...line, count: 0, amount: 0 };
    current.count += Number.isFinite(line.count) ? line.count : 0;
    current.amount += Number.isFinite(line.amount) ? line.amount : 0;
    values.set(key, current);
  }
  return [...values.values()].map((line) => ({
    ...line,
    count: rounded(line.count),
    amount: rounded(line.amount)
  }));
}
