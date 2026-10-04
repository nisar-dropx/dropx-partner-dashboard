export type WorkforcePayoutExportComponent = {
  code: string;
  label: string;
  componentType: "production" | "amount";
  count: number;
  rate: number;
  amount: number;
  sortOrder?: number;
};

export type WorkforcePayoutExportRow = {
  dropxId: string;
  dropxStatus: string;
  name: string;
  designation: string;
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
  baseAmount: number;
  additions: number;
  grossPayment: number;
  deductions: number;
  deductionBreakdown: Array<{ code: string; label: string; amount: number }>;
  netAmount: number;
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

function componentIdentity(item: Pick<WorkforcePayoutExportComponent, "code" | "componentType" | "rate">) {
  return `${item.code.trim().toUpperCase()}|${item.componentType}|${Number(item.rate)}`;
}

function componentColumns(rows: WorkforcePayoutExportRow[]) {
  const values = new Map<string, Pick<WorkforcePayoutExportComponent, "code" | "label" | "componentType" | "rate">>();
  for (const row of rows) for (const item of row.productionBreakdown) {
    const identity = componentIdentity(item);
    if (values.has(identity)) continue;
    values.set(identity, {
      code: item.code,
      label: item.label,
      componentType: item.componentType,
      rate: item.rate
    });
  }
  // Each payout row is already arranged by its payment method's configured
  // field order. A CSV can contain methods with conflicting orders, so retain
  // the first visible occurrence instead of imposing a new alphabetic order.
  const items = Array.from(values.values());
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
    const exportLabel = (codeCounts.get(codeKey) ?? 0) > 1
      ? `${item.label} @ INR ${item.rate}${(codeRateCounts.get(codeRateKey) ?? 0) > 1 ? ` [${item.componentType}]` : ""}`
      : (labelCounts.get(labelKey) ?? 0) > 1
        ? `${item.label} [${item.code}]`
        : item.label;
    return { ...item, exportLabel };
  });
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

function spreadsheetIdentifier(value: string) {
  const normalized = value.trim();
  return /^\d{11,}$/.test(normalized) || /^\d+(?:\.\d+)?E[+-]?\d+$/i.test(normalized)
    ? `="${normalized}"`
    : normalized;
}

function csvCell(value: ExportValue) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function buildWorkforcePayoutExportTable(rows: WorkforcePayoutExportRow[], subjectLabel: "Workforce" | "Helper") {
  const details = componentColumns(rows);
  const deductions = deductionColumns(rows);
  const detailHeaders = details.flatMap((item) => item.componentType === "production"
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
    "Provider / Allocation",
    "Model / Basis",
    "Payment Method",
    "Work Days",
    "Attendance Source",
    ...detailHeaders,
    "Base Payment (INR)",
    "Additional Payments (INR)",
    "Gross Payment (INR)",
    ...deductions.map((item) => deductionHeader(item.exportLabel)),
    "Gross Deductions (INR)",
    "Net Pay (INR)",
    "PAN-Aadhaar Status",
    "Mapping Status",
    "Payment Status"
  ];
  const exportRows = rows.map((row) => {
    const blankPayments = !row.paymentDetailsAvailable;
    const detailValues: ExportValue[] = details.flatMap((column): ExportValue[] => {
      if (blankPayments) return column.componentType === "production" ? ["", "", ""] : ["", ""];
      const item = row.productionBreakdown.find((value) => componentIdentity(value) === componentIdentity(column));
      return column.componentType === "production"
        ? [item?.count ?? 0, item?.rate ?? 0, item?.amount ?? 0]
        : [item?.rate ?? 0, item?.amount ?? 0];
    });
    const deductionValues: ExportValue[] = deductions.map((column) => blankPayments
      ? ""
      : row.deductionBreakdown.find((item) => item.code === column.code)?.amount ?? 0);
    return [
      row.dropxId,
      row.dropxStatus,
      row.name,
      row.designation,
      row.providerMemberName,
      spreadsheetIdentifier(row.providerMemberId),
      row.location,
      row.provider,
      blankPayments ? "" : row.model,
      blankPayments ? "" : row.paymentMethod,
      blankPayments || row.workDaysSource.toLowerCase().includes("unavailable") ? "" : row.workDays,
      blankPayments ? "" : row.workDaysSource,
      ...detailValues,
      blankPayments ? "" : row.baseAmount,
      blankPayments ? "" : row.additions,
      blankPayments ? "" : row.grossPayment,
      ...deductionValues,
      blankPayments ? "" : row.deductions,
      blankPayments ? "" : row.netAmount,
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
