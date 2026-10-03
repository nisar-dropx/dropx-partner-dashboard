import { matchNames } from "./name-match.ts";

export type ProviderFirstWorkerView = {
  id: string;
  dropxId: string;
  fullName: string;
  stationId: string;
  providerId: string;
  dateOfJoin: string;
  mappingId: string;
  paymentMethodId: string;
  paymentValues: Record<string, string>;
  effectiveFrom: string;
  effectiveTo: string;
  mappedProviderMemberId: string;
  locationLabel: string;
  onboardingStatus: string;
};

export type ProviderFirstMappingRowView = {
  providerMemberId: string;
  providerMemberName: string;
  stationId: string;
  stationLabel: string;
  providerId: string;
  workforceId: string;
  dropxId: string;
  dropxName: string;
  mappingId: string;
  paymentMethodId: string;
  paymentValues: Record<string, string>;
  effectiveFrom: string;
  effectiveTo: string;
};

export type ProviderFirstPaymentMethodView = {
  id: string;
  components: Array<{ code: string; label: string }>;
};

export type ProviderFirstFilters = {
  query: string;
  stationIds: string[];
  paymentMethodIds: string[];
  mappingStatuses: string[];
  validationStatuses: string[];
};

export type ProviderFirstPageSize = 50 | 100 | 500 | 1000 | "all";

const SCIENTIFIC_ID_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/;
const MAX_DISPLAY_ID_LENGTH = 64;

/**
 * Expands a scientific-notation source ID without converting it through a
 * JavaScript number. This is display-only: the raw imported ID remains the
 * value used for matching and saving because the source may already be
 * rounded (for example, `2.00001E+12`).
 */
export function providerMemberIdDisplay(value: string) {
  const source = String(value ?? "").trim();
  const match = source.match(SCIENTIFIC_ID_PATTERN);
  if (!match) return source;

  const [, sign, whole, fraction = "", exponentText] = match;
  const exponent = Number(exponentText);
  const digits = `${whole}${fraction}`;
  if (!Number.isSafeInteger(exponent) || digits.length + Math.abs(exponent) > MAX_DISPLAY_ID_LENGTH) return source;
  const decimalIndex = whole.length + exponent;
  const prefix = sign === "-" ? "-" : "";

  if (decimalIndex <= 0) return `${prefix}0.${"0".repeat(-decimalIndex)}${digits}`;
  if (decimalIndex >= digits.length) return `${prefix}${digits}${"0".repeat(decimalIndex - digits.length)}`;
  return `${prefix}${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}

export function providerMemberKey(stationId: string, providerMemberId: string) {
  return `${String(stationId ?? "").trim()}|${String(providerMemberId ?? "").trim().toUpperCase()}`;
}

function sameProviderMember(left: string, right: string) {
  return String(left ?? "").trim().toUpperCase() === String(right ?? "").trim().toUpperCase();
}

export function providerFirstNamesMatch(providerName: string, dropxName: string) {
  return matchNames(providerName, dropxName).status !== "none";
}

export function providerFirstRowIssue(
  row: ProviderFirstMappingRowView,
  worker: ProviderFirstWorkerView | undefined,
  method: ProviderFirstPaymentMethodView | undefined
) {
  if (!row.workforceId) return "Select a DropX workforce ID.";
  if (!worker) return "The selected DropX workforce ID is unavailable.";
  if (worker.stationId !== row.stationId) return "Location mismatch.";
  if (worker.mappedProviderMemberId && !sameProviderMember(worker.mappedProviderMemberId, row.providerMemberId)) {
    return "This DropX ID is already mapped to another Provider Member ID.";
  }
  if (!providerFirstNamesMatch(row.providerMemberName, row.dropxName)) return "Name mismatch.";
  if (!row.providerId) return "The selected location has no provider.";
  if (!row.paymentMethodId) return "Payment method is required.";
  if (!method) return "Payment method is invalid.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.effectiveFrom)) return "Effective from is required.";
  if (row.effectiveTo && !/^\d{4}-\d{2}-\d{2}$/.test(row.effectiveTo)) return "Effective to is invalid.";
  if (row.effectiveTo && row.effectiveTo < row.effectiveFrom) return "Effective to cannot be before effective from.";

  for (const component of method.components) {
    const raw = row.paymentValues[component.code]?.trim() ?? "";
    const amount = Number(raw);
    if (!raw) return `${component.label} is required.`;
    if (!Number.isFinite(amount) || amount < 0) return `${component.label} must be a valid amount.`;
  }
  return null;
}

export function providerFirstValidationStatus(
  row: ProviderFirstMappingRowView,
  worker: ProviderFirstWorkerView | undefined,
  method: ProviderFirstPaymentMethodView | undefined
) {
  if (!row.workforceId) return "unmapped";
  return providerFirstRowIssue(row, worker, method) ? "needs_attention" : "ready";
}

export function filterProviderFirstRowIndexes({
  rows,
  workerById,
  paymentMethodById,
  filters
}: {
  rows: ProviderFirstMappingRowView[];
  workerById: Map<string, ProviderFirstWorkerView>;
  paymentMethodById: Map<string, ProviderFirstPaymentMethodView>;
  filters: ProviderFirstFilters;
}) {
  const query = filters.query.trim().toLocaleLowerCase();
  return rows.flatMap((row, index) => {
    const worker = workerById.get(row.workforceId);
    const method = paymentMethodById.get(row.paymentMethodId);
    const searchable = [row.providerMemberId, row.providerMemberName, row.dropxId, row.dropxName, row.stationLabel]
      .join(" ")
      .toLocaleLowerCase();
    const mappingStatus = row.workforceId ? "mapped" : "unmapped";
    const validationStatus = providerFirstValidationStatus(row, worker, method);
    const matches = (!query || searchable.includes(query))
      && (!filters.stationIds.length || filters.stationIds.includes(row.stationId))
      && (!filters.paymentMethodIds.length || filters.paymentMethodIds.includes(row.paymentMethodId || "unassigned"))
      && (!filters.mappingStatuses.length || filters.mappingStatuses.includes(mappingStatus))
      && (!filters.validationStatuses.length || filters.validationStatuses.includes(validationStatus));
    return matches ? [index] : [];
  });
}

export function providerFirstPageWindow(totalRows: number, requestedPage: number, pageSize: ProviderFirstPageSize) {
  const numericSize = pageSize === "all" ? Math.max(1, totalRows) : pageSize;
  const totalPages = pageSize === "all" ? 1 : Math.max(1, Math.ceil(totalRows / numericSize));
  const page = Math.min(Math.max(1, Math.trunc(requestedPage) || 1), totalPages);
  const fromIndex = pageSize === "all" ? 0 : (page - 1) * numericSize;
  const toIndex = pageSize === "all" ? totalRows : Math.min(totalRows, fromIndex + numericSize);
  return {
    page,
    totalPages,
    fromIndex,
    toIndex,
    shownFrom: totalRows ? fromIndex + 1 : 0,
    shownTo: toIndex
  };
}
