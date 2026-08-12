export type CashMoney = {
  unit?: string | null;
  value?: number | null;
};

export type CashReconPendingBreakdown = {
  trackingId: string;
  paymentMethod: string;
  moneyCollectionTime: number | null;
  amount: number;
  stationTimeZone: string;
};

export type CashReconAssociate = {
  providerEmployeeId: string;
  name: string;
  displayName: string;
  employeeId: string | null;
  expected: number;
  pendingRecon: number;
  breakdown: CashReconPendingBreakdown[];
  source: "matched" | "extra" | "other" | "driver_only";
  shipmentType: string;
  /** True when ageing driver was not in getDrivers but name was resolved from workforce. */
  mappedFromWorkforce?: boolean;
};

export function isPlaceholderUnmappedName(name: string) {
  const normalizedName = name.trim().toLowerCase();
  return normalizedName.startsWith("unmapped driver")
    || normalizedName === "unassigned driver"
    || /^unmapped\s*[·•.-]/.test(normalizedName);
}

/** Workforce-resolved names (e.g. "Manesh M V") do not need ops to retype them. */
export function requiresManualDriverName(params: {
  name: string;
  shipmentType: string;
  employeeId: string;
  mappedFromWorkforce?: boolean;
}) {
  const { name, shipmentType, employeeId, mappedFromWorkforce } = params;
  if (mappedFromWorkforce && !isPlaceholderUnmappedName(name)) return false;
  const normalizedType = shipmentType.trim().toLowerCase();
  if (normalizedType.includes("workforce") && !isPlaceholderUnmappedName(name)) return false;
  if (normalizedType.includes("unmapped")) return true;
  if (isPlaceholderUnmappedName(name)) return true;
  if ((!employeeId || employeeId === "0") && name.trim().toLowerCase().startsWith("unmapped")) return true;
  return false;
}

export type CashReconDriver = {
  driverName: string;
  employeeId: number | string | null;
  store?: boolean;
  tasId: string;
};

export type ExpectedCashShipment = {
  barcode?: string | null;
  shipmentNo?: string | null;
  employeeId?: number | string | null;
  driverName?: string | null;
  paymentMethod?: string | null;
  shipmentStatus?: string | null;
  shipmentType?: string | null;
  updateDate?: string | null;
  receivableAmount?: CashMoney | null;
  receivedAmount?: CashMoney | null;
  remittanceCode?: string | null;
  reconciled?: boolean | null;
};

export type ExpectedCashByDriver = {
  employeeId?: number | string | null;
  driverName?: string | null;
  tasId?: string | null;
  /** False when ageing driverId was not in getDrivers. */
  mappedToActiveDriver?: boolean | null;
  /** True when name was resolved from workforce for a driver not in getDrivers. */
  mappedFromWorkforce?: boolean | null;
  totalReceived?: number | null;
  shipmentCount?: number | null;
  shipments?: ExpectedCashShipment[] | null;
};

export type ExpectedCashSummary = {
  totalReceived?: number | null;
  shipmentCount?: number | null;
  byDriver?: ExpectedCashByDriver[] | null;
  cashShipments?: ExpectedCashShipment[] | null;
};

export type CashReconRow = {
  store?: boolean;
  driverInfo?: { name?: string | null; id?: string | null } | null;
  providerInfo?: { name?: string | null; type?: string | null } | null;
  paymentInfo?: {
    method?: string | null;
    expected?: CashMoney | null;
    actualCash?: CashMoney | null;
    actualMpos?: CashMoney | null;
    balance?: CashMoney | null;
    variance?: CashMoney | null;
    overallPendingRecon?: CashMoney | null;
    overallPendingReconBreakdownList?: Array<{
      trackingId?: string | null;
      paymentMethod?: string | null;
      moneyCollectionTime?: number | null;
      transactionTime?: number | null;
      amount?: CashMoney | null;
      stationTimeZone?: string | null;
    }> | null;
  } | null;
};

export type DriverReconciliationNormalized = {
  status: string;
  stationCode: string;
  date: string;
  sessionSource: string | null;
  driverCount: number;
  reconciliationCount: number;
  associates: CashReconAssociate[];
  missingFromDer: CashReconAssociate[];
  /** Associates with cash-only expected (expectedCash.totalReceived) > 0 that must have saved cash before Step 2. */
  requiredForCashEntry: CashReconAssociate[];
  /** Raw worker reconciliation rows — kept for pending-recon / override UX. */
  reconciliation: CashReconRow[];
  /** Cash-only expected totals from worker (preferred over paymentInfo.expected which includes MPOS). */
  expectedCash: ExpectedCashSummary | null;
};

