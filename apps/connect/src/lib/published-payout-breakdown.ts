type Row = Record<string, any>;

export type PublishedPayoutBasis = "per_unit" | "per_day" | "per_hour" | "per_month" | "additional" | "other";

export type PublishedPayoutEarning = {
  code: string;
  label: string;
  basis: PublishedPayoutBasis;
  units: number | null;
  rate: number | null;
  amount: number;
  reportedUnits?: number;
  excludedUnits?: number;
  sortOrder: number;
};

export type PublishedPayoutDeduction = {
  code: string;
  label: string;
  amount: number;
};

export type PublishedPayoutAttendanceRange = {
  basis: "hours" | "days";
  quantity: number;
  effectiveFrom: string;
  effectiveTo: string;
};

export type PublishedPayoutBreakdown = {
  earnings: PublishedPayoutEarning[];
  deductions: PublishedPayoutDeduction[];
  attendanceSource: string;
  attendanceRanges: PublishedPayoutAttendanceRange[];
};

const number = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const optionalNumber = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const rounded = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const text = (value: unknown) => String(value ?? "").trim();

function basis(value: unknown, componentType: unknown, code: string, label: string): PublishedPayoutBasis {
  const normalized = text(value).toLowerCase().replaceAll("-", "_");
  if (["per_month", "monthly", "month"].includes(normalized)) return "per_month";
  if (["per_day", "daily", "day"].includes(normalized)) return "per_day";
  if (["per_hour", "hourly", "hour"].includes(normalized)) return "per_hour";
  if (["per_unit", "unit", "production"].includes(normalized) || text(componentType).toLowerCase() === "production") return "per_unit";
  const searchable = `${code} ${label}`.toLowerCase();
  if (/\b(month|monthly)\b/.test(searchable)) return "per_month";
  if (/\b(hour|hourly)\b/.test(searchable)) return "per_hour";
  if (/\b(day|daily)\b/.test(searchable)) return "per_day";
  return "other";
}

function earningFromPaymentLine(source: Row, index: number): PublishedPayoutEarning | null {
  const code = text(source.code || source.componentCode || source.fieldCode).toUpperCase();
  const label = text(source.label || source.name || code);
  if (!code && !label) return null;
  const units = optionalNumber(source.count ?? source.units ?? source.inputValue);
  const rate = optionalNumber(source.rate ?? source.rateValue);
  return {
    code: code || label.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_"),
    label: label || code,
    basis: basis(source.schedule ?? source.paySchedule ?? source.basis, source.componentType, code, label),
    units,
    rate,
    amount: rounded(number(source.amount ?? source.finalAmount)),
    ...(source.reportedCount === undefined ? {} : { reportedUnits: rounded(number(source.reportedCount)) }),
    ...(source.thresholdDeducted === undefined ? {} : { excludedUnits: rounded(number(source.thresholdDeducted)) }),
    sortOrder: Number.isFinite(Number(source.sortOrder)) ? Number(source.sortOrder) : index,
  };
}

function aggregateEarnings(lines: PublishedPayoutEarning[]) {
  const values = new Map<string, PublishedPayoutEarning>();
  for (const line of lines) {
    const key = `${line.code}|${line.basis}|${line.rate ?? "none"}`;
    const current = values.get(key);
    if (!current) {
      values.set(key, { ...line });
      continue;
    }
    current.units = current.units === null && line.units === null
      ? null
      : rounded((current.units ?? 0) + (line.units ?? 0));
    current.amount = rounded(current.amount + line.amount);
    if (current.reportedUnits !== undefined || line.reportedUnits !== undefined) {
      current.reportedUnits = rounded((current.reportedUnits ?? 0) + (line.reportedUnits ?? 0));
    }
    if (current.excludedUnits !== undefined || line.excludedUnits !== undefined) {
      current.excludedUnits = rounded((current.excludedUnits ?? 0) + (line.excludedUnits ?? 0));
    }
    current.sortOrder = Math.min(current.sortOrder, line.sortOrder);
  }
  return [...values.values()].sort((left, right) => left.sortOrder - right.sortOrder || left.label.localeCompare(right.label));
}

function additionalEarnings(rows: Row[]) {
  return rows.flatMap((source, index) => {
    const amount = rounded(number(source.amount ?? source.final_amount ?? source.finalAmount));
    if (!amount) return [];
    const calculationType = text(source.calculationType ?? source.calculation_type_snapshot);
    return [{
      code: text(source.code ?? source.field_code_snapshot).toUpperCase() || `ADDITIONAL_${index + 1}`,
      label: text(source.label ?? source.field_name_snapshot) || "Additional payment",
      basis: "additional" as const,
      units: calculationType === "units_x_rate" ? optionalNumber(source.inputValue ?? source.input_value) : null,
      rate: calculationType === "units_x_rate" ? optionalNumber(source.rateValue ?? source.rate_value) : null,
      amount,
      sortOrder: 10_000 + index,
    }];
  });
}

