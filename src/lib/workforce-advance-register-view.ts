export type WorkforceAdvanceRegisterViewRow = {
  advanceNumber: string;
  advanceDate: string;
  dropxId: string;
  workforceName: string;
  designation: string;
  location: string;
  paidLocation: string;
  total: number;
  deducted: number;
  pending: number;
  status: string;
  linkStatus: "pending" | "linked";
  paymentMode: string;
  paymentReference: string;
  externalReference: string;
  remark: string;
  source: string;
  createdAt: string;
};

export type WorkforceAdvanceFilterSelection = {
  designations: readonly string[];
  locations: readonly string[];
  paidLocations: readonly string[];
  paymentModes: readonly string[];
  statuses: readonly string[];
  sources: readonly string[];
  registrationStatuses: readonly WorkforceAdvanceRegisterViewRow["linkStatus"][];
  dateFrom: string;
  dateTo: string;
};

export type WorkforceAdvanceSummary = {
  records: number;
  awaitingRegistration: number;
  total: number;
  deducted: number;
  pending: number;
};

export type WorkforceAdvanceFacet =
  | "designation"
  | "location"
  | "paidLocation"
  | "paymentMode"
  | "status"
  | "source"
  | "registrationStatus";

function normalized(value: unknown) {
  return String(value ?? "").trim().toLocaleLowerCase();
}

function filterValue(value: unknown) {
  return String(value ?? "").trim() || "—";
}

function includesSelected(selected: readonly string[], value: string) {
  if (!selected.length) return true;
  const normalizedValue = normalized(filterValue(value));
  return selected.some((item) => normalized(item) === normalizedValue);
}

function isoDate(value: string) {
  const match = String(value ?? "").trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? "";
}

function dateIsInRange(value: string, dateFrom: string, dateTo: string) {
  const date = isoDate(value);
  const from = isoDate(dateFrom);
  const to = isoDate(dateTo);
  if (!date) return !from && !to;
  return (!from || date >= from) && (!to || date <= to);
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function matchesWorkforceAdvanceFilters(
  row: WorkforceAdvanceRegisterViewRow,
  search: string,
  filters: WorkforceAdvanceFilterSelection
) {
  const term = normalized(search);
  const matchesSearch = !term || [
    row.advanceNumber,
    row.dropxId,
    row.workforceName,
    row.designation,
    row.location,
    row.paidLocation,
    row.paymentMode,
    row.paymentReference,
    row.externalReference,
    row.status,
    row.source,
    row.remark
  ].some((value) => normalized(value).includes(term));

  return matchesSearch
    && includesSelected(filters.designations, row.designation)
    && includesSelected(filters.locations, row.location)
    && includesSelected(filters.paidLocations, row.paidLocation)
    && includesSelected(filters.paymentModes, row.paymentMode)
    && includesSelected(filters.statuses, row.status)
    && includesSelected(filters.sources, row.source)
    && includesSelected(filters.registrationStatuses, row.linkStatus)
    && dateIsInRange(row.advanceDate, filters.dateFrom, filters.dateTo);
}

export function filterWorkforceAdvanceRows<T extends WorkforceAdvanceRegisterViewRow>(
  rows: readonly T[],
  search: string,
  filters: WorkforceAdvanceFilterSelection
) {
  return rows.filter((row) => matchesWorkforceAdvanceFilters(row, search, filters));
}

export function summarizeWorkforceAdvanceRows(rows: readonly WorkforceAdvanceRegisterViewRow[]): WorkforceAdvanceSummary {
  return rows.reduce<WorkforceAdvanceSummary>((summary, row) => ({
    records: summary.records + 1,
    awaitingRegistration: summary.awaitingRegistration + (row.linkStatus === "pending" ? 1 : 0),
    total: roundMoney(summary.total + Number(row.total || 0)),
    deducted: roundMoney(summary.deducted + Number(row.deducted || 0)),
    pending: roundMoney(summary.pending + Number(row.pending || 0))
  }), { records: 0, awaitingRegistration: 0, total: 0, deducted: 0, pending: 0 });
}

export function workforceAdvanceFacetValues(
  rows: readonly WorkforceAdvanceRegisterViewRow[],
  facet: WorkforceAdvanceFacet
) {
  const values = rows.map((row) => {
    if (facet === "registrationStatus") return row.linkStatus;
    return row[facet];
  });
  return Array.from(new Set(values.map(filterValue)))
    .sort((left, right) => left.localeCompare(right));
}

function spreadsheetSafeText(value: string) {
  const text = String(value ?? "");
  const trimmed = text.trim();
  const numericIdentifierAtRisk = /^0\d+$/.test(trimmed)
    || /^\d{11,}$/.test(trimmed)
    || /^\d+(?:\.\d+)?e[+-]?\d+$/i.test(trimmed);
  const startsLikeFormula = /^[\s]*[=+@-]/.test(text) && !/^-?\d+(?:\.\d+)?$/.test(trimmed);
  return (numericIdentifierAtRisk || startsLikeFormula) && !text.startsWith("'") ? `'${text}` : text;
}

function csvCell(value: string | number) {
  const text = typeof value === "number" ? String(value) : spreadsheetSafeText(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export function buildWorkforceAdvanceCsv(rows: readonly WorkforceAdvanceRegisterViewRow[]) {
  const headers = [
    "Advance Number",
    "DropX ID",
    "Workforce Name",
    "Designation",
    "Current Location",
    "Advance Paid At",
    "Advance Date",
    "Payment Mode",
    "Payment Reference",
    "External Reference",
    "Total Advance (INR)",
    "Deducted (INR)",
    "Pending (INR)",
    "Deduction Status",
    "Registration Status",
    "Source",
    "Remark",
    "Created At"
  ];
  const exportRows = rows.map((row) => [
    row.advanceNumber,
    row.dropxId,
    row.workforceName,
    row.designation,
    row.location,
    row.paidLocation,
    row.advanceDate,
    row.paymentMode,
    row.paymentReference,
    row.externalReference,
    row.total,
    row.deducted,
    row.pending,
    row.status,
    row.linkStatus,
    row.source,
    row.remark,
    row.createdAt
  ] satisfies Array<string | number>);

  return "\uFEFF" + [headers, ...exportRows]
    .map((line) => line.map(csvCell).join(","))
    .join("\r\n");
}

export function workforceAdvanceExportFilename(dateFrom = "", dateTo = "") {
  const from = isoDate(dateFrom);
  const to = isoDate(dateTo);
  if (from && to) return `workforce-advances-${from}-to-${to}.csv`;
  if (from) return `workforce-advances-from-${from}.csv`;
  if (to) return `workforce-advances-through-${to}.csv`;
  return "workforce-advances.csv";
}