export type LiabilitySummaryNormalized = {
  status: string;
  stationCode: string;
  date: string;
  cashSummary: {
    expectedAmount: number;
    actualAmount: number;
    shortExcessAmount: number;
    count: number;
  };
  mposSummary: {
    amount: number;
    count: number;
  };
  check: {
    passed: boolean;
    nonZeroFields: string[];
  };
  isClear: boolean;
};

export type RemittanceMoney = {
  unit?: string | null;
  value?: number | null;
};

export type RemittanceStationVarianceItem = {
  amount: number;
  reason: string;
  type: string;
};

export type RemittanceRowNormalized = {
  remittanceCode: string;
  remittanceId: string;
  creationDate: number | null;
  lastUpdated: number | null;
  submissionDate: number | null;
  createdBy: string | null;
  submittedBy: string | null;
  status: string;
  expectedAmount: number;
  actualAmount: number;
  paymentMethod: string | null;
  variance: number;
  ttLink: string | null;
  transactionId: string | null;
  isVerified: boolean | null;
  stationVarianceList: RemittanceStationVarianceItem[];
};

export type RemittanceLedgerShipment = {
  trackingId: string;
  shipmentNo: string;
  pendingAmount: number;
  keptOnDate: string | null;
  clearedOnDate: string | null;
  keptDays: number | null;
  status: string;
  remittanceId: string | null;
  remittanceCode: string | null;
};

export type RemittanceLedgerDriver = {
  driverName: string;
  tasId: string | null;
  employeeId: string | null;
  amount: number;
  shipmentCount: number;
  shipments: RemittanceLedgerShipment[];
};

export type RemittanceLedgerDay = {
  date: string;
  expectedCashTotal: number;
  remittanceTotalCash: number;
  shortAmount: number;
  carryForwardIn: number;
  carryForwardOut: number;
  clearedSameDayAmount: number;
  forwardedAmount: number;
  stillPendingAmount: number;
  clearedFromPriorAmount: number;
  drivers: RemittanceLedgerDriver[];
};

export type RemittanceMatchSummary = {
  status: string;
  mode: string;
  windowFrom: string | null;
  windowTo: string | null;
  sameDayExpectedCashTotal: number;
  sameDayRemittanceTotalCash: number;
  sameDayShortAmount: number;
  finalPendingTotal: number;
  limitedByRemittanceWindow: boolean;
};

export type RemittanceSummaryNormalized = {
  status: string;
  stationCode: string;
  date: string;
  sessionSource: string | null;
  accountKey: string | null;
  remittanceTotalCash: number;
  created: RemittanceRowNormalized[];
  createdCount: number;
  createdTotal: number;
  submitted: RemittanceRowNormalized[];
  submittedCount: number;
  submittedTotal: number;
  remittanceCodes: string[];
  dateRange: {
    startTime: number | null;
    endTime: number | null;
  };
  matchSummary: RemittanceMatchSummary | null;
  ledger: RemittanceLedgerDay[];
};

export function moneyValue(value: CashMoney | number | string | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? Number(value.toFixed(2)) : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : 0;
  }
  if (!value || typeof value !== "object") return 0;
  const parsed = Number((value as CashMoney).value ?? 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : 0;
}

export function nearlyZero(value: number, epsilon = 0.01) {
  return Math.abs(value) < epsilon;
}

export function normalizeAssociateName(name: string) {
  return String(name ?? "")
    .split("/")[0]
    ?.replace(/\s+/g, " ")
    .trim()
    .toLowerCase() ?? "";
}

