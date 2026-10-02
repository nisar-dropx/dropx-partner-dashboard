export type WorkforcePayoutExportComponent = {
  code: string;
  label: string;
  componentType: "production" | "amount";
  count: number;
  rate: number;
  amount: number;
};

export type WorkforcePayoutExportRow = {
  dropxId: string;
  dropxStatus: string;
  name: string;
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

const preferredProductionCodes = ["DELIVERY", "CRETURN", "SELLER_PICKUP", "SLLLER_RETURN"];

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

function componentColumns(rows: WorkforcePayoutExportRow[]) {
  const values = new Map<string, Pick<WorkforcePayoutExportComponent, "code" | "label" | "componentType">>();
  for (const row of rows) for (const item of row.productionBreakdown) {
    const current = values.get(item.code);
    values.set(item.code, {
      code: item.code,
      label: item.label,
      componentType: current?.componentType === "production" || item.componentType === "production" ? "production" : "amount"
    });
  }
  return withUniqueLabels(Array.from(values.values()).sort((left, right) => {
    if (left.componentType !== right.componentType) return left.componentType === "production" ? -1 : 1;
    if (left.componentType === "production") {
      const leftIndex = preferredProductionCodes.indexOf(left.code);
      const rightIndex = preferredProductionCodes.indexOf(right.code);
      if (leftIndex !== rightIndex) {
        if (leftIndex === -1) return 1;
        if (rightIndex === -1) return -1;
        return leftIndex - rightIndex;
      }
    }
    return left.label.localeCompare(right.label) || left.code.localeCompare(right.code);
  }));
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
      const item = row.productionBreakdown.find((value) => value.code === column.code);
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
