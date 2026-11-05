import { isWorkforcePayoutPaymentBalanceAvailable } from "./workforce-payout-payment-summary.ts";

export type WorkforcePayoutExportComponent = {
  code: string;
  label: string;
  componentType: "production" | "amount";
  count: number;
  rate: number;
  amount: number;
  sortOrder?: number;
  reportedCount?: number;
  thresholdDeducted?: number;
  thresholdPeriod?: "day" | "month" | null;
  thresholdMinimum?: number | null;
  thresholdConfigurationMissing?: boolean;
};

export type WorkforcePayoutExportRow = {
  dropxId: string;
  dropxStatus: string;
  name: string;
  designation: string;
  designationCode?: string;
  providerMemberId: string;
  providerMemberName: string;
  location: string;
  provider: string;
  model: string;
  paymentMethod: string;
  mappingStatus: string;
  paymentDetailsAvailable: boolean;
  workDays: number;
  workDaysSource: string;
  productionBreakdown: WorkforcePayoutExportComponent[];
  additionalPaymentBreakdown?: Array<{
    fieldId: string;
    code: string;
    label: string;
    calculationType: "manual_amount" | "units_x_rate";
    inputValue: number;
    rateValue: number | null;
    amount: number;
  }>;
  baseAmount: number;
  additions: number;
  grossPayment: number;
  deductions: number;
  deductionBreakdown: Array<{ code: string; label: string; amount: number }>;
  netAmount: number;
  paymentSummary?: {
    paidAmount: number;
    processingAmount: number;
    eligible?: boolean | null;
    eligibilityCode?: string | null;
  };
  panAadhaarStatus: string;
  status: string;
};

type ExportValue = string | number;

function withUniqueLabels<T extends { code: string; label: string }>(items: T[]) {
  const labelCounts = new Map<string, number>();
  for (const item of items) {
    const key = item.label.trim().toLowerCase();
    labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
  }
  return items.map((item) => ({
    ...item,
    exportLabel: (labelCounts.get(item.label.trim().toLowerCase()) ?? 0) > 1
      ? `${item.label} [${item.code}]`
      : item.label
  }));
}

function componentIdentity(item: Pick<WorkforcePayoutExportComponent, "code" | "componentType" | "rate" | "reportedCount" | "thresholdPeriod" | "thresholdMinimum" | "thresholdConfigurationMissing">) {
  const thresholdIdentity = item.reportedCount === undefined
    ? "standard"
    : `threshold|${item.thresholdPeriod ?? "unknown"}|${item.thresholdMinimum ?? "missing"}|${item.thresholdConfigurationMissing === true}`;
  return `${item.code.trim().toUpperCase()}|${item.componentType}|${Number(item.rate)}|${thresholdIdentity}`;
}

function componentColumns(rows: WorkforcePayoutExportRow[], groupHeads = false) {
  const values = new Map<string, Pick<WorkforcePayoutExportComponent, "code" | "label" | "componentType" | "rate" | "reportedCount" | "thresholdPeriod" | "thresholdMinimum" | "thresholdConfigurationMissing">>();
  for (const row of rows) for (const item of row.productionBreakdown) {
    const identity = groupHeads ? headIdentity(item) : componentIdentity(item);
    if (values.has(identity)) continue;
    values.set(identity, {
      code: item.code,
      label: item.label,
      componentType: item.componentType,
      rate: item.rate,
      reportedCount: item.reportedCount,
      thresholdPeriod: item.thresholdPeriod,
      thresholdMinimum: item.thresholdMinimum,
      thresholdConfigurationMissing: item.thresholdConfigurationMissing
    });
  }
  // Each payout row is already arranged by its payment method's configured
  // field order. A CSV can contain methods with conflicting orders, so retain
  // the first visible occurrence instead of imposing a new alphabetic order.
  const items = Array.from(values.values());
  if (groupHeads) return withUniqueLabels(items);
  const labelCounts = new Map<string, number>();
  const codeCounts = new Map<string, number>();
  const codeRateCounts = new Map<string, number>();
  for (const item of items) {
    const labelKey = item.label.trim().toLowerCase();
    const codeKey = item.code.trim().toUpperCase();
    const codeRateKey = `${codeKey}|${Number(item.rate)}`;
    labelCounts.set(labelKey, (labelCounts.get(labelKey) ?? 0) + 1);
    codeCounts.set(codeKey, (codeCounts.get(codeKey) ?? 0) + 1);
    codeRateCounts.set(codeRateKey, (codeRateCounts.get(codeRateKey) ?? 0) + 1);
  }
  return items.map((item) => {
    const labelKey = item.label.trim().toLowerCase();
    const codeKey = item.code.trim().toUpperCase();
    const codeRateKey = `${codeKey}|${Number(item.rate)}`;
    const thresholdQualifier = item.reportedCount === undefined
      ? item.componentType
      : item.thresholdConfigurationMissing
        ? "threshold setup incomplete"
        : `${item.thresholdPeriod ?? "combined"} minimum ${item.thresholdMinimum ?? "missing"}`;
    const exportLabel = (codeCounts.get(codeKey) ?? 0) > 1
      ? `${item.label} @ INR ${item.rate}${(codeRateCounts.get(codeRateKey) ?? 0) > 1 ? ` [${thresholdQualifier}]` : ""}`
      : (labelCounts.get(labelKey) ?? 0) > 1
        ? `${item.label} [${item.code}]`
        : item.label;
    return { ...item, exportLabel };
  });
}

