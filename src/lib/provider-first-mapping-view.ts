import { mappingLookupToday } from "./provider-mapping-lookup.ts";
import { matchNames } from "./name-match.ts";
import type { PaymentAllocationHistoryEntry } from "./payment-allocation-history.ts";
import type { ProductionThresholdConfig } from "./production-threshold-config.ts";

export type ProviderFirstRegisteredMappingView = {
  mappingId: string;
  stationId: string;
  locationLabel: string;
  providerId: string;
  mappedProviderMemberId: string;
  paymentMethodId: string;
  paymentValues: Record<string, string>;
  productionThresholdConfig: ProductionThresholdConfig | null;
  productionThresholdMinimumUnits: string;
  effectiveFrom: string;
  effectiveTo: string;
  status?: "active" | "closed";
};

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
  currentMappings?: ProviderFirstRegisteredMappingView[];
  mappingHistory?: ProviderFirstRegisteredMappingView[];
  registeredLocationMappings?: ProviderFirstRegisteredMappingView[];
  registeredLocationMapping?: ProviderFirstRegisteredMappingView;
  onboardingStatus: string;
  hasRestrictedMapping?: boolean;
};

export type ProviderFirstMappingRowView = {
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
  relatedStationIds?: string[];
};

export type MappingStationTopology = { id: string; parent_station_id?: string | null; provider_id?: string | null; modelCode: string };

export type ProviderFirstWorkerSelectionIndex = {
  occupiedIdentityKeysByWorkerId: ReadonlyMap<string, ReadonlySet<string>>;
  draftIdentityKeysByWorkerId: ReadonlyMap<string, ReadonlySet<string>>;
};

/** Only the configured XPT/parent family shares associates; names/codes are not relationships. */
export function providerMappingStationFamily(stationId: string, stations: MappingStationTopology[]) {
  const station = stations.find((item) => item.id === stationId);
  if (!station) return [stationId];
  const parentId = station.modelCode.toUpperCase() === "XPT" && station.parent_station_id
    ? station.parent_station_id : station.id;
  return stations.filter((item) => item.provider_id === station.provider_id && (
    item.id === stationId || item.id === parentId
    || (item.modelCode.toUpperCase() === "XPT" && item.parent_station_id === parentId)
  )).map((item) => item.id);
}

/**
 * Preserve the selected value and hide only choices that are unavailable
 * because of a restricted or conflicting mapping. Location compatibility is
 * validated after selection so every account-authorized associate remains
 * searchable, including the registered-location exception workflow.
 */
function providerFirstSelectionIdentity(providerId: string, providerMemberId: string) {
  return `${providerId}\u0000${providerMemberKey("", providerMemberId)}`;
}

/**
 * Builds the assignment-conflict evidence once for a worksheet render. Without
 * this index every visible row scans every worker and then every draft row,
 * which makes typing in the worksheet search quadratic on large companies.
 */
export function buildProviderFirstWorkerSelectionIndex(
  workers: ProviderFirstWorkerView[],
  drafts: ProviderFirstMappingRowView[],
  today = mappingLookupToday()
): ProviderFirstWorkerSelectionIndex {
  const occupiedIdentityKeysByWorkerId = new Map<string, Set<string>>();
  for (const worker of workers) {
    const occupied = [
      ...currentWorkerMappings(worker),
      ...(worker.mappingHistory ?? []).filter((item) => item.status === "closed" && item.effectiveTo >= today)
    ];
    occupiedIdentityKeysByWorkerId.set(worker.id, new Set(occupied.map((item) => (
      providerFirstSelectionIdentity(item.providerId, item.mappedProviderMemberId)
    ))));
  }

  const draftIdentityKeysByWorkerId = new Map<string, Set<string>>();
  for (const draft of drafts) {
    if (!draft.workforceId) continue;
    const identities = draftIdentityKeysByWorkerId.get(draft.workforceId) ?? new Set<string>();
    identities.add(providerFirstSelectionIdentity(draft.providerId, draft.providerMemberId));
    draftIdentityKeysByWorkerId.set(draft.workforceId, identities);
  }
  return { occupiedIdentityKeysByWorkerId, draftIdentityKeysByWorkerId };
}

