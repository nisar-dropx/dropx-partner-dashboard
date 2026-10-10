import { matchNames } from "./name-match.ts";
import type { PaymentAllocationHistoryEntry } from "./payment-allocation-history.ts";
import type { ProductionThresholdConfig } from "./production-threshold-config.ts";

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
  productionThresholdConfig: ProductionThresholdConfig | null;
  productionThresholdMinimumUnits: string;
  effectiveFrom: string;
  effectiveTo: string;
  mappedProviderMemberId: string;
  locationLabel: string;
  profileStationId?: string;
  profileLocationLabel?: string;
  onboardingStatus: string;
};

export type ProviderFirstMappingRowView = {
  region?: string;
  clusterKeys?: string[];
  outboundMonths?: string[];
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
  productionThresholdConfig: ProductionThresholdConfig | null;
  productionThresholdMinimumUnits: string;
  effectiveFrom: string;
  effectiveTo: string;
  history: PaymentAllocationHistoryEntry[];
};

export type ProviderFirstMappingReplacement = {
  kind: "owner" | "location";
  allowKeepAll?: boolean;
  mappingId: string;
  providerMemberId: string;
  providerMemberName: string;
  existingDropxId: string;
  existingDropxName: string;
  existingLocationLabel?: string;
  newLocationLabel?: string;
  effectiveFrom?: string;
};

export function providerFirstMappingReplacement(
  previous: ProviderFirstMappingRowView,
  next: ProviderFirstMappingRowView
): ProviderFirstMappingReplacement | null {
  if (!previous.mappingId || !previous.workforceId || !next.workforceId || previous.workforceId === next.workforceId) return null;
  return {
    kind: "owner",
    mappingId: previous.mappingId,
    providerMemberId: previous.providerMemberId,
    providerMemberName: previous.providerMemberName,
    existingDropxId: previous.dropxId,
    existingDropxName: previous.dropxName
  };
}

export function providerFirstLocationRemap(
  row: ProviderFirstMappingRowView,
  worker: ProviderFirstWorkerView | undefined
): ProviderFirstMappingReplacement | null {
  if (!worker
    || !row.workforceId
    || row.workforceId !== worker.id
    || !worker.mappingId
    || row.mappingId !== worker.mappingId
    || worker.stationId === row.stationId
    || worker.providerId !== row.providerId
    || !sameProviderMember(worker.mappedProviderMemberId, row.providerMemberId)) {
    return null;
  }
  return {
    kind: "location",
    mappingId: worker.mappingId,
    providerMemberId: row.providerMemberId,
    providerMemberName: row.providerMemberName,
    existingDropxId: worker.dropxId,
    existingDropxName: worker.fullName,
    existingLocationLabel: worker.locationLabel,
    newLocationLabel: row.stationLabel,
    effectiveFrom: row.effectiveFrom
  };
}

export function providerFirstMappingReplacementMessage(replacement: ProviderFirstMappingReplacement) {
  if (replacement.kind === "location") {
    return `Provider ID ${replacement.providerMemberId} - ${replacement.providerMemberName} is currently mapped to ${replacement.existingDropxId} - ${replacement.existingDropxName} at ${replacement.existingLocationLabel ?? "the current location"}.\nMove it to ${replacement.newLocationLabel ?? "the selected location"}, or keep both location mappings for the same DropX ID?\nMoving ends the old location on the preceding day. Keep all preserves both locations.`;
  }
  return `Provider ID ${replacement.providerMemberId} - ${replacement.providerMemberName} already mapped to ${replacement.existingDropxId} - ${replacement.existingDropxName}.\nDo you want to replace this mapping?`;
}

export type ProviderFirstPaymentMethodView = {
  id: string;
  components: Array<{ code: string; label: string }>;
  productionThresholdConfig?: ProductionThresholdConfig | null;
};

export type ProviderFirstFilters = {
  regions?: string[];
  clusterKeys?: string[];
  outboundMonths?: string[];
  query: string;
  stationIds: string[];
  paymentMethodIds: string[];
  mappingStatuses: string[];
  validationStatuses: string[];
};

export type ProviderFirstPageSize = 50 | 100 | 500 | 1000 | "all";

export function providerFirstScopeOptions(
  rows: ProviderFirstMappingRowView[],
  regions: string[],
  clusterKeys: string[],
  clusterOptions: Array<{ value: string; label: string }>
) {
  const regionRows = rows.filter((row) => !regions.length || regions.includes(row.region || "Unassigned"));
  const validClusters = new Set(regionRows.flatMap((row) => row.clusterKeys ?? []));
  const locationRows = regionRows.filter((row) => !clusterKeys.length || clusterKeys.some((key) => row.clusterKeys?.includes(key)));
  return {
    clusters: clusterOptions.filter((option) => validClusters.has(option.value)),
    stations: [...new Map(locationRows.map((row) => [row.stationId, row.stationLabel])).entries()]
  };
}