function headIdentity(item: Pick<WorkforcePayoutExportComponent, "code" | "componentType">) {
  return `${item.code.trim().toUpperCase()}|${item.componentType}`;
}

function designationCode(row: WorkforcePayoutExportRow) {
  if (row.designationCode !== undefined) return row.designationCode.trim();
  const text = row.designation.trim();
  return text.split(/\s+[-–—]\s+/).length > 1 ? text.split(/\s+[-–—]\s+/)[0] : /^[A-Za-z0-9_]{1,20}$/.test(text) ? text : "";
}

function deductionColumns(rows: WorkforcePayoutExportRow[]) {
  const values = new Map<string, string>();
  for (const row of rows) for (const item of row.deductionBreakdown) values.set(item.code, item.label);
  return withUniqueLabels(Array.from(values, ([code, label]) => ({ code, label }))
    .sort((left, right) => left.label.localeCompare(right.label) || left.code.localeCompare(right.code)));
}

function deductionHeader(label: string) {
  const normalized = label.trim();
  return `${/deduction$/i.test(normalized) ? normalized : `${normalized} Deduction`} (INR)`;
}

function additionalColumns(rows: WorkforcePayoutExportRow[]) {
  const values = new Map<string, NonNullable<WorkforcePayoutExportRow["additionalPaymentBreakdown"]>[number]>();
  for (const row of rows) for (const item of row.additionalPaymentBreakdown ?? []) {
    const key = item.fieldId || item.code;
    if (!values.has(key)) values.set(key, item);
  }
  return withUniqueLabels([...values.values()].map((item) => ({ ...item })));
}

function spreadsheetIdentifier(value: string) {
  const normalized = value.trim();
  return /^\d{11,}$/.test(normalized) || /^\d+(?:\.\d+)?E[+-]?\d+$/i.test(normalized)
    ? `="${normalized}"`
    : normalized;
}

function csvCell(value: ExportValue) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function paymentBalanceValues(
  row: WorkforcePayoutExportRow,
  subjectLabel: "Workforce" | "Helper"
): ExportValue[] {
  if (!row.paymentDetailsAvailable || !row.paymentSummary) return ["", "", ""];
  const eligibilityCode = String(row.paymentSummary.eligibilityCode ?? "").trim().toLowerCase();
  const balanceAvailable = subjectLabel === "Helper"
    || row.paymentSummary.eligible !== false
    || eligibilityCode === "publication_refresh_pending"
    || isWorkforcePayoutPaymentBalanceAvailable({
      eligible: row.paymentSummary.eligible,
      eligibilityCode: row.paymentSummary.eligibilityCode ?? null
    });
  if (!balanceAvailable) return ["", "", ""];
  const netAmount = Number(row.netAmount);
  const paidAmount = Number(row.paymentSummary.paidAmount);
  const processingAmount = Number(row.paymentSummary.processingAmount);
  if (![netAmount, paidAmount, processingAmount].every(Number.isFinite)) return ["", "", ""];
  const balancePayable = Math.max(0, (
    Math.round(netAmount * 100)
    - Math.round(paidAmount * 100)
    - Math.round(processingAmount * 100)
  ) / 100);
  return [paidAmount, processingAmount, balancePayable];
}