function deductionRows(rows: Row[]) {
  const values = new Map<string, PublishedPayoutDeduction>();
  rows.forEach((source, index) => {
    const amount = Math.abs(rounded(number(source.amount ?? source.adjustment_amount ?? source.adjustment)));
    if (!amount) return;
    const code = text(source.code ?? source.category).toUpperCase() || `DEDUCTION_${index + 1}`;
    const label = text(source.label ?? source.reason) || code.replaceAll("_", " ");
    const current = values.get(code) ?? { code, label, amount: 0 };
    current.amount = rounded(current.amount + amount);
    values.set(code, current);
  });
  return [...values.values()];
}

function attendanceRanges(worksheet: Row) {
  const ranges = new Map<string, PublishedPayoutAttendanceRange>();
  const days = Array.isArray(worksheet.daily_breakdown) ? worksheet.daily_breakdown : [];
  for (const day of days) {
    const source = day?.attendanceRange;
    const rangeBasis = text(source?.basis);
    const effectiveFrom = text(source?.effectiveFrom);
    const effectiveTo = text(source?.effectiveTo);
    if (!(["hours", "days"].includes(rangeBasis)) || !effectiveFrom || !effectiveTo) continue;
    const range = {
      basis: rangeBasis as "hours" | "days",
      quantity: rounded(number(source.quantity)),
      effectiveFrom,
      effectiveTo,
    };
    ranges.set(`${range.basis}|${range.effectiveFrom}|${range.effectiveTo}`, range);
  }
  return [...ranges.values()];
}

export function publishedPayoutBreakdown(snapshot: Row | null | undefined, rawLines: Row[], item: Row): PublishedPayoutBreakdown {
  const worksheet = snapshot?.worksheet && typeof snapshot.worksheet === "object" ? snapshot.worksheet as Row : {};
  const worksheetPaymentLines = Array.isArray(worksheet.production_breakdown) ? worksheet.production_breakdown : [];
  const rawPaymentLines = rawLines.flatMap((line) => Array.isArray(line?.calculation_snapshot?.paymentLines)
    ? line.calculation_snapshot.paymentLines
    : []);
  const paymentSources = worksheetPaymentLines.length ? worksheetPaymentLines : rawPaymentLines;
  let earnings = aggregateEarnings(paymentSources.flatMap((line, index) => {
    const value = earningFromPaymentLine(line, index);
    return value ? [value] : [];
  }));

  const worksheetAdditions = Array.isArray(worksheet.additional_payment_breakdown)
    ? worksheet.additional_payment_breakdown
    : [];
  const rawAdditions = rawLines.filter((line) => text(line.source_type) === "additional_payment").map((line) => ({
    code: line.calculation_snapshot?.category,
    label: line.calculation_snapshot?.reason,
    calculationType: line.calculation_snapshot?.calculationType,
    inputValue: line.calculation_snapshot?.inputValue,
    rateValue: line.calculation_snapshot?.rateValue,
    amount: line.adjustment_amount,
  }));
  earnings = [...earnings, ...additionalEarnings(worksheetAdditions.length ? worksheetAdditions : rawAdditions)];

  if (!earnings.length) {
    const base = rounded(number(item.base_amount) + number(item.incentive_amount));
    if (base) earnings.push({ code: "BASE", label: "Base payment", basis: "other", units: null, rate: null, amount: base, sortOrder: 0 });
    const addition = rounded(number(item.adjustment_amount));
    if (addition > 0) earnings.push({ code: "ADDITIONAL", label: "Additional payments", basis: "additional", units: null, rate: null, amount: addition, sortOrder: 10_000 });
  }

  const worksheetDeductions = Array.isArray(worksheet.deduction_breakdown) ? worksheet.deduction_breakdown : [];
  const rawDeductions = rawLines.filter((line) => text(line.source_type) === "deduction" || number(line.adjustment_amount) < 0).map((line) => ({
    code: line.calculation_snapshot?.category,
    label: line.calculation_snapshot?.reason,
    amount: Math.abs(number(line.adjustment_amount)),
  }));
  let deductions = deductionRows(worksheetDeductions.length ? worksheetDeductions : rawDeductions);
  if (!deductions.length && number(item.deduction_amount) > 0) {
    deductions = [{ code: "DEDUCTIONS", label: "Deductions", amount: rounded(number(item.deduction_amount)) }];
  }

  const source = text(worksheet.work_days_source)
    || text(rawLines.find((line) => text(line.calculation_snapshot?.attendanceSource))?.calculation_snapshot?.attendanceSource);
  return {
    earnings,
    deductions,
    attendanceSource: source,
    attendanceRanges: attendanceRanges(worksheet),
  };
}