/** True when names match exactly, or one contains all tokens of the other (handles "RANJEET NAG" vs "RANJEET KUMAR NAG"). */
export function associateNamesMatch(left: string, right: string) {
  const a = normalizeAssociateName(left);
  const b = normalizeAssociateName(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const aTokens = a.split(" ").filter(Boolean);
  const bTokens = b.split(" ").filter(Boolean);
  if (aTokens.length >= 2 && aTokens.every((token) => bTokens.includes(token))) return true;
  if (bTokens.length >= 2 && bTokens.every((token) => aTokens.includes(token))) return true;
  return false;
}

export function driverDisplayName(driverName: string) {
  return String(driverName ?? "").split("/")[0]?.trim() || String(driverName ?? "").trim();
}

function mapBreakdown(list: CashReconRow["paymentInfo"]): CashReconPendingBreakdown[] {
  const rows = Array.isArray(list?.overallPendingReconBreakdownList) ? list.overallPendingReconBreakdownList : [];
  return rows.map((row) => ({
    trackingId: String(row?.trackingId ?? "").trim() || "-",
    paymentMethod: String(row?.paymentMethod ?? "").trim() || "-",
    moneyCollectionTime: typeof row?.moneyCollectionTime === "number"
      ? row.moneyCollectionTime
      : typeof row?.transactionTime === "number"
        ? row.transactionTime
        : null,
    amount: moneyValue(row?.amount),
    stationTimeZone: String(row?.stationTimeZone ?? "").trim() || "IST"
  }));
}

/** Index cash-only expected by employeeId and tasId for O(1) lookup. */
export function indexExpectedCashByDriver(expectedCash: ExpectedCashSummary | null | undefined) {
  const byEmployeeId = new Map<string, ExpectedCashByDriver>();
  const byTasId = new Map<string, ExpectedCashByDriver>();
  const rows = Array.isArray(expectedCash?.byDriver) ? expectedCash.byDriver : [];
  for (const row of rows) {
    const employeeId = String(row.employeeId ?? "").trim().toUpperCase();
    const tasId = String(row.tasId ?? "").trim().toUpperCase();
    // Skip null/empty and placeholder 0 from unmapped rows.
    if (employeeId && employeeId !== "0" && employeeId !== "NULL") byEmployeeId.set(employeeId, row);
    if (tasId) byTasId.set(tasId, row);
  }
  return { byEmployeeId, byTasId };
}

/**
 * Cash-only expected COD for a driver.
 * Prefer expectedCash.byDriver.totalReceived; fall back to recon paymentInfo.expected only when expectedCash is absent.
 */
export function resolveCashExpected(params: {
  employeeId?: string | number | null;
  tasId?: string | null;
  expectedCashIndex?: ReturnType<typeof indexExpectedCashByDriver> | null;
  hasExpectedCashPayload?: boolean;
  reconExpected?: CashMoney | number | string | null;
}): number {
  const employeeId = String(params.employeeId ?? "").trim().toUpperCase();
  const tasId = String(params.tasId ?? "").trim().toUpperCase();
  const index = params.expectedCashIndex;
  const cashRow = (employeeId && index?.byEmployeeId.get(employeeId))
    || (tasId && index?.byTasId.get(tasId))
    || null;
  if (cashRow) return moneyValue(cashRow.totalReceived);
  // When worker sent expectedCash, missing driver ⇒ cash expected 0 (do not use MPOS-inclusive recon.expected).
  if (params.hasExpectedCashPayload) return 0;
  return moneyValue(params.reconExpected);
}

function fromRecon(
  row: CashReconRow,
  source: CashReconAssociate["source"],
  drivers: CashReconDriver[] = [],
  expectedCashIndex: ReturnType<typeof indexExpectedCashByDriver> | null = null,
  hasExpectedCashPayload = false
): CashReconAssociate | null {
  const id = String(row.driverInfo?.id ?? "").trim();
  const shortName = String(row.driverInfo?.name ?? "").trim();
  const driver = id
    ? drivers.find((item) => String(item.tasId ?? "").trim().toUpperCase() === id.toUpperCase())
    : null;
  // Prefer drivers[].driverName ("Name / DROP / empId") when tasId matches driverInfo.id.
  // Prefer numeric employeeId over tasId for saved provider_employee_id.
  const name = String(driver?.driverName ?? "").trim() || shortName;
  if (!id && !name) return null;
  const employeeId = driver?.employeeId == null ? null : String(driver.employeeId).trim();
  const payment = row.paymentInfo;
  return {
    providerEmployeeId: employeeId || id || `NAME-${normalizeAssociateName(name).replace(/\s+/g, "-").toUpperCase()}`,
    name: name || id,
    displayName: name || id,
    employeeId,
    expected: resolveCashExpected({
      employeeId,
      tasId: id,
      expectedCashIndex,
      hasExpectedCashPayload,
      reconExpected: payment?.expected
    }),
    pendingRecon: moneyValue(payment?.overallPendingRecon),
    breakdown: mapBreakdown(payment),
    source,
    shipmentType: "Cash recon worker"
  };
}

export type BaselineAssociate = {
  providerEmployeeId: string;
  name: string;
};

function formatNonZeroField(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.path === "string") return record.path;
    if (typeof record.field === "string") return record.field;
    if (typeof record.name === "string") return record.name;
    if (typeof record.key === "string") return record.key;
    try {
      return JSON.stringify(value);
    } catch {
      return "unknown";
    }
  }
  return String(value);
}

export function normalizeNonZeroFields(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(formatNonZeroField).map((item) => item.trim()).filter(Boolean);
}