export function buildWorkforcePayoutExportTable(rows: WorkforcePayoutExportRow[], subjectLabel: "Workforce" | "Helper") {
  const workforce = subjectLabel === "Workforce";
  const details = componentColumns(rows, workforce);
  const additionalPayments = additionalColumns(rows);
  const deductions = deductionColumns(rows);
  const detailHeaders = details.flatMap((item) => workforce
    ? [`${item.exportLabel} Units`, `${item.exportLabel} Rate (INR)`, `${item.exportLabel} Amount (INR)`]
    : item.componentType === "production" && item.reportedCount !== undefined
    ? [`${item.exportLabel} Threshold Period`, `${item.exportLabel} Minimum Units`, `${item.exportLabel} Reported Units`, `${item.exportLabel} Threshold / Excluded Units`, `${item.exportLabel} Payable Units`, `${item.exportLabel} Rate (INR)`, `${item.exportLabel} Amount (INR)`]
    : item.componentType === "production"
      ? [`${item.exportLabel} Count`, `${item.exportLabel} Rate (INR)`, `${item.exportLabel} Amount (INR)`]
    : [`${item.exportLabel} Rate (INR)`, `${item.exportLabel} Amount (INR)`]);
  const headers = [
    "DropX ID",
    "DropX Status",
    `${subjectLabel} Name`,
    "Designation",
    "Partner Name",
    "Partner ID",
    "Location",
    workforce ? "Provider" : "Provider / Allocation",
    workforce ? "Model" : "Model / Basis",
    "Payment Method",
    "Work Days",
    ...workforce ? [] : ["Attendance Source"],
    ...detailHeaders,
    ...workforce ? [] : ["Base Payment (INR)"],
    ...additionalPayments.flatMap((item) => item.calculationType === "manual_amount"
      ? [`${item.exportLabel} (INR)`]
      : [`${item.exportLabel} Units`, `${item.exportLabel} Rate (INR)`, `${item.exportLabel} Amount (INR)`]),
    "Additional Payments (INR)",
    "Gross Payment (INR)",
    ...deductions.map((item) => deductionHeader(item.exportLabel)),
    "Gross Deductions (INR)",
    "Net Pay (INR)",
    "Paid (INR)",
    "Processing (INR)",
    "Balance Payable (INR)",
    "PAN-Aadhaar Status",
    "Mapping Status",
    "Payment Status"
  ];
  const exportRows = rows.map((row) => {
    const blankPayments = !row.paymentDetailsAvailable;
    const detailValues: ExportValue[] = details.flatMap((column): ExportValue[] => {
      if (workforce) {
        if (blankPayments) return ["", "", ""];
        const lines = row.productionBreakdown.filter(item => headIdentity(item) === headIdentity(column));
        if (!lines.length) return ["", 0, 0];
        const rates = [...new Set(lines.map(item => item.rate))].sort((left, right) => left - right);
        return [Math.round(lines.reduce((sum, item) => sum + item.count, 0) * 100) / 100,
          rates.length === 1 ? rates[0] : rates.join(" / "),
          Math.round(lines.reduce((sum, item) => sum + item.amount, 0) * 100) / 100];
      }
      if (blankPayments) return column.componentType === "production" && column.reportedCount !== undefined
        ? ["", "", "", "", "", "", ""]
        : column.componentType === "production" ? ["", "", ""] : ["", ""];
      const item = row.productionBreakdown.find((value) => componentIdentity(value) === componentIdentity(column));
      return column.componentType === "production" && column.reportedCount !== undefined
        ? [
          item?.thresholdPeriod ?? column.thresholdPeriod ?? "",
          item?.thresholdMinimum ?? column.thresholdMinimum ?? "",
          item?.reportedCount ?? 0,
          item?.thresholdDeducted ?? 0,
          item?.count ?? 0,
          item?.rate ?? 0,
          item?.amount ?? 0
        ]
        : column.componentType === "production"
        ? [item?.count ?? 0, item?.rate ?? 0, item?.amount ?? 0]
        : [item?.rate ?? 0, item?.amount ?? 0];
    });
    const deductionValues: ExportValue[] = deductions.map((column) => blankPayments
      ? ""
      // Several lines can share a code (one per Ops loss case), so the column is their total.
      : Math.round(row.deductionBreakdown.filter((item) => item.code === column.code).reduce((sum, item) => sum + Number(item.amount || 0), 0) * 100) / 100);
    const additionalValues: ExportValue[] = additionalPayments.flatMap((column): ExportValue[] => {
      if (blankPayments) return column.calculationType === "manual_amount" ? [""] : ["", "", ""];
      const item = (row.additionalPaymentBreakdown ?? []).find((value) => (value.fieldId || value.code) === (column.fieldId || column.code));
      if (column.calculationType === "manual_amount") return [item?.amount ?? 0];
      return [item?.inputValue ?? 0, item?.rateValue ?? 0, item?.amount ?? 0];
    });
    return [
      row.dropxId,
      row.dropxStatus,
      row.name,
      workforce ? designationCode(row) : row.designation,
      row.providerMemberName,
      spreadsheetIdentifier(row.providerMemberId),
      row.location,
      row.provider,
      blankPayments ? "" : row.model,
      blankPayments ? "" : row.paymentMethod,
      blankPayments || row.workDaysSource.toLowerCase().includes("unavailable") ? "" : row.workDays,
      ...workforce ? [] : [blankPayments ? "" : row.workDaysSource],
      ...detailValues,
      ...workforce ? [] : [blankPayments ? "" : row.baseAmount],
      ...additionalValues,
      blankPayments ? "" : row.additions,
      blankPayments ? "" : row.grossPayment,
      ...deductionValues,
      blankPayments ? "" : row.deductions,
      blankPayments ? "" : row.netAmount,
      ...paymentBalanceValues(row, subjectLabel),
      blankPayments ? "" : row.panAadhaarStatus,
      row.mappingStatus,
      row.status
    ] satisfies ExportValue[];
  });
  return { headers, rows: exportRows };
}

export function buildWorkforcePayoutCsv(rows: WorkforcePayoutExportRow[], subjectLabel: "Workforce" | "Helper") {
  const table = buildWorkforcePayoutExportTable(rows, subjectLabel);
  return [table.headers, ...table.rows]
    .map((line) => line.map(csvCell).join(","))
    .join("\r\n");
}