export function providerFirstWorkerIsSelectable(
  row: ProviderFirstMappingRowView,
  worker: ProviderFirstWorkerView,
  drafts: ProviderFirstMappingRowView[] = [],
  selectionIndex?: ProviderFirstWorkerSelectionIndex
) {
  if (row.workforceId === worker.id) return true;
  if (worker.hasRestrictedMapping) return false;
  const targetIdentityKey = providerFirstSelectionIdentity(row.providerId, row.providerMemberId);
  if (selectionIndex) {
    const occupiedIdentities = selectionIndex.occupiedIdentityKeysByWorkerId.get(worker.id);
    if (occupiedIdentities
      && (occupiedIdentities.size > 1 || (occupiedIdentities.size === 1 && !occupiedIdentities.has(targetIdentityKey)))) return false;
    const draftIdentities = selectionIndex.draftIdentityKeysByWorkerId.get(worker.id);
    if (draftIdentities
      && (draftIdentities.size > 1 || (draftIdentities.size === 1 && !draftIdentities.has(targetIdentityKey)))) return false;
    return true;
  }
  const identityMatches = (providerId: string, memberId: string) => (
    providerFirstSelectionIdentity(providerId, memberId) === targetIdentityKey
  );
  const occupied = [...currentWorkerMappings(worker), ...(worker.mappingHistory ?? []).filter(item => item.status === "closed" && item.effectiveTo >= mappingLookupToday())];
  if (occupied.some((item) => !identityMatches(item.providerId, item.mappedProviderMemberId))) return false;
  if (drafts.some((item) => item !== row && item.workforceId === worker.id
    && !identityMatches(item.providerId, item.providerMemberId))) return false;
  return true;
}

export type ProviderFirstMappingReplacement = {
  kind: "owner" | "location";
  allowKeepAll?: boolean;
  allowMove?: boolean;
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
  const reference = providerFirstMappingReferenceForRow(row, worker);
  if (!worker
    || !reference
    || !isIsoCalendarDate(row.effectiveFrom)
    || !row.workforceId
    || row.workforceId !== worker.id
    || !reference.mappingId
    || (row.mappingId && row.mappingId !== reference.mappingId)
    || reference.stationId === row.stationId
    // A future mapping is valid evidence when its own start date is being
    // edited at the same location, but it can never be the source of an
    // earlier cross-location move. Relocation starts at Effective from; the
    // source mapping must already exist on that date.
    || reference.effectiveFrom > row.effectiveFrom
    || reference.providerId !== row.providerId
    || !sameProviderMember(reference.mappedProviderMemberId, row.providerMemberId)
    || !providerFirstLocationIsAllowed(row, worker)) {
    return null;
  }
  const movesToRegisteredLocation = row.stationId === String(worker.profileStationId ?? "").trim();
  return {
    kind: "location",
    // The same owner can either move the mapping or keep both locations when
    // restoring the registered-location mapping. The database records the
    // concurrent period explicitly, without changing the older mapping ID or
    // its effective-date history.
    allowKeepAll: true,
    allowMove: movesToRegisteredLocation,
    mappingId: reference.mappingId,
    providerMemberId: row.providerMemberId,
    providerMemberName: row.providerMemberName,
    existingDropxId: worker.dropxId,
    existingDropxName: worker.fullName,
    existingLocationLabel: reference.locationLabel,
    newLocationLabel: row.stationLabel,
    effectiveFrom: row.effectiveFrom
  };
}