function findDriverForBaseline(baseline: BaselineAssociate, drivers: CashReconDriver[]) {
  const baselineId = String(baseline.providerEmployeeId ?? "").trim().toUpperCase();
  const baselineName = normalizeAssociateName(baseline.name);
  return drivers.find((driver) => {
    const employeeId = String(driver.employeeId ?? "").trim().toUpperCase();
    const tasId = String(driver.tasId ?? "").trim().toUpperCase();
    const driverName = driverDisplayName(driver.driverName);
    return (baselineId && (employeeId === baselineId || tasId === baselineId))
      || (baselineName && associateNamesMatch(baseline.name, driverName));
  }) ?? null;
}

function findReconForBaseline(
  baseline: BaselineAssociate,
  driver: CashReconDriver | null,
  reconByTasId: Map<string, CashReconRow>,
  reconByName: Map<string, CashReconRow>,
  reconciliation: CashReconRow[]
) {
  const tasId = String(driver?.tasId ?? "").trim().toUpperCase();
  if (tasId && reconByTasId.has(tasId)) return reconByTasId.get(tasId) ?? null;
  const baselineId = String(baseline.providerEmployeeId ?? "").trim().toUpperCase();
  if (baselineId && reconByTasId.has(baselineId)) return reconByTasId.get(baselineId) ?? null;
  const nameKey = normalizeAssociateName(baseline.name) || normalizeAssociateName(driverDisplayName(driver?.driverName ?? ""));
  if (nameKey && reconByName.has(nameKey)) return reconByName.get(nameKey) ?? null;
  return reconciliation.find((row) =>
    associateNamesMatch(baseline.name, String(row.driverInfo?.name ?? ""))
    || associateNamesMatch(driverDisplayName(driver?.driverName ?? ""), String(row.driverInfo?.name ?? ""))
  ) ?? null;
}

/**
 * Ageing cash rows whose driverId is not in getDrivers (or not already on Collect /
 * Missing DER) must still appear so ops can enter that cash.
 */
function appendUnmappedExpectedCash(
  associates: CashReconAssociate[],
  missingFromDer: CashReconAssociate[],
  expectedCash: ExpectedCashSummary | null
): void {
  if (!Array.isArray(expectedCash?.byDriver)) return;
  const pool = [...associates, ...missingFromDer];

  for (const cashRow of expectedCash.byDriver) {
    const expected = moneyValue(cashRow.totalReceived);
    if (expected <= 0.01) continue;

    const employeeId = String(cashRow.employeeId ?? "").trim();
    const tasId = String(cashRow.tasId ?? "").trim();
    const already = pool.find((associate) => {
      const associateId = String(associate.providerEmployeeId ?? "").trim().toUpperCase();
      const associateEmployeeId = String(associate.employeeId ?? "").trim().toUpperCase();
      return (employeeId && employeeId !== "0" && (associateId === employeeId.toUpperCase() || associateEmployeeId === employeeId.toUpperCase()))
        || (tasId && (associateId === tasId.toUpperCase() || associateEmployeeId === tasId.toUpperCase()))
        || associateNamesMatch(associate.displayName || associate.name, String(cashRow.driverName ?? ""));
    });
    if (already) {
      if (already.expected <= 0.01) already.expected = expected;
      if (cashRow.mappedFromWorkforce === true) {
        already.mappedFromWorkforce = true;
        if (!already.shipmentType.toLowerCase().includes("workforce")) {
          already.shipmentType = "Ageing cash (workforce)";
        }
      }
      continue;
    }

    // Only surface rows that were not mapped to getDrivers (or have no active-driver match).
    const isMapped = cashRow.mappedToActiveDriver === true
      || (cashRow.mappedToActiveDriver == null && Boolean(employeeId && employeeId !== "0"));
    if (isMapped) continue;

    const providerEmployeeId = (employeeId && employeeId !== "0" ? employeeId : null)
      || tasId
      || "__unassigned_cash__";
    const mappedFromWorkforce = cashRow.mappedFromWorkforce === true;
    const fullName = String(cashRow.driverName ?? "").trim()
      || (tasId ? `Unmapped driver (${tasId})` : "Unassigned driver");

    const row: CashReconAssociate = {
      providerEmployeeId,
      name: fullName,
      displayName: fullName,
      employeeId: employeeId && employeeId !== "0" ? employeeId : null,
      expected,
      pendingRecon: 0,
      breakdown: [],
      source: "extra",
      shipmentType: mappedFromWorkforce
        ? "Ageing cash (workforce)"
        : "Ageing cash (unmapped driver)",
      mappedFromWorkforce
    };
    missingFromDer.push(row);
    pool.push(row);
  }
}