const SCIENTIFIC_ID_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/;

export type ProviderFirstSourceMember = {
  providerMemberId: string;
  providerMemberName: string;
  stationCode: string;
  workDate?: string;
  shipmentMonths?: string[];
  outboundMonths?: string[];
};

export function isScientificProviderMemberId(value: string) {
  return SCIENTIFIC_ID_PATTERN.test(String(value ?? "").trim());
}

export function providerMemberIdFromSpreadsheetCells(formattedValue: unknown, rawValue: unknown) {
  const formattedId = String(formattedValue ?? "").trim();
  const rawId = String(rawValue ?? "").trim();
  return {
    providerMemberId: typeof rawValue === "number" && isScientificProviderMemberId(formattedId)
      ? rawId
      : formattedId || rawId,
    providerMemberIdUnsafeNumber: typeof rawValue === "number"
      && (!Number.isSafeInteger(rawValue) || Math.abs(rawValue) >= 1_000_000_000_000_000)
  };
}

export function providerSourceMemberKey(stationCode: string, providerMemberId: string) {
  return `${String(stationCode ?? "").trim().toUpperCase()}|${String(providerMemberId ?? "").trim().toUpperCase()}`;
}

export function scientificProviderIdCouldRepresent(scientificId: string, exactId: string) {
  const source = String(scientificId ?? "").trim();
  const exact = String(exactId ?? "").trim();
  if (source.length > 128 || exact.length > 128) return false;
  const match = source.match(SCIENTIFIC_ID_PATTERN);
  if (!match || !/^\d+$/.test(exact) || match[1] === "-") return false;
  const [, , whole, fraction = "", exponentText] = match;
  const exponent = Number(exponentText);
  const scale = exponent - fraction.length;
  if (!Number.isSafeInteger(exponent) || scale < 0 || scale > 64) return false;
  const mantissaDigits = `${whole}${fraction}`;
  if (!/^\d+$/.test(mantissaDigits) || mantissaDigits.replace(/^0+/, "").length < 6) return false;

  try {
    const quantum = BigInt(`1${"0".repeat(scale)}`);
    const center = BigInt(mantissaDigits) * quantum;
    const candidate = BigInt(exact);
    const distance = candidate >= center ? candidate - center : center - candidate;
    return distance * BigInt(2) < quantum;
  } catch {
    return false;
  }
}