function isIsoCalendarDate(value: string) {
  const match = String(value ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

/**
 * Returns true only when one stored mapping covers the complete requested
 * mapping interval. Blank end dates represent an open-ended interval, so a
 * historical (closed) registered-location mapping can never authorize an
 * open-ended additional-location mapping.
 */
export function providerFirstMappingPeriodContains(
  anchorEffectiveFrom: string,
  anchorEffectiveTo: string,
  requestedEffectiveFrom: string,
  requestedEffectiveTo: string
) {
  const anchorFrom = String(anchorEffectiveFrom ?? "").trim();
  const anchorTo = String(anchorEffectiveTo ?? "").trim();
  const requestedFrom = String(requestedEffectiveFrom ?? "").trim();
  const requestedTo = String(requestedEffectiveTo ?? "").trim();
  if (!isIsoCalendarDate(anchorFrom) || !isIsoCalendarDate(requestedFrom)) return false;
  if (anchorTo && !isIsoCalendarDate(anchorTo)) return false;
  if (requestedTo && !isIsoCalendarDate(requestedTo)) return false;
  if (anchorTo && anchorTo < anchorFrom) return false;
  if (requestedTo && requestedTo < requestedFrom) return false;
  if (anchorFrom > requestedFrom) return false;
  if (!anchorTo) return true;
  return Boolean(requestedTo) && requestedTo <= anchorTo;
}

function primaryWorkerMapping(worker: ProviderFirstWorkerView): ProviderFirstRegisteredMappingView | undefined {
  if (!worker.mappingId || worker.effectiveTo) return undefined;
  return {
    mappingId: worker.mappingId,
    stationId: worker.stationId,
    locationLabel: worker.locationLabel,
    providerId: worker.providerId,
    mappedProviderMemberId: worker.mappedProviderMemberId,
    paymentMethodId: worker.paymentMethodId,
    paymentValues: worker.paymentValues,
    productionThresholdConfig: worker.productionThresholdConfig,
    productionThresholdMinimumUnits: worker.productionThresholdMinimumUnits,
    effectiveFrom: worker.effectiveFrom,
    effectiveTo: worker.effectiveTo,
    status: "active"
  };
}

function currentWorkerMappings(worker: ProviderFirstWorkerView) {
  const mappings = (worker.currentMappings ?? []).filter((mapping) => mapping.status === "active" && !mapping.effectiveTo);
  const primary = primaryWorkerMapping(worker);
  if (primary && !mappings.some((mapping) => mapping.mappingId === primary.mappingId)) {
    return [primary, ...mappings];
  }
  return mappings;
}

function registeredWorkerMappings(worker: ProviderFirstWorkerView) {
  const registeredStationId = String(worker.profileStationId ?? "").trim();
  const suppliedMappings = worker.registeredLocationMappings?.length
    ? worker.registeredLocationMappings
    : worker.registeredLocationMapping
      ? [worker.registeredLocationMapping]
      : [];
  const mappings = suppliedMappings.filter((mapping) =>
    (mapping.status === "active" && !mapping.effectiveTo)
      || (mapping.status === "closed" && Boolean(mapping.effectiveTo))
  );
  const primary = primaryWorkerMapping(worker);
  if (primary?.stationId === registeredStationId && !mappings.some((mapping) => mapping.mappingId === primary.mappingId)) {
    return [...mappings, primary];
  }
  return mappings;
}

function historicalWorkerMappings(worker: ProviderFirstWorkerView) {
  const supplied = [
    ...(worker.mappingHistory ?? []),
    ...(worker.registeredLocationMappings ?? []),
    ...(worker.registeredLocationMapping ? [worker.registeredLocationMapping] : []),
    ...(worker.currentMappings ?? [])
  ];
  return supplied.filter((mapping) =>
    (mapping.status === "active" && !mapping.effectiveTo)
      || (mapping.status === "closed" && Boolean(mapping.effectiveTo))
  ).filter((mapping, index, mappings) => mappings.findIndex((candidate) => candidate.mappingId === mapping.mappingId) === index);
}

function mappingIdentityMatchesRow(
  mapping: Pick<ProviderFirstRegisteredMappingView, "providerId" | "mappedProviderMemberId">,
  row: Pick<ProviderFirstMappingRowView, "providerId" | "providerMemberId">
) {
  return mapping.providerId === row.providerId
    && sameProviderMember(mapping.mappedProviderMemberId, row.providerMemberId);
}

function mappingPeriodContainsRow(
  mapping: Pick<ProviderFirstRegisteredMappingView, "effectiveFrom" | "effectiveTo">,
  row: Pick<ProviderFirstMappingRowView, "effectiveFrom" | "effectiveTo">
) {
  return providerFirstMappingPeriodContains(
    mapping.effectiveFrom,
    mapping.effectiveTo,
    row.effectiveFrom,
    row.effectiveTo
  );
}

/**
 * Select the exact current mapping that exists on a relocation's start date.
 * More than one location may be open after Keep all, so input/query order must
 * never decide which mapping Move will close. The latest mapping that already
 * exists on the requested date is the deterministic source. If every mapping
 * starts later, retain the earliest future mapping only as UI evidence; the
 * relocation guard will prevent using it before its own effective date.
 */
function currentMappingForRelocation(
  mappings: ProviderFirstRegisteredMappingView[],
  row: Pick<ProviderFirstMappingRowView, "effectiveFrom" | "effectiveTo">
) {
  const requestedFrom = String(row.effectiveFrom ?? "").trim();
  const candidates = [...mappings].sort((left, right) =>
    right.effectiveFrom.localeCompare(left.effectiveFrom)
      || right.mappingId.localeCompare(left.mappingId)
  );
  if (!isIsoCalendarDate(requestedFrom)) return candidates[0];
  const effective = candidates.find((mapping) =>
    isIsoCalendarDate(mapping.effectiveFrom) && mapping.effectiveFrom <= requestedFrom
  );
  if (effective) return effective;
  const futureCandidates = candidates.sort((left, right) =>
    left.effectiveFrom.localeCompare(right.effectiveFrom)
      || left.mappingId.localeCompare(right.mappingId)
  );
  // A bounded earlier row is a new historical interval only when it ends
  // before every later scheduled mapping. If a future mapping starts inside
  // the requested interval, keep it as the overlapping edit reference.
  const requestedTo = String(row.effectiveTo ?? "").trim();
  if (isIsoCalendarDate(requestedTo)) {
    return futureCandidates.find((mapping) =>
      isIsoCalendarDate(mapping.effectiveFrom) && mapping.effectiveFrom <= requestedTo
    );
  }
  // For an open-ended relocation, retain the earliest future mapping only as
  // conflict evidence so the effective-date guard can explain why it cannot be
  // moved yet.
  return futureCandidates[0];
}

/** A previous rate card is a user-selected template, never a new assignment's dates or edit ID. */
export function providerFirstPaymentTemplateForRow(row: ProviderFirstMappingRowView, worker: ProviderFirstWorkerView | undefined) {
  if (!worker || worker.id !== row.workforceId) return undefined;
  const allowedStations = row.relatedStationIds ?? [row.stationId];
  return [...historicalWorkerMappings(worker), ...currentWorkerMappings(worker)]
    .filter(mapping => mapping.paymentMethodId && mapping.effectiveFrom <= mappingLookupToday()
      && mappingIdentityMatchesRow(mapping, row) && allowedStations.includes(mapping.stationId))
    .sort((a, b) => Number(b.stationId === row.stationId) - Number(a.stationId === row.stationId)
      || b.effectiveFrom.localeCompare(a.effectiveFrom) || b.mappingId.localeCompare(a.mappingId))[0];
}

/** Selects the exact stored mapping that should supply dates/rates and anchor a save. */
export function providerFirstMappingReferenceForRow(
  row: ProviderFirstMappingRowView,
  worker: ProviderFirstWorkerView | undefined
) {
  if (!worker) return undefined;
  const currentMappings = currentWorkerMappings(worker);
  const mappingHistory = historicalWorkerMappings(worker);
  const registeredStationId = String(worker.profileStationId ?? "").trim();
  const registered = registeredWorkerMappings(worker).filter((mapping) =>
    mapping.mappingId
      && mapping.stationId === registeredStationId
      && mappingIdentityMatchesRow(mapping, row)
  );
  const registeredForPeriod = registered.find((mapping) => mappingPeriodContainsRow(mapping, row));
  const currentAtDestination = currentMappings.filter((mapping) => mapping.stationId === row.stationId);
  const currentForPeriod = currentAtDestination.find((mapping) =>
    mappingIdentityMatchesRow(mapping, row) && mappingPeriodContainsRow(mapping, row)
  );

  // A closed row remains the explicit edit target after its end date is
  // cleared or extended. Without this, changing 01-30 Sep to 01 Sep-open
  // drops mappingId and the save is misclassified as a new overlapping row.
  // The database payment/publication guards still decide whether that stored
  // period is financially unlocked and therefore editable.
  const selectedClosedMapping = mappingHistory.find((mapping) =>
    mapping.mappingId === row.mappingId
      && mapping.status === "closed"
      && Boolean(mapping.effectiveTo)
      && mapping.stationId === row.stationId
      && mapping.effectiveFrom === row.effectiveFrom
      && mappingIdentityMatchesRow(mapping, row)
  );
  if (selectedClosedMapping) return selectedClosedMapping;

  // An existing current row remains the edit target only when its identity and
  // period actually cover the row. A later current mapping must not hide the
  // exact historical registered-location anchor for an earlier bounded row.
  if (currentForPeriod) return currentForPeriod;
  if (registeredForPeriod) return registeredForPeriod;

  // Before dates have been chosen, use the newest exact registered anchor as
  // the template. Once dates exist, never silently reuse a non-containing
  // anchor; the row must fail validation until a covering interval is chosen.
  if (!row.effectiveFrom) {
    const closedAtDestination = mappingHistory.find((mapping) =>
      mapping.status === "closed"
        && Boolean(mapping.effectiveTo)
        && mapping.stationId === row.stationId
        && mappingIdentityMatchesRow(mapping, row)
    );
    if (closedAtDestination) return closedAtDestination;
    if (registered.length) return registered[0];
  }

  // Preserve a conflicting current destination mapping as evidence so the UI
  // can report its provider/member conflict instead of treating the ID as free.
  const conflictingCurrent = currentAtDestination.find((mapping) => !mappingIdentityMatchesRow(mapping, row));
  if (conflictingCurrent) return conflictingCurrent;

  // Moving a matching active mapping back to the profile's registered station
  // remains the ordinary correction path. Do not reuse a future mapping as the
  // edit ID for an earlier bounded period; that period is a new historical row.
  if (row.stationId === registeredStationId) {
    return currentMappingForRelocation(
      currentMappings.filter((mapping) => mappingIdentityMatchesRow(mapping, row)),
      row
    );
  }
  return undefined;
}

/**
 * When period edits select another historical anchor, switch all stored
 * mapping-owned values together. User-entered dates remain unchanged so a
 * narrower interval within the selected anchor is preserved.
 */
export function providerFirstRowForMappingPeriod(
  row: ProviderFirstMappingRowView,
  worker: ProviderFirstWorkerView | undefined
): ProviderFirstMappingRowView {
  const reference = providerFirstMappingReferenceForRow(row, worker);
  if (!reference) {
    // A brand-new row has no stored mapping-owned state to invalidate. Preserve
    // manual method/rate entry while its dates are being composed.
    if (!row.mappingId) return row;
    return {
      ...row,
      mappingId: "",
      paymentMethodId: "",
      paymentValues: {},
      productionThresholdConfig: null,
      productionThresholdMinimumUnits: ""
    };
  }
  if (reference.mappingId === row.mappingId) return row;
  return {
    ...row,
    mappingId: reference.mappingId,
    paymentMethodId: reference.paymentMethodId,
    paymentValues: reference.paymentValues,
    productionThresholdConfig: reference.productionThresholdConfig,
    productionThresholdMinimumUnits: reference.productionThresholdMinimumUnits
  };
}

/** A cross-location anchor cannot validate a period until the user supplies dates. */
export function providerFirstLocationNeedsDates(
  row: ProviderFirstMappingRowView,
  worker: ProviderFirstWorkerView | undefined
) {
  if (!worker || worker.id !== row.workforceId || row.effectiveFrom
    || !worker.profileStationId) return false;
  const anchors = row.stationId === worker.profileStationId
    ? currentWorkerMappings(worker).filter((mapping) => mapping.stationId !== row.stationId)
    : registeredWorkerMappings(worker);
  return anchors.some((mapping) =>
    Boolean(mapping.mappingId) && mappingIdentityMatchesRow(mapping, row)
  );
}

/**
 * A Provider ID may be retained at a second location only when the selected
 * DropX profile already has that exact provider/member identity mapped at its
 * registered location. Moving an older mapping into the profile's registered
 * location remains valid as the normal location-correction path.
 *
 * This client-side check is only for worksheet feedback. The action and the
 * database repeat the same invariant against current stored mappings.
 */
export function providerFirstLocationIsAllowed(
  row: ProviderFirstMappingRowView,
  worker: ProviderFirstWorkerView | undefined
) {
  if (!worker) return false;
  if (!row.workforceId
    || row.workforceId !== worker.id) {
    return false;
  }
  const registeredStationId = String(worker.profileStationId ?? "").trim();
  if (!registeredStationId) return false;
  const currentMappings = currentWorkerMappings(worker);
  const selectedClosedMapping = historicalWorkerMappings(worker).find((mapping) =>
    mapping.mappingId === row.mappingId
      && mapping.status === "closed"
      && Boolean(mapping.effectiveTo)
      && mapping.stationId === row.stationId
      && mapping.effectiveFrom === row.effectiveFrom
      && mappingIdentityMatchesRow(mapping, row)
  );
  if (selectedClosedMapping) return true;
  if (row.stationId === registeredStationId) {
    // An unmapped profile may be bootstrapped at its own location. If a current
    // mapping exists, an exact historical interval wins over an unrelated
    // later current mapping; otherwise this must remain the same identity.
    const historicalMatch = registeredWorkerMappings(worker).some((mapping) =>
      mappingIdentityMatchesRow(mapping, row) && mappingPeriodContainsRow(mapping, row)
    );
    if (historicalMatch || !currentMappings.length) return true;
    if (!currentMappings.every((mapping) => mappingIdentityMatchesRow(mapping, row))) return false;
    // Editing a mapping already at the destination may change its own start
    // date. A cross-location relocation is different: its source must have
    // started by the requested move date, otherwise that future location is
    // being used outside its effective period.
    return currentMappings.some((mapping) => mapping.stationId === row.stationId)
      || currentMappings.some((mapping) => isIsoCalendarDate(row.effectiveFrom)
        && mapping.effectiveFrom <= row.effectiveFrom);
  }
  return registeredWorkerMappings(worker).some((mapping) =>
    Boolean(mapping.mappingId)
      && mapping.stationId === registeredStationId
      && mappingIdentityMatchesRow(mapping, row)
      && mappingPeriodContainsRow(mapping, row)
  );
}

export function providerFirstMappingReplacementMessage(replacement: ProviderFirstMappingReplacement) {
  if (replacement.kind === "location") {
    const starts = replacement.effectiveFrom
      ? ` from ${replacement.effectiveFrom}`
      : "";
    if (replacement.allowMove === false) {
      return `Provider ID ${replacement.providerMemberId} - ${replacement.providerMemberName} is already mapped to ${replacement.existingDropxId} - ${replacement.existingDropxName} at its registered location ${replacement.existingLocationLabel ?? "the current location"}.\nUse Keep all to add ${replacement.newLocationLabel ?? "the selected location"}${starts} for the same DropX ID while preserving the verified registered-location mapping for that period.`;
    }
    if (replacement.allowKeepAll === false) {
      return `Provider ID ${replacement.providerMemberId} - ${replacement.providerMemberName} is currently mapped to ${replacement.existingDropxId} - ${replacement.existingDropxName} at ${replacement.existingLocationLabel ?? "the previous location"}.\nMove it to the profile's registered location ${replacement.newLocationLabel ?? "the selected location"}${starts}. The old location remains unchanged before this date and ends on the preceding day; its earlier mapping and payout history remain preserved.`;
    }
    return `Provider ID ${replacement.providerMemberId} - ${replacement.providerMemberName} is currently mapped to ${replacement.existingDropxId} - ${replacement.existingDropxName} at ${replacement.existingLocationLabel ?? "the current location"}.\nFrom ${replacement.effectiveFrom ?? "the selected effective date"}, move it to ${replacement.newLocationLabel ?? "the selected location"}, or keep both location mappings for the same DropX ID?\nMove leaves the old location unchanged before this date and ends it on the preceding day. Keep all preserves both locations from this date.`;
  }
  return `Provider ID ${replacement.providerMemberId} - ${replacement.providerMemberName} already mapped to ${replacement.existingDropxId} - ${replacement.existingDropxName}.\nDo you want to replace this mapping?`;
}

export type ProviderFirstPaymentMethodView = {
  id: string;
  components: Array<{ code: string; label: string }>;
  productionThresholdConfig?: ProductionThresholdConfig | null;
};

export type ProviderFirstFilters = {
  outboundMonths?: string[];
  query: string;
  stationIds: string[];
  paymentMethodIds: string[];
  mappingStatuses: string[];
  validationStatuses: string[];
};

export type ProviderFirstPageSize = 50 | 100 | 500 | 1000 | "all";

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

/**
 * Groups the same provider-owned identity across stations. Use this for audit
 * and payment-allocation history only: an actual provider mapping remains
 * station-specific and must continue to use providerMemberKey.
 */
export function providerMemberIdentityKey(providerId: string, providerMemberId: string) {
  return `${String(providerId ?? "").trim().toLowerCase()}|${String(providerMemberId ?? "").trim().toUpperCase()}`;
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

// A single occurrence of these high-collision name parts is not enough to
// establish provider identity. Keep spelling variants explicit so that the
// safety rule is deterministic and can be expanded from production evidence.
const COMMON_PROVIDER_NAME_TOKENS = new Set([
  "ABDUL", "AHAMAD", "AHAMED", "AHMAD", "AHMED", "ALI", "BABU", "BIBI",
  "DAS", "DEVI", "KHAN", "KUMAR", "KUMARI", "MD", "MOHAMAD", "MOHAMED",
  "MOHAMMAD", "MOHAMMED", "MOHD", "MUHAMAD", "MUHAMED", "MUHAMMAD",
  "MUHAMMED", "RAJ", "RAM", "SHAIK", "SHAIKH", "SHEIKH", "SINGH", "SK",
  "SRI"
]);

function meaningfulProviderNameTokens(tokens: string[]) {
  return tokens.filter((token) => token.length > 1 && !COMMON_PROVIDER_NAME_TOKENS.has(token));
}

function hasMeaningfulProviderNameEvidence(providerTokens: string[], dropxTokens: string[]) {
  const providerSubstantiveTokens = providerTokens.filter((token) => token.length > 1);
  const dropxSubstantiveTokens = dropxTokens.filter((token) => token.length > 1);
  if (!providerSubstantiveTokens.length || !dropxSubstantiveTokens.length) return false;

  // The relaxed rule is only for a name supplied with multiple parts. Count
  // initials here so that an exact uncommon token can establish identity for
  // names such as "Muzammil M" and "Muzammil M K". Initials remain excluded
  // from the meaningful evidence below, and fuzzy evidence still requires two
  // substantive tokens on both sides.
  const hasMultipleNameParts = providerTokens.length > 1 || dropxTokens.length > 1;
  if (!hasMultipleNameParts) return false;

  const providerMeaningfulTokens = meaningfulProviderNameTokens(providerTokens);
  const dropxMeaningfulTokens = meaningfulProviderNameTokens(dropxTokens);
  for (const providerToken of providerMeaningfulTokens) {
    for (const dropxToken of dropxMeaningfulTokens) {
      if (providerToken === dropxToken) return true;
      // Fuzzy matching remains limited to cases where both supplied names are
      // multi-part, preventing a lone approximate token from authorizing a map.
      if (
        providerSubstantiveTokens.length > 1
        && dropxSubstantiveTokens.length > 1
        && providerSpellingVariantMatches(providerToken, dropxToken)
      ) return true;
    }
  }
  return false;
}

export function providerFirstNamesMatch(providerName: string, dropxName: string) {
  const providerHolder = providerHolderName(providerName);
  const dropxHolder = providerHolderName(dropxName);
  const providerTokens = providerNameTokens(providerHolder);
  const dropxTokens = providerNameTokens(dropxHolder);
  const directMatch = matchNames(providerHolder, dropxHolder);
  if (directMatch.status === "exact") return true;
  // Initials and common names never count as the one matching identity token.
  // Extra initials therefore neither authorize nor block a match supported by
  // a meaningful full token such as THAHA.
  return hasMeaningfulProviderNameEvidence(providerTokens, dropxTokens);
}

export function providerFirstRowIssue(
  row: ProviderFirstMappingRowView,
  worker: ProviderFirstWorkerView | undefined,
  method: ProviderFirstPaymentMethodView | undefined
) {
  if (isScientificProviderMemberId(row.providerMemberId)) return "The imported Provider Member ID is rounded. Reimport a report containing the full ID.";
  if (!row.workforceId) return row.mappingId ? null : "Select a DropX workforce ID.";
  if (!worker) return "The selected DropX workforce ID is unavailable.";
  const mappingReference = providerFirstMappingReferenceForRow(row, worker);
  if (mappingReference && !mappingIdentityMatchesRow(mappingReference, row)) {
    return "This DropX ID is already mapped to another Provider or Provider Member ID.";
  }
  if (providerFirstLocationNeedsDates(row, worker)) return "Enter Effective from to validate this location against the existing mapping.";
  if (!providerFirstLocationIsAllowed(row, worker)) return "Location mismatch.";
  if (!providerFirstNamesMatch(row.providerMemberName, row.dropxName)) return "Name mismatch.";
  if (!row.providerId) return "The selected location has no provider.";
  if (!row.paymentMethodId) return "Payment method is required.";
  if (!method) return "Payment method is invalid.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.effectiveFrom)) return "Effective from is required.";
  if (row.effectiveTo && !/^\d{4}-\d{2}-\d{2}$/.test(row.effectiveTo)) return "Effective to is invalid.";
  if (row.effectiveTo && row.effectiveTo < row.effectiveFrom) return "Effective to cannot be before effective from.";
  if (row.effectiveTo && providerFirstLocationRemap(row, worker)) {
    return "Move or Keep all requires an ongoing mapping. Leave Effective to blank.";
  }

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