export function buildCashReconAssociates(
  drivers: CashReconDriver[],
  reconciliation: CashReconRow[],
  baselineAssociates: BaselineAssociate[] = [],
  expectedCash: ExpectedCashSummary | null = null
): Pick<DriverReconciliationNormalized, "associates" | "missingFromDer"> {
  const reconByTasId = new Map<string, CashReconRow>();
  const reconByName = new Map<string, CashReconRow>();
  reconciliation.forEach((row) => {
    const id = String(row.driverInfo?.id ?? "").trim().toUpperCase();
    const nameKey = normalizeAssociateName(String(row.driverInfo?.name ?? ""));
    if (id) reconByTasId.set(id, row);
    if (nameKey && !reconByName.has(nameKey)) reconByName.set(nameKey, row);
  });

  const expectedCashIndex = indexExpectedCashByDriver(expectedCash);
  const hasExpectedCashPayload = Array.isArray(expectedCash?.byDriver);

  const cashExpectedFor = (employeeId: string | number | null | undefined, tasId: string | null | undefined, reconExpected?: CashMoney | null) =>
    resolveCashExpected({
      employeeId,
      tasId,
      expectedCashIndex,
      hasExpectedCashPayload,
      reconExpected
    });

  const matchedDriverKeys = new Set<string>();
  const matchedReconIds = new Set<string>();
  const matchedReconNames = new Set<string>();

  const baseline = baselineAssociates
    .map((row) => ({
      providerEmployeeId: String(row.providerEmployeeId ?? "").trim(),
      name: String(row.name ?? "").trim()
    }))
    .filter((row) => row.providerEmployeeId && row.name);

  // Prefer the previous DB associate list for Collect cash names/IDs.
  if (baseline.length) {
    const associates: CashReconAssociate[] = baseline.map((row) => {
      const driver = findDriverForBaseline(row, drivers);
      if (driver) {
        matchedDriverKeys.add(`${String(driver.employeeId ?? "").trim().toUpperCase()}::${String(driver.tasId ?? "").trim().toUpperCase()}`);
      }
      const recon = findReconForBaseline(row, driver, reconByTasId, reconByName, reconciliation);
      if (recon?.driverInfo?.id) matchedReconIds.add(String(recon.driverInfo.id).trim().toUpperCase());
      const reconName = normalizeAssociateName(String(recon?.driverInfo?.name ?? ""));
      if (reconName) matchedReconNames.add(reconName);
      const payment = recon?.paymentInfo;
      const fullName = String(driver?.driverName ?? "").trim() || row.name;
      const employeeId = driver?.employeeId == null ? row.providerEmployeeId : String(driver.employeeId);
      const tasId = driver?.tasId ?? recon?.driverInfo?.id ?? null;
      return {
        providerEmployeeId: row.providerEmployeeId,
        name: fullName,
        displayName: fullName,
        employeeId: driver?.employeeId == null ? null : String(driver.employeeId),
        expected: cashExpectedFor(employeeId, tasId, payment?.expected),
        pendingRecon: moneyValue(payment?.overallPendingRecon),
        breakdown: mapBreakdown(payment),
        source: recon || driver ? "matched" as const : "driver_only" as const,
        shipmentType: "Shipment data"
      };
    });

    const missingFromDer: CashReconAssociate[] = [];
    drivers.forEach((driver) => {
      const key = `${String(driver.employeeId ?? "").trim().toUpperCase()}::${String(driver.tasId ?? "").trim().toUpperCase()}`;
      if (matchedDriverKeys.has(key)) return;
      const nameKey = normalizeAssociateName(driverDisplayName(driver.driverName));
      if (associates.some((associate) => associateNamesMatch(associate.name, driverDisplayName(driver.driverName)))) return;
      const recon = (driver.tasId && reconByTasId.get(String(driver.tasId).trim().toUpperCase()))
        || (nameKey ? reconByName.get(nameKey) : undefined);
      if (recon?.driverInfo?.id) matchedReconIds.add(String(recon.driverInfo.id).trim().toUpperCase());
      if (nameKey) matchedReconNames.add(nameKey);
      missingFromDer.push({
        providerEmployeeId: String(driver.employeeId || driver.tasId || "").trim(),
        name: String(driver.driverName ?? "").trim() || driverDisplayName(driver.driverName),
        displayName: String(driver.driverName ?? "").trim() || driverDisplayName(driver.driverName),
        employeeId: driver.employeeId == null ? null : String(driver.employeeId),
        expected: cashExpectedFor(driver.employeeId, driver.tasId, recon?.paymentInfo?.expected),
        pendingRecon: moneyValue(recon?.paymentInfo?.overallPendingRecon),
        breakdown: mapBreakdown(recon?.paymentInfo),
        source: "extra",
        shipmentType: "Cash recon worker"
      });
    });

    reconciliation.forEach((row) => {
      const id = String(row.driverInfo?.id ?? "").trim().toUpperCase();
      const nameKey = normalizeAssociateName(String(row.driverInfo?.name ?? ""));
      const pendingRecon = moneyValue(row.paymentInfo?.overallPendingRecon);
      const breakdown = mapBreakdown(row.paymentInfo);

      const associateIndex = associates.findIndex((associate) => {
        const associateId = String(associate.providerEmployeeId ?? "").trim().toUpperCase();
        const associateEmployeeId = String(associate.employeeId ?? "").trim().toUpperCase();
        return (id && (associateId === id || associateEmployeeId === id))
          || associateNamesMatch(associate.name, String(row.driverInfo?.name ?? ""));
      });
      if (associateIndex >= 0) {
        const current = associates[associateIndex];
        // Pending/breakdown from recon; do not overwrite cash-only expected with MPOS-inclusive recon.expected.
        if (pendingRecon > 0.01 || (!current.breakdown.length && breakdown.length)) {
          associates[associateIndex] = {
            ...current,
            pendingRecon: pendingRecon > 0.01 ? pendingRecon : current.pendingRecon,
            breakdown: breakdown.length ? breakdown : current.breakdown,
            source: current.source === "driver_only" ? "matched" : current.source
          };
        }
        if (id) matchedReconIds.add(id);
        if (nameKey) matchedReconNames.add(nameKey);
        return;
      }

      if (id && matchedReconIds.has(id)) return;
      if (nameKey && matchedReconNames.has(nameKey)) return;
      if (associates.some((associate) => associateNamesMatch(associate.name, String(row.driverInfo?.name ?? "")))) return;
      const mapped = fromRecon(row, "extra", drivers, expectedCashIndex, hasExpectedCashPayload);
      if (mapped) missingFromDer.push(mapped);
    });

    appendUnmappedExpectedCash(associates, missingFromDer, expectedCash);

    missingFromDer.push({
      providerEmployeeId: "__other__",
      name: "Other",
      displayName: "Other",
      employeeId: null,
      expected: 0,
      pendingRecon: 0,
      breakdown: [],
      source: "other",
      shipmentType: "Manual entry"
    });

    return { associates, missingFromDer };
  }

  const matchedTasIds = new Set<string>();
  const associates: CashReconAssociate[] = drivers.map((driver) => {
    const tasId = String(driver.tasId ?? "").trim();
    const nameKey = normalizeAssociateName(driverDisplayName(driver.driverName));
    const recon = (tasId && reconByTasId.get(tasId.toUpperCase()))
      || (nameKey ? reconByName.get(nameKey) : undefined)
      || reconciliation.find((row) => associateNamesMatch(driverDisplayName(driver.driverName), String(row.driverInfo?.name ?? "")));
    if (recon?.driverInfo?.id) matchedTasIds.add(String(recon.driverInfo.id).trim().toUpperCase());
    const payment = recon?.paymentInfo;
    const fullName = String(driver.driverName ?? "").trim() || driverDisplayName(driver.driverName);
    return {
      providerEmployeeId: String(driver.employeeId || tasId || "").trim(),
      name: fullName,
      displayName: fullName,
      employeeId: driver.employeeId == null ? null : String(driver.employeeId),
      expected: cashExpectedFor(driver.employeeId, tasId, payment?.expected),
      pendingRecon: moneyValue(payment?.overallPendingRecon),
      breakdown: mapBreakdown(payment),
      source: recon ? "matched" as const : "driver_only" as const,
      shipmentType: "Cash recon worker"
    };
  }).filter((row) => row.providerEmployeeId);

  const missingFromDer: CashReconAssociate[] = [];
  reconciliation.forEach((row) => {
    const id = String(row.driverInfo?.id ?? "").trim().toUpperCase();
    const pendingRecon = moneyValue(row.paymentInfo?.overallPendingRecon);
    const breakdown = mapBreakdown(row.paymentInfo);

    const associateIndex = associates.findIndex((associate) => {
      const associateId = String(associate.providerEmployeeId ?? "").trim().toUpperCase();
      const associateEmployeeId = String(associate.employeeId ?? "").trim().toUpperCase();
      return (id && (associateId === id || associateEmployeeId === id))
        || associateNamesMatch(associate.name, String(row.driverInfo?.name ?? ""));
    });
    if (associateIndex >= 0) {
      const current = associates[associateIndex];
      if (pendingRecon > 0.01 || (!current.breakdown.length && breakdown.length)) {
        associates[associateIndex] = {
          ...current,
          pendingRecon: pendingRecon > 0.01 ? pendingRecon : current.pendingRecon,
          breakdown: breakdown.length ? breakdown : current.breakdown,
          source: current.source === "driver_only" ? "matched" : current.source
        };
      }
      if (id) matchedTasIds.add(id);
      return;
    }

    if (id && matchedTasIds.has(id)) return;
    const mapped = fromRecon(row, "extra", drivers, expectedCashIndex, hasExpectedCashPayload);
    if (mapped) missingFromDer.push(mapped);
  });

  appendUnmappedExpectedCash(associates, missingFromDer, expectedCash);

  missingFromDer.push({
    providerEmployeeId: "__other__",
    name: "Other",
    displayName: "Other",
    employeeId: null,
    expected: 0,
    pendingRecon: 0,
    breakdown: [],
    source: "other",
    shipmentType: "Manual entry"
  });

  return { associates, missingFromDer };
}