function providerSourceIdentity(member: ProviderFirstSourceMember) {
  const station = String(member.stationCode ?? "").trim().toUpperCase();
  const name = String(member.providerMemberName ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  return name ? `${station}|${name}` : `${station}|ID:${String(member.providerMemberId ?? "").trim().toUpperCase()}`;
}

/**
 * Old shipment files sometimes stored a rounded scientific value instead of
 * the provider's real member ID. When the same station and holder name also
 * has one compatible, unambiguous full ID, keep that full-ID record and suppress the
 * rounded duplicate. If no exact record exists (or more than one exists), keep
 * the source rows unchanged instead of inventing an ID from rounded digits.
 */
export function canonicalizeProviderFirstMembers<T extends ProviderFirstSourceMember>(
  members: T[],
  protectedSourceKeys: ReadonlySet<string> = new Set()
) {
  const groups = new Map<string, T[]>();
  for (const member of members) {
    const key = providerSourceIdentity(member);
    const group = groups.get(key);
    if (group) group.push(member);
    else groups.set(key, [member]);
  }

  const canonical: T[] = [];
  for (const group of groups.values()) {
    const exactMembers = group.filter((member) => !isScientificProviderMemberId(member.providerMemberId));
    const scientificMembers = group.filter((member) => isScientificProviderMemberId(member.providerMemberId));
    if (!exactMembers.length || !scientificMembers.length) {
      canonical.push(...group);
      continue;
    }

    const newestExactById = new Map<string, T>();
    for (const member of exactMembers) {
      const id = String(member.providerMemberId ?? "").trim().toUpperCase();
      const current = newestExactById.get(id);
      if (!current || String(member.workDate ?? "").localeCompare(String(current.workDate ?? "")) > 0) {
        newestExactById.set(id, member);
      }
    }
    const canonicalExactMembers = Array.from(newestExactById.values());
    const unresolvedScientific = scientificMembers.filter((member) => {
      const matches = canonicalExactMembers.filter((candidate) => scientificProviderIdCouldRepresent(member.providerMemberId, candidate.providerMemberId));
      if (protectedSourceKeys.has(providerSourceMemberKey(member.stationCode, member.providerMemberId))
        || protectedSourceKeys.has(providerSourceMemberKey("*", member.providerMemberId))
        || matches.length !== 1) return true;
      // Keep historical activity when an old rounded ID is suppressed in favour
      // of its unambiguous full ID. Do not merge ambiguous or protected mappings.
      const position = canonicalExactMembers.indexOf(matches[0]);
      const exact = canonicalExactMembers[position];
      canonicalExactMembers[position] = {
        ...exact,
        ...(member.shipmentMonths ? { shipmentMonths: [...new Set([...(exact.shipmentMonths ?? []), ...member.shipmentMonths])] } : {}),
        ...(member.outboundMonths ? { outboundMonths: [...new Set([...(exact.outboundMonths ?? []), ...member.outboundMonths])] } : {})
      };
      return false;
    });
    canonical.push(...canonicalExactMembers, ...unresolvedScientific);
  }
  return canonical;
}

export function providerMemberKey(stationId: string, providerMemberId: string) {
  return `${String(stationId ?? "").trim()}|${String(providerMemberId ?? "").trim().toUpperCase()}`;
}

function sameProviderMember(left: string, right: string) {
  return String(left ?? "").trim().toUpperCase() === String(right ?? "").trim().toUpperCase();
}

function providerHolderName(value: string) {
  return String(value ?? "").split(/[|/]/, 1)[0].trim().slice(0, 200);
}

function providerNameTokens(value: string) {
  return providerHolderName(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, 8);
}

function commonPrefixLength(left: string, right: string) {
  const limit = Math.min(left.length, right.length);
  let length = 0;
  while (length < limit && left[length] === right[length]) length += 1;
  return length;
}

function editDistance(left: string, right: string) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function providerSpellingVariantMatches(left: string, right: string) {
  const longest = Math.max(left.length, right.length);
  if (Math.min(left.length, right.length) < 5 || longest > 40) return false;
  if (commonPrefixLength(left, right) < 3) return false;
  const distance = editDistance(left, right);
  const allowedDistance = Math.max(1, Math.floor(longest * 0.2));
  return distance <= allowedDistance && 1 - (distance / longest) >= 0.78;
}

export function providerFirstNamesMatch(providerName: string, dropxName: string) {
  const providerHolder = providerHolderName(providerName);
  const dropxHolder = providerHolderName(dropxName);
  if (matchNames(providerHolder, dropxHolder).status !== "none") return true;

  const providerTokens = providerNameTokens(providerHolder);
  const dropxTokens = providerNameTokens(dropxHolder);
  if (providerTokens.length < 2 || providerTokens.length !== dropxTokens.length) return false;
  return providerTokens.every((token, index) => providerSpellingVariantMatches(token, dropxTokens[index]));
}

export function providerFirstRowIssue(
  row: ProviderFirstMappingRowView,
  worker: ProviderFirstWorkerView | undefined,
  method: ProviderFirstPaymentMethodView | undefined
) {
  if (isScientificProviderMemberId(row.providerMemberId)) return "The imported Provider Member ID is rounded. Reimport a report containing the full ID.";
  if (!row.workforceId) return row.mappingId ? null : "Select a DropX workforce ID.";
  if (!worker) return "The selected DropX workforce ID is unavailable.";
  if (worker.stationId !== row.stationId && !providerFirstLocationRemap(row, worker)) return "Location mismatch.";
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
  const productionThresholdConfig = row.productionThresholdConfig ?? method.productionThresholdConfig;
  if (productionThresholdConfig) {
    const raw = row.productionThresholdMinimumUnits.trim();
    const minimumUnits = Number(raw);
    if (!raw || !Number.isInteger(minimumUnits) || minimumUnits <= 0) {
      return `Combined minimum per ${productionThresholdConfig.period} must be a positive whole number.`;
    }
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
      && (!filters.outboundMonths?.length || filters.outboundMonths.some((month) => row.outboundMonths?.includes(month)))
      && (!filters.regions?.length || filters.regions.includes(row.region || "Unassigned"))
      && (!filters.clusterKeys?.length || filters.clusterKeys.some((key) => row.clusterKeys?.includes(key)))
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

/** Month/year labels keep the same calendar month in different years distinct. */
export function providerMappingMonthOptions(months: string[]) {
  return [...new Set(months)].filter((month) => /^\d{4}-(0[1-9]|1[0-2])$/.test(month)).sort().reverse().map((value) => {
    const label = new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}-01T00:00:00Z`));
    return { value, label, searchText: `${label} ${value}` };
  });
}