/**
 * Step-2 gate: every driver with cash-only expected (expectedCash.totalReceived) > 0
 * must have a saved cash entry. Pending recon still comes from reconciliation.
 */
export function buildRequiredCashAssociates(
  reconciliation: CashReconRow[],
  associates: CashReconAssociate[],
  missingFromDer: CashReconAssociate[] = [],
  drivers: CashReconDriver[] = [],
  expectedCash: ExpectedCashSummary | null = null
): CashReconAssociate[] {
  const pool = [...associates, ...missingFromDer.filter((row) => row.source !== "other")];
  const byKey = new Map<string, CashReconAssociate>();
  const expectedCashIndex = indexExpectedCashByDriver(expectedCash);
  const hasExpectedCashPayload = Array.isArray(expectedCash?.byDriver);

  const upsert = (row: CashReconAssociate) => {
    const id = String(row.providerEmployeeId ?? "").trim();
    if (!id || id === "__other__") return;
    const expected = Number(row.expected);
    if (!Number.isFinite(expected) || expected <= 0.01) return;
    const key = id.toUpperCase();
    const current = byKey.get(key);
    if (!current || expected > current.expected) {
      byKey.set(key, { ...row, expected });
    }
  };

  for (const row of associatesRequiringCashEntry(associates, missingFromDer)) {
    upsert(row);
  }

  // Prefer expectedCash.byDriver as the gate source when present.
  if (hasExpectedCashPayload) {
    for (const cashRow of expectedCash?.byDriver ?? []) {
      const expected = moneyValue(cashRow.totalReceived);
      if (expected <= 0.01) continue;
      const employeeIdRaw = String(cashRow.employeeId ?? "").trim();
      const employeeId = employeeIdRaw && employeeIdRaw !== "0" ? employeeIdRaw : "";
      const tasId = String(cashRow.tasId ?? "").trim();
      const matched = pool.find((associate) => {
        const associateId = String(associate.providerEmployeeId ?? "").trim().toUpperCase();
        const associateEmployeeId = String(associate.employeeId ?? "").trim().toUpperCase();
        return (employeeId && (associateId === employeeId.toUpperCase() || associateEmployeeId === employeeId.toUpperCase()))
          || (tasId && (associateId === tasId.toUpperCase() || associateEmployeeId === tasId.toUpperCase()))
          || associateNamesMatch(associate.displayName || associate.name, String(cashRow.driverName ?? ""));
      });
      if (matched) {
        upsert({ ...matched, expected });
        continue;
      }
      const driver = drivers.find((item) =>
        (employeeId && String(item.employeeId ?? "").trim().toUpperCase() === employeeId.toUpperCase())
        || (tasId && String(item.tasId ?? "").trim().toUpperCase() === tasId.toUpperCase())
      );
      const mappedFromWorkforce = cashRow.mappedFromWorkforce === true;
      const fullName = String(driver?.driverName ?? cashRow.driverName ?? "").trim()
        || (tasId ? `Unmapped driver (${tasId})` : "Unassigned driver");
      upsert({
        providerEmployeeId: employeeId || tasId || fullName,
        name: fullName,
        displayName: fullName,
        employeeId: employeeId || null,
        expected,
        pendingRecon: 0,
        breakdown: [],
        source: "extra",
        shipmentType: cashRow.mappedToActiveDriver === false
          ? (mappedFromWorkforce ? "Ageing cash (workforce)" : "Ageing cash (unmapped driver)")
          : "Cash recon worker",
        mappedFromWorkforce
      });
    }
    return Array.from(byKey.values()).sort((a, b) =>
      (a.displayName || a.name).localeCompare(b.displayName || b.name)
    );
  }

  // Legacy fallback when worker has no expectedCash payload.
  for (const recon of reconciliation) {
    const expected = moneyValue(recon.paymentInfo?.expected);
    if (expected <= 0.01) continue;
    const reconId = String(recon.driverInfo?.id ?? "").trim();
    const reconName = String(recon.driverInfo?.name ?? "").trim();
    const matched = pool.find((associate) => {
      const associateId = String(associate.providerEmployeeId ?? "").trim().toUpperCase();
      const employeeId = String(associate.employeeId ?? "").trim().toUpperCase();
      return (reconId && (associateId === reconId.toUpperCase() || employeeId === reconId.toUpperCase()))
        || associateNamesMatch(associate.displayName || associate.name, reconName);
    });
    if (matched) {
      upsert({
        ...matched,
        expected: resolveCashExpected({
          employeeId: matched.employeeId,
          tasId: reconId,
          expectedCashIndex,
          hasExpectedCashPayload,
          reconExpected: expected
        }),
        pendingRecon: moneyValue(recon.paymentInfo?.overallPendingRecon) || matched.pendingRecon,
        breakdown: mapBreakdown(recon.paymentInfo).length ? mapBreakdown(recon.paymentInfo) : matched.breakdown,
        source: matched.source === "other" ? "extra" : matched.source
      });
      continue;
    }
    const mapped = fromRecon(recon, "extra", drivers, expectedCashIndex, hasExpectedCashPayload);
    if (mapped) upsert(mapped);
  }

  return Array.from(byKey.values()).sort((a, b) =>
    (a.displayName || a.name).localeCompare(b.displayName || b.name)
  );
}

export function isLiabilityClear(summary: {
  expectedAmount: number;
  actualAmount: number;
  shortExcessAmount: number;
  count: number;
}) {
  return nearlyZero(summary.expectedAmount)
    && nearlyZero(summary.actualAmount)
    && nearlyZero(summary.shortExcessAmount)
    && nearlyZero(summary.count);
}

/** Drivers that must have a saved cash entry before Step 2 (Continue to driver validation). */
export function associatesRequiringCashEntry(
  associates: CashReconAssociate[],
  missingFromDer: CashReconAssociate[] = []
): CashReconAssociate[] {
  const pool = [
    ...associates,
    ...missingFromDer.filter((row) => row.source === "extra" || row.source === "driver_only")
  ];
  const byId = new Map<string, CashReconAssociate>();
  for (const row of pool) {
    const id = String(row.providerEmployeeId ?? "").trim();
    if (!id || id === "__other__") continue;
    const expected = Number(row.expected);
    if (!Number.isFinite(expected) || expected <= 0.01) continue;
    byId.set(id.toUpperCase(), { ...row, expected });
  }
  return Array.from(byId.values());
}

export function missingRequiredCashEntries(
  required: CashReconAssociate[],
  savedEntries: Array<string | { providerEmployeeId: string; name?: string | null }>
): CashReconAssociate[] {
  const savedIds = new Set<string>();
  const savedNames = new Set<string>();
  for (const entry of savedEntries) {
    if (typeof entry === "string") {
      const id = entry.trim().toUpperCase();
      if (id) savedIds.add(id);
      continue;
    }
    const id = String(entry.providerEmployeeId ?? "").trim().toUpperCase();
    if (id) savedIds.add(id);
    const name = normalizeAssociateName(String(entry.name ?? ""));
    if (name) savedNames.add(name);
  }
  return required.filter((row) => {
    const id = String(row.providerEmployeeId).trim().toUpperCase();
    if (id && savedIds.has(id)) return false;
    const name = normalizeAssociateName(row.displayName || row.name);
    if (name && savedNames.has(name)) return false;
    return true;
  });
}

export function expectedFromCashReconRaw(raw: Record<string, unknown> | null | undefined): number {
  if (!raw || typeof raw !== "object") return 0;
  const value = Number((raw as { expected?: unknown }).expected);
  return Number.isFinite(value) ? value : 0;
}

export function formatCollectionTime(epochMs: number | null) {
  if (!epochMs || !Number.isFinite(epochMs)) return "-";
  try {
    return new Intl.DateTimeFormat("en-IN", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Kolkata"
    }).format(new Date(epochMs));
  } catch {
    return "-";
  }
}
