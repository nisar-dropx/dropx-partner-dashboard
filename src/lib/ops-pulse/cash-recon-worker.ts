import {
  buildCashReconAssociates,
  buildRequiredCashAssociates,
  isLiabilityClear,
  moneyValue,
  normalizeNonZeroFields,
  type BaselineAssociate,
  type CashReconDriver,
  type CashReconRow,
  type DriverReconciliationNormalized,
  type ExpectedCashSummary,
  type LiabilitySummaryNormalized,
  type RemittanceRowNormalized,
  type RemittanceSummaryNormalized
} from "@/lib/ops-pulse/cash-recon-types";
import type { CiaDailyLedgerPayload, CiaNetworkPayload, CiaPendingDriver, CiaStationPayload, CiaStationRow } from "@/lib/ops-pulse/cia-types";

function workerConfig() {
  const baseUrl = (process.env.CASH_RECON_WORKER_URL || process.env.NEXT_PUBLIC_CASH_RECON_WORKER_URL || "").trim().replace(/\/$/, "");
  const adminKey = (process.env.CASH_RECON_ADMIN_KEY || process.env.X_ADMIN_KEY || "").trim().replace(/^["']|["']$/g, "");
  return { baseUrl, adminKey };
}

export function isCashReconWorkerConfigured() {
  const { baseUrl, adminKey } = workerConfig();
  return Boolean(baseUrl && adminKey);
}

async function parseWorkerResponse(response: Response, text: string) {
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    const htmlish = /^\s*</.test(text) || /<!DOCTYPE html/i.test(text);
    if (htmlish || /Worker exceeded resource limits/i.test(text) || response.status === 1102) {
      throw new Error(
        "Cash recon worker hit Cloudflare resource limits (Error 1102). "
          + "Try a shorter date range, or refresh again in a minute."
      );
    }
    const message = payload && typeof payload === "object" && "message" in payload
      ? String((payload as { message?: unknown }).message)
      : payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error?: unknown }).error)
        : (text && !htmlish ? text : null) || `Cash recon worker returned ${response.status}`;
    // Never surface raw HTML/error pages in the UI.
    if (/^\s*</.test(message) || message.length > 400) {
      throw new Error(`Cash recon worker returned ${response.status}. Check worker logs.`);
    }
    throw new Error(message);
  }

  return payload;
}

async function postWorkerOnce<T>(
  path: string,
  body: { stationCode: string; date: string } & Record<string, unknown>
): Promise<T> {
  const { baseUrl, adminKey } = workerConfig();
  if (!baseUrl || !adminKey) {
    throw new Error("Cash recon worker is not configured. Set CASH_RECON_WORKER_URL and CASH_RECON_ADMIN_KEY.");
  }

  const { stationCode, date, ...rest } = body;
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-key": adminKey
    },
    body: JSON.stringify({
      ...rest,
      stationCode: String(stationCode).trim().toUpperCase(),
      date
    }),
    cache: "no-store"
  });

  const text = await response.text();
  return (await parseWorkerResponse(response, text)) as T;
}

async function getWorkerOnce<T>(path: string, query?: Record<string, string>): Promise<T> {
  const { baseUrl, adminKey } = workerConfig();
  if (!baseUrl || !adminKey) {
    throw new Error("Cash recon worker is not configured. Set CASH_RECON_WORKER_URL and CASH_RECON_ADMIN_KEY.");
  }

  const url = new URL(`${baseUrl}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value) url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "x-admin-key": adminKey
    },
    cache: "no-store"
  });

  const text = await response.text();
  return (await parseWorkerResponse(response, text)) as T;
}

function isTransientPortalSessionError(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes("session expired")
    || normalized.includes("unauthorized")
    || normalized.includes("not authenticated");
}

async function postWorker<T>(
  path: string,
  body: { stationCode: string; date: string } & Record<string, unknown>
): Promise<T> {
  try {
    return await postWorkerOnce<T>(path, body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // First hit after idle often races Amazon portal login; one retry usually succeeds.
    if (!isTransientPortalSessionError(message)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return postWorkerOnce<T>(path, body);
  }
}

async function getWorker<T>(path: string, query?: Record<string, string>): Promise<T> {
  try {
    return await getWorkerOnce<T>(path, query);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isTransientPortalSessionError(message)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return getWorkerOnce<T>(path, query);
  }
}

type RawDriverReconciliation = {
  status?: string;
  stationCode?: string;
  date?: string;
  sessionSource?: string | null;
  drivers?: CashReconDriver[];
  driverCount?: number;
  reconciliation?: CashReconRow[];
  reconciliationCount?: number;
  expectedCash?: ExpectedCashSummary | null;
};

export async function fetchDriverReconciliation(params: {
  stationCode: string;
  date: string;
  baselineAssociates?: BaselineAssociate[];
}): Promise<DriverReconciliationNormalized> {
  const raw = await postWorker<RawDriverReconciliation>("/api/admin/executive/driver-reconciliation", params);
  const drivers = Array.isArray(raw.drivers) ? raw.drivers : [];
  const reconciliation = Array.isArray(raw.reconciliation) ? raw.reconciliation : [];
  const expectedCash = raw.expectedCash && typeof raw.expectedCash === "object"
    ? {
        totalReceived: moneyValue(raw.expectedCash.totalReceived),
        shipmentCount: Number(raw.expectedCash.shipmentCount ?? 0) || 0,
        byDriver: Array.isArray(raw.expectedCash.byDriver) ? raw.expectedCash.byDriver : [],
        cashShipments: Array.isArray(raw.expectedCash.cashShipments) ? raw.expectedCash.cashShipments : []
      }
    : null;
  const { associates, missingFromDer } = buildCashReconAssociates(
    drivers,
    reconciliation,
    params.baselineAssociates ?? [],
    expectedCash
  );
  const requiredForCashEntry = buildRequiredCashAssociates(
    reconciliation,
    associates,
    missingFromDer,
    drivers,
    expectedCash
  );

  return {
    status: String(raw.status ?? "ok"),
    stationCode: String(raw.stationCode ?? params.stationCode).toUpperCase(),
    date: String(raw.date ?? params.date),
    sessionSource: raw.sessionSource == null ? null : String(raw.sessionSource),
    driverCount: Number(raw.driverCount ?? drivers.length) || drivers.length,
    reconciliationCount: Number(raw.reconciliationCount ?? reconciliation.length) || reconciliation.length,
    associates,
    missingFromDer,
    requiredForCashEntry,
    reconciliation,
    expectedCash
  };
}

type RawLiabilitySummary = {
  status?: string;
  stationCode?: string;
  date?: string;
  summary?: {
    cashSummary?: {
      expectedAmount?: { value?: number };
      actualAmount?: { value?: number };
      shortExcessAmount?: { value?: number };
      count?: number;
    };
    mposSummary?: {
      amount?: { value?: number };
      count?: number;
    };
  };
  check?: {
    passed?: boolean;
    nonZeroFields?: unknown[];
  };
};

export async function fetchLiabilitySummary(params: {
  stationCode: string;
  date: string;
}): Promise<LiabilitySummaryNormalized> {
  const raw = await postWorker<RawLiabilitySummary>("/api/admin/executive/liability-summary", params);
  const cash = raw.summary?.cashSummary;
  const mpos = raw.summary?.mposSummary;
  const cashSummary = {
    expectedAmount: moneyValue(cash?.expectedAmount),
    actualAmount: moneyValue(cash?.actualAmount),
    shortExcessAmount: moneyValue(cash?.shortExcessAmount),
    count: Number(cash?.count ?? 0) || 0
  };
  // Gate only on cash summary. MPOS / worker check.passed are informational.
  const clear = isLiabilityClear(cashSummary);

  return {
    status: String(raw.status ?? "ok"),
    stationCode: String(raw.stationCode ?? params.stationCode).toUpperCase(),
    date: String(raw.date ?? params.date),
    cashSummary,
    mposSummary: {
      amount: moneyValue(mpos?.amount),
      count: Number(mpos?.count ?? 0) || 0
    },
    check: {
      passed: clear,
      nonZeroFields: normalizeNonZeroFields(raw.check?.nonZeroFields)
    },
    isClear: clear
  };
}

type RawRemittanceRow = {
  remittanceCode?: string | null;
  remittanceId?: string | null;
  creationDate?: number | null;
  lastUpdated?: number | null;
  submissionDate?: number | null;
  createdBy?: string | null;
  submittedBy?: string | null;
  status?: string | null;
  expectedAmount?: { unit?: string | null; value?: number | null } | null;
  actualAmount?: { unit?: string | null; value?: number | null } | null;
  paymentMethod?: string | null;
  variance?: { unit?: string | null; value?: number | null } | null;
  ttLink?: string | null;
  stationVariance?: {
    transactionId?: string | null;
    isVerified?: boolean | null;
    stationVarianceList?: Array<{
      amount?: { unit?: string | null; value?: number | null } | null;
      reason?: string | null;
      type?: string | null;
    }> | null;
  } | null;
};

type RawRemittanceSummary = {
  status?: string;
  stationCode?: string;
  date?: string;
  sessionSource?: string | null;
  accountKey?: string | null;
  remittanceTotalCash?: number | { value?: number } | null;
  created?: RawRemittanceRow[];
  createdCount?: number;
  createdTotal?: number | { value?: number } | null;
  submitted?: RawRemittanceRow[];
  submittedCount?: number;
  submittedTotal?: number | { value?: number } | null;
  remittanceCodes?: string[];
  dateRange?: {
    startTime?: number | null;
    endTime?: number | null;
  } | null;
  summary?: {
    status?: string | null;
    mode?: string | null;
    window?: { from?: string | null; to?: string | null } | null;
    sameDayExpectedCashTotal?: number | { value?: number } | null;
    sameDayRemittanceTotalCash?: number | { value?: number } | null;
    sameDayShortAmount?: number | { value?: number } | null;
    finalPendingTotal?: number | { value?: number } | null;
    limitedByRemittanceWindow?: boolean | null;
  } | null;
  ledger?: Array<{
    date?: string | null;
    expectedCashTotal?: number | { value?: number } | null;
    remittanceTotalCash?: number | { value?: number } | null;
    shortAmount?: number | { value?: number } | null;
    carryForwardIn?: number | { value?: number } | null;
    carryForwardOut?: number | { value?: number } | null;
    clearedSameDayAmount?: number | { value?: number } | null;
    forwardedAmount?: number | { value?: number } | null;
    stillPendingAmount?: number | { value?: number } | null;
    clearedFromPriorAmount?: number | { value?: number } | null;
    drivers?: Array<{
      driverName?: string | null;
      tasId?: string | null;
      employeeId?: string | number | null;
      amount?: number | { value?: number } | null;
      shipmentCount?: number | null;
      shipments?: Array<{
        trackingId?: string | null;
        shipmentNo?: string | null;
        pendingAmount?: number | { value?: number } | null;
        keptOnDate?: string | null;
        clearedOnDate?: string | null;
        keptDays?: number | null;
        status?: string | null;
        remittanceId?: string | null;
        remittanceCode?: string | null;
      }> | null;
    }> | null;
  }> | null;
};

function mapRemittanceRow(row: RawRemittanceRow): RemittanceRowNormalized {
  const varianceList = Array.isArray(row.stationVariance?.stationVarianceList)
    ? row.stationVariance.stationVarianceList.map((item) => ({
        amount: moneyValue(item?.amount),
        reason: String(item?.reason ?? "").trim() || "-",
        type: String(item?.type ?? "").trim() || "-"
      }))
    : [];
  return {
    remittanceCode: String(row.remittanceCode ?? "").trim(),
    remittanceId: String(row.remittanceId ?? "").trim(),
    creationDate: typeof row.creationDate === "number" ? row.creationDate : null,
    lastUpdated: typeof row.lastUpdated === "number" ? row.lastUpdated : null,
    submissionDate: typeof row.submissionDate === "number" ? row.submissionDate : null,
    createdBy: row.createdBy == null ? null : String(row.createdBy),
    submittedBy: row.submittedBy == null ? null : String(row.submittedBy),
    status: String(row.status ?? "").trim() || "-",
    expectedAmount: moneyValue(row.expectedAmount),
    actualAmount: moneyValue(row.actualAmount),
    paymentMethod: row.paymentMethod == null ? null : String(row.paymentMethod),
    variance: moneyValue(row.variance),
    ttLink: row.ttLink == null ? null : String(row.ttLink),
    transactionId: row.stationVariance?.transactionId == null ? null : String(row.stationVariance.transactionId),
    isVerified: typeof row.stationVariance?.isVerified === "boolean" ? row.stationVariance.isVerified : null,
    stationVarianceList: varianceList
  };
}

function mapRemittanceLedger(raw: RawRemittanceSummary["ledger"]): RemittanceSummaryNormalized["ledger"] {
  if (!Array.isArray(raw)) return [];
  return raw.map((day) => ({
    date: String(day?.date ?? "").trim(),
    expectedCashTotal: moneyValue(day?.expectedCashTotal),
    remittanceTotalCash: moneyValue(day?.remittanceTotalCash),
    shortAmount: moneyValue(day?.shortAmount),
    carryForwardIn: moneyValue(day?.carryForwardIn),
    carryForwardOut: moneyValue(day?.carryForwardOut),
    clearedSameDayAmount: moneyValue(day?.clearedSameDayAmount),
    forwardedAmount: moneyValue(day?.forwardedAmount),
    stillPendingAmount: moneyValue(day?.stillPendingAmount),
    clearedFromPriorAmount: moneyValue(day?.clearedFromPriorAmount),
    drivers: Array.isArray(day?.drivers)
      ? day.drivers.map((driver) => ({
          driverName: String(driver?.driverName ?? "").trim() || "Unknown driver",
          tasId: driver?.tasId == null ? null : String(driver.tasId),
          employeeId: driver?.employeeId == null || driver.employeeId === "" ? null : String(driver.employeeId),
          amount: moneyValue(driver?.amount),
          shipmentCount: Number(driver?.shipmentCount ?? 0) || 0,
          shipments: Array.isArray(driver?.shipments)
            ? driver.shipments.map((shipment) => ({
                trackingId: String(shipment?.trackingId ?? "").trim() || "-",
                shipmentNo: String(shipment?.shipmentNo ?? "").trim(),
                pendingAmount: moneyValue(shipment?.pendingAmount),
                keptOnDate: shipment?.keptOnDate == null ? null : String(shipment.keptOnDate),
                clearedOnDate: shipment?.clearedOnDate == null ? null : String(shipment.clearedOnDate),
                keptDays: typeof shipment?.keptDays === "number" ? shipment.keptDays : null,
                status: String(shipment?.status ?? "").trim() || "-",
                remittanceId: shipment?.remittanceId == null ? null : String(shipment.remittanceId),
                remittanceCode: shipment?.remittanceCode == null ? null : String(shipment.remittanceCode)
              }))
            : []
        }))
      : []
  }));
}

export type RemittanceVerifyMatch = {
  remittanceId: string;
  remittanceCode: string | null;
  status: string;
  actualAmount: number;
  creationDate: number;
  creationDateIst: string | null;
  submissionDate: number | null;
  submissionDateIst: string | null;
  submittedBy: string | null;
  createdBy: string | null;
};

export type RemittanceVerifyResult = {
  status: string;
  stationCode: string;
  date: string;
  remittanceCode: string;
  amount: number;
  verified: boolean;
  codeFound: boolean;
  amountMatched: boolean;
  depositDateMatched: boolean;
  creationPeriodMatched: boolean;
  submitterMatched: boolean;
  failureReason: string | null;
  matches: RemittanceVerifyMatch[];
  nearMisses: RemittanceVerifyMatch[];
  sessionSource: string | null;
  accountKey: string | null;
  dateRange: { startTime: number | null; endTime: number | null };
};

type RawRemittanceVerify = {
  status?: string;
  stationCode?: string;
  date?: string;
  remittanceCode?: string;
  amount?: number;
  verified?: boolean;
  codeFound?: boolean;
  amountMatched?: boolean;
  depositDateMatched?: boolean;
  creationPeriodMatched?: boolean;
  submitterMatched?: boolean;
  failureReason?: string | null;
  matches?: Array<RemittanceVerifyMatch & Record<string, unknown>>;
  nearMisses?: Array<RemittanceVerifyMatch & Record<string, unknown>>;
  sessionSource?: string | null;
  accountKey?: string | null;
  dateRange?: { startTime?: number; endTime?: number };
};

/**
 * Dedicated verify endpoint — full Amazon remittance lookback.
 * Rules (IST): deposit date = submissionDate; COD From/To covers creationDate;
 * amount = actualAmount.value; submittedBy optional case-insensitive.
 */
export async function verifyRemittance(params: {
  stationCode: string;
  date: string;
  remittanceCode: string;
  amount: number;
  codPeriodFrom?: string;
  codPeriodTo?: string;
  submittedBy?: string | null;
  fresh?: boolean;
}): Promise<RemittanceVerifyResult> {
  const raw = await postWorker<RawRemittanceVerify>("/api/admin/executive/remittance/verify", {
    stationCode: params.stationCode,
    date: params.date,
    remittanceCode: params.remittanceCode,
    amount: params.amount,
    codPeriodFrom: params.codPeriodFrom || undefined,
    codPeriodTo: params.codPeriodTo || undefined,
    submittedBy: params.submittedBy || undefined,
    fresh: params.fresh === true
  });

  const mapMatch = (row: RemittanceVerifyMatch & Record<string, unknown>): RemittanceVerifyMatch => ({
    remittanceId: String(row.remittanceId ?? ""),
    remittanceCode: row.remittanceCode == null ? null : String(row.remittanceCode),
    status: String(row.status ?? ""),
    actualAmount: moneyValue(row.actualAmount as never),
    creationDate: Number(row.creationDate ?? 0) || 0,
    creationDateIst: row.creationDateIst == null ? null : String(row.creationDateIst),
    submissionDate: row.submissionDate == null ? null : Number(row.submissionDate) || null,
    submissionDateIst: row.submissionDateIst == null ? null : String(row.submissionDateIst),
    submittedBy: row.submittedBy == null ? null : String(row.submittedBy),
    createdBy: row.createdBy == null ? null : String(row.createdBy)
  });

  return {
    status: String(raw.status ?? "ok"),
    stationCode: String(raw.stationCode ?? params.stationCode).toUpperCase(),
    date: String(raw.date ?? params.date),
    remittanceCode: String(raw.remittanceCode ?? params.remittanceCode).trim().toUpperCase(),
    amount: moneyValue(raw.amount as never) || params.amount,
    verified: Boolean(raw.verified),
    codeFound: Boolean(raw.codeFound),
    amountMatched: Boolean(raw.amountMatched),
    depositDateMatched: Boolean(raw.depositDateMatched),
    creationPeriodMatched: Boolean(raw.creationPeriodMatched),
    submitterMatched: raw.submitterMatched !== false,
    failureReason: raw.failureReason == null ? null : String(raw.failureReason),
    matches: Array.isArray(raw.matches) ? raw.matches.map(mapMatch) : [],
    nearMisses: Array.isArray(raw.nearMisses) ? raw.nearMisses.map(mapMatch) : [],
    sessionSource: raw.sessionSource == null ? null : String(raw.sessionSource),
    accountKey: raw.accountKey == null ? null : String(raw.accountKey),
    dateRange: {
      startTime: typeof raw.dateRange?.startTime === "number" ? raw.dateRange.startTime : null,
      endTime: typeof raw.dateRange?.endTime === "number" ? raw.dateRange.endTime : null
    }
  };
}

export async function fetchRemittance(params: {
  stationCode: string;
  date: string;
}): Promise<RemittanceSummaryNormalized> {
  const raw = await postWorker<RawRemittanceSummary>("/api/admin/executive/remittance", params);
  const created = Array.isArray(raw.created) ? raw.created.map(mapRemittanceRow) : [];
  const submitted = Array.isArray(raw.submitted) ? raw.submitted.map(mapRemittanceRow) : [];
  const matchSummary = raw.summary && typeof raw.summary === "object"
    ? {
        status: String(raw.summary.status ?? "").trim().toUpperCase() || "UNKNOWN",
        mode: String(raw.summary.mode ?? "").trim() || "sameDay",
        windowFrom: raw.summary.window?.from == null ? null : String(raw.summary.window.from),
        windowTo: raw.summary.window?.to == null ? null : String(raw.summary.window.to),
        sameDayExpectedCashTotal: moneyValue(raw.summary.sameDayExpectedCashTotal),
        sameDayRemittanceTotalCash: moneyValue(raw.summary.sameDayRemittanceTotalCash),
        sameDayShortAmount: moneyValue(raw.summary.sameDayShortAmount),
        finalPendingTotal: moneyValue(raw.summary.finalPendingTotal),
        limitedByRemittanceWindow: Boolean(raw.summary.limitedByRemittanceWindow)
      }
    : null;
  return {
    status: String(raw.status ?? "ok"),
    stationCode: String(raw.stationCode ?? params.stationCode).toUpperCase(),
    date: String(raw.date ?? params.date),
    sessionSource: raw.sessionSource == null ? null : String(raw.sessionSource),
    accountKey: raw.accountKey == null ? null : String(raw.accountKey),
    remittanceTotalCash: moneyValue(raw.remittanceTotalCash),
    created,
    createdCount: Number(raw.createdCount ?? created.length) || created.length,
    createdTotal: moneyValue(raw.createdTotal),
    submitted,
    submittedCount: Number(raw.submittedCount ?? submitted.length) || submitted.length,
    submittedTotal: moneyValue(raw.submittedTotal),
    remittanceCodes: Array.isArray(raw.remittanceCodes)
      ? raw.remittanceCodes.map((code) => String(code ?? "").trim()).filter(Boolean)
      : [...new Set([...created, ...submitted].map((row) => row.remittanceCode).filter(Boolean))],
    dateRange: {
      startTime: typeof raw.dateRange?.startTime === "number" ? raw.dateRange.startTime : null,
      endTime: typeof raw.dateRange?.endTime === "number" ? raw.dateRange.endTime : null
    },
    matchSummary,
    ledger: mapRemittanceLedger(raw.ledger)
  };
}

function mapCiaSummary(raw: Record<string, unknown> | null | undefined) {
  return {
    ciaTotal: moneyValue(raw?.ciaTotal as never),
    cashAtStationTotal: moneyValue(raw?.cashAtStationTotal as never),
    ageingTotal: moneyValue((raw?.ageingTotal ?? raw?.ciaTotal) as never),
    depositedTotal: moneyValue(raw?.depositedTotal as never),
    pendingLiability: moneyValue(raw?.pendingLiability as never),
    clearedInWindow: moneyValue(raw?.clearedInWindow as never),
    cashDifference: moneyValue((raw?.cashDifference ?? raw?.difference) as never),
    difference: moneyValue((raw?.difference ?? raw?.cashDifference) as never),
    shipmentCount: Number(raw?.shipmentCount ?? 0) || 0,
    pendingDriverCount: Number(raw?.pendingDriverCount ?? 0) || 0,
    limitedByRemittanceWindow: Boolean(raw?.limitedByRemittanceWindow)
  };
}

function mapCiaStationRow(raw: Record<string, unknown>): CiaStationRow {
  const summary = mapCiaSummary(raw);
  return {
    stationCode: String(raw.stationCode ?? "").trim().toUpperCase(),
    status: String(raw.status ?? "ok"),
    error: raw.error == null ? null : String(raw.error),
    fetchedAt: raw.fetchedAt == null ? null : String(raw.fetchedAt),
    accountKey: raw.accountKey == null ? null : String(raw.accountKey),
    ...summary
  };
}

function mapCiaPendingDriver(raw: Record<string, unknown>): CiaPendingDriver {
  const shipments = Array.isArray(raw.shipments)
    ? raw.shipments.map((item) => {
        const shipment = (item ?? {}) as Record<string, unknown>;
        return {
          trackingId: String(shipment.trackingId ?? "").trim() || "-",
          shipmentNo: String(shipment.shipmentNo ?? "").trim(),
          pendingAmount: moneyValue(shipment.pendingAmount as never),
          keptOnDate: shipment.keptOnDate == null ? null : String(shipment.keptOnDate),
          clearedOnDate: shipment.clearedOnDate == null ? null : String(shipment.clearedOnDate),
          keptDays: typeof shipment.keptDays === "number" ? shipment.keptDays : null,
          status: String(shipment.status ?? "pending").trim() || "pending",
          remittanceId: shipment.remittanceId == null ? null : String(shipment.remittanceId),
          remittanceCode: shipment.remittanceCode == null ? null : String(shipment.remittanceCode)
        };
      })
    : [];

  return {
    driverName: String(raw.driverName ?? "").trim() || "Unknown driver",
    tasId: raw.tasId == null ? null : String(raw.tasId),
    employeeId: raw.employeeId == null || raw.employeeId === "" ? null : String(raw.employeeId),
    operationalStatus: raw.operationalStatus == null ? null : String(raw.operationalStatus),
    mappedFromWorkforce: Boolean(raw.mappedFromWorkforce),
    amount: moneyValue(raw.amount as never),
    shipmentCount: Number(raw.shipmentCount ?? shipments.length) || shipments.length,
    dates: Array.isArray(raw.dates) ? raw.dates.map((d) => String(d)).filter(Boolean).sort() : [],
    shipments
  };
}

export async function fetchCiaNetwork(): Promise<CiaNetworkPayload> {
  const raw = await getWorker<Record<string, unknown>>("/api/admin/executive/cash-in-associate/network");
  const runRaw = raw.run && typeof raw.run === "object" ? (raw.run as Record<string, unknown>) : null;
  const totalsRaw = raw.totals && typeof raw.totals === "object" ? (raw.totals as Record<string, unknown>) : {};
  const windowRaw = raw.window && typeof raw.window === "object" ? (raw.window as Record<string, unknown>) : {};
  const stations = Array.isArray(raw.stations)
    ? raw.stations.map((row) => mapCiaStationRow((row ?? {}) as Record<string, unknown>))
    : [];

  return {
    status: String(raw.status ?? "ok"),
    asOfDate: String(raw.asOfDate ?? ""),
    window: {
      from: String(windowRaw.from ?? ""),
      to: String(windowRaw.to ?? "")
    },
    run: runRaw
      ? {
          id: String(runRaw.id ?? ""),
          status: String(runRaw.status ?? ""),
          startedAt: runRaw.startedAt == null ? null : String(runRaw.startedAt),
          finishedAt: runRaw.finishedAt == null ? null : String(runRaw.finishedAt),
          stationsTotal: Number(runRaw.stationsTotal ?? stations.length) || stations.length,
          stationsOk: Number(runRaw.stationsOk ?? 0) || 0,
          stationsFailed: Number(runRaw.stationsFailed ?? 0) || 0
        }
      : null,
    refreshProgress: (() => {
      const progressRaw =
        raw.refreshProgress && typeof raw.refreshProgress === "object"
          ? (raw.refreshProgress as Record<string, unknown>)
          : null;
      if (!progressRaw) return null;
      return {
        id: String(progressRaw.id ?? ""),
        status: String(progressRaw.status ?? "running"),
        asOfDate: progressRaw.asOfDate == null ? undefined : String(progressRaw.asOfDate),
        windowFrom: progressRaw.windowFrom == null ? undefined : String(progressRaw.windowFrom),
        windowTo: progressRaw.windowTo == null ? undefined : String(progressRaw.windowTo),
        startedAt: progressRaw.startedAt == null ? null : String(progressRaw.startedAt),
        stationsTotal: Number(progressRaw.stationsTotal ?? 0) || 0,
        stationsOk: Number(progressRaw.stationsOk ?? 0) || 0,
        stationsFailed: Number(progressRaw.stationsFailed ?? 0) || 0
      };
    })(),
    totals: mapCiaSummary(totalsRaw),
    stations,
    cached: Boolean(raw.cached),
    runSource: raw.runSource == null ? undefined : String(raw.runSource)
  };
}

export async function fetchCiaDailyLedger(options?: { date?: string }): Promise<CiaDailyLedgerPayload> {
  const date = String(options?.date ?? "").trim();
  const query: Record<string, string> = {};
  if (date) query.date = date;
  const raw = await getWorker<Record<string, unknown>>(
    "/api/admin/executive/cash-in-associate/daily-ledger",
    query
  );
  const windowRaw = raw.window && typeof raw.window === "object" ? (raw.window as Record<string, unknown>) : {};
  const totalsRaw = raw.totals && typeof raw.totals === "object" ? (raw.totals as Record<string, unknown>) : {};
  const runRaw = raw.run && typeof raw.run === "object" ? (raw.run as Record<string, unknown>) : null;

  const days = Array.isArray(raw.days)
    ? raw.days.map((row) => {
        const day = (row ?? {}) as Record<string, unknown>;
        return {
          date: String(day.date ?? ""),
          cashWithAssociate: moneyValue(day.cashWithAssociate as never),
          deposited: moneyValue(day.deposited as never),
          pending: moneyValue(day.pending as never),
          forwarded: moneyValue(day.forwarded as never),
          stationCount: Number(day.stationCount ?? 0) || 0
        };
      })
    : [];

  const stationDays = Array.isArray(raw.stationDays)
    ? raw.stationDays.map((row) => {
        const day = (row ?? {}) as Record<string, unknown>;
        return {
          stationCode: String(day.stationCode ?? "").toUpperCase(),
          date: String(day.date ?? ""),
          cashWithAssociate: moneyValue(day.cashWithAssociate as never),
          deposited: moneyValue(day.deposited as never),
          pending: moneyValue(day.pending as never),
          forwarded: moneyValue(day.forwarded as never)
        };
      })
    : [];

  return {
    status: String(raw.status ?? "ok"),
    asOfDate: String(raw.asOfDate ?? ""),
    window: {
      from: String(windowRaw.from ?? ""),
      to: String(windowRaw.to ?? "")
    },
    selectedDate: raw.selectedDate == null ? null : String(raw.selectedDate),
    runSource: raw.runSource == null ? undefined : String(raw.runSource),
    run: runRaw
      ? {
          id: String(runRaw.id ?? ""),
          status: String(runRaw.status ?? ""),
          stationsTotal: Number(runRaw.stationsTotal ?? 0) || 0,
          stationsOk: Number(runRaw.stationsOk ?? 0) || 0
        }
      : null,
    totals: {
      cashWithAssociate: moneyValue(totalsRaw.cashWithAssociate as never),
      deposited: moneyValue(totalsRaw.deposited as never),
      pending: moneyValue(totalsRaw.pending as never),
      forwarded: moneyValue(totalsRaw.forwarded as never)
    },
    days,
    stationDays,
    cached: Boolean(raw.cached)
  };
}

export async function fetchCiaStation(
  stationCode: string,
  options?: { asOfDate?: string; fromDate?: string; toDate?: string }
): Promise<CiaStationPayload> {
  const code = stationCode.trim().toUpperCase();
  const asOfDate = String(options?.asOfDate ?? "").trim();
  const fromDate = String(options?.fromDate ?? "").trim();
  const toDate = String(options?.toDate ?? "").trim();
  const query: Record<string, string> = { stationCode: code };
  if (asOfDate) query.asOfDate = asOfDate;
  if (fromDate && toDate) {
    query.fromDate = fromDate;
    query.toDate = toDate;
  }

  const raw = await getWorker<Record<string, unknown>>("/api/admin/executive/cash-in-associate", query);
  const summaryRaw = raw.summary && typeof raw.summary === "object" ? (raw.summary as Record<string, unknown>) : {};
  const windowRaw = raw.window && typeof raw.window === "object" ? (raw.window as Record<string, unknown>) : {};
  const pendingDrivers = Array.isArray(raw.pendingDrivers)
    ? raw.pendingDrivers
        .map((row) => mapCiaPendingDriver((row ?? {}) as Record<string, unknown>))
        .sort((a, b) => b.amount - a.amount)
    : [];
  const availableReportDates = Array.isArray(raw.availableReportDates)
    ? raw.availableReportDates.map((value) => String(value)).filter(Boolean)
    : [];
  const ledger = Array.isArray(raw.ledger)
    ? (raw.ledger as Array<Record<string, unknown>>)
        .map((day) => ({
          date: String(day?.date ?? "").trim(),
          carryForwardIn: moneyValue(day?.carryForwardIn as never),
          expectedCashTotal: moneyValue(day?.expectedCashTotal as never),
          remittanceTotalCash: moneyValue(day?.remittanceTotalCash as never),
          shortAmount: moneyValue(day?.shortAmount as never),
          stillPendingAmount: moneyValue(day?.stillPendingAmount as never),
          forwardedAmount: moneyValue(day?.forwardedAmount as never),
          clearedSameDayAmount: moneyValue(day?.clearedSameDayAmount as never),
          clearedFromPriorAmount: moneyValue(day?.clearedFromPriorAmount as never),
          driverCount: Array.isArray(day?.drivers) ? day.drivers.length : 0
        }))
        .filter((day) => Boolean(day.date))
        .sort((a, b) => b.date.localeCompare(a.date))
    : [];

  return {
    status: String(raw.status ?? "ok"),
    asOfDate: String(raw.asOfDate ?? ""),
    window: {
      from: String(windowRaw.from ?? ""),
      to: String(windowRaw.to ?? "")
    },
    runStatus: raw.runStatus == null ? null : String(raw.runStatus),
    runId: raw.runId == null ? null : String(raw.runId),
    stationCode: String(raw.stationCode ?? code).toUpperCase(),
    snapshotStatus: String(raw.snapshotStatus ?? "ok"),
    error: raw.error == null ? null : String(raw.error),
    fetchedAt: raw.fetchedAt == null ? null : String(raw.fetchedAt),
    summary: mapCiaSummary(summaryRaw),
    pendingDrivers,
    ledger,
    cached: Boolean(raw.cached),
    availableReportDates
  };
}

async function postWorkerJsonOnce<T>(path: string, body?: Record<string, unknown>, query?: Record<string, string>): Promise<T> {
  const { baseUrl, adminKey } = workerConfig();
  if (!baseUrl || !adminKey) {
    throw new Error("Cash recon worker is not configured. Set CASH_RECON_WORKER_URL and CASH_RECON_ADMIN_KEY.");
  }

  const url = new URL(`${baseUrl}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value) url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-key": adminKey
    },
    body: JSON.stringify(body ?? {}),
    cache: "no-store"
  });

  const text = await response.text();
  return (await parseWorkerResponse(response, text)) as T;
}

export type CiaStationRefreshResult = {
  status: string;
  stationCode: string;
  runId: string;
  snapshotStatus: string;
  error: string | null;
};

export type CiaNetworkRefreshResult = {
  status: string;
  resumed: boolean;
  run: {
    id: string;
    status: string;
    stationsTotal: number;
    stationsOk: number;
    stationsFailed: number;
  } | null;
  message: string;
};

const CIA_REFRESH_CHUNK_DAYS = 7;

function addDaysYmdLocal(ymd: string, days: number) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function splitCiaYmdRange(fromDate: string, toDate: string, chunkDays = CIA_REFRESH_CHUNK_DAYS) {
  if (toDate < fromDate) return [] as Array<{ from: string; to: string }>;
  const chunks: Array<{ from: string; to: string }> = [];
  let cursor = fromDate;
  while (cursor <= toDate) {
    const chunkTo = addDaysYmdLocal(cursor, chunkDays - 1);
    const to = chunkTo < toDate ? chunkTo : toDate;
    chunks.push({ from: cursor, to });
    cursor = addDaysYmdLocal(to, 1);
  }
  return chunks;
}

function moneySum(values: number[]) {
  return Math.round(values.reduce((s, n) => s + n, 0) * 100) / 100;
}

function mergeCiaLiveParts(
  parts: Array<Record<string, unknown>>,
  window: { from: string; to: string }
) {
  const pendingDriversRaw = parts.flatMap((p) =>
    Array.isArray(p.pendingDrivers) ? (p.pendingDrivers as Array<Record<string, unknown>>) : []
  );
  const byKey = new Map<string, Record<string, unknown>>();
  for (const driver of pendingDriversRaw) {
    const tas = String(driver.tasId ?? "").trim().toUpperCase();
    const emp = String(driver.employeeId ?? "").trim().toUpperCase();
    const name = String(driver.driverName ?? "").trim().toLowerCase();
    const key = tas ? `tas:${tas}` : emp ? `emp:${emp}` : `name:${name}`;
    const current = byKey.get(key);
    const shipments = Array.isArray(driver.shipments)
      ? (driver.shipments as Array<Record<string, unknown>>)
      : [];
    if (!current) {
      const shipmentByTracking = new Map<string, Record<string, unknown>>();
      for (const s of shipments) {
        const tid = String(s.trackingId ?? "").trim();
        if (tid) shipmentByTracking.set(tid, s);
      }
      byKey.set(key, { ...driver, _shipments: shipmentByTracking });
      continue;
    }
    const map = current._shipments as Map<string, Record<string, unknown>>;
    for (const s of shipments) {
      const tid = String(s.trackingId ?? "").trim();
      if (tid && !map.has(tid)) map.set(tid, s);
    }
  }

  const pendingDrivers = [...byKey.values()].map((row) => {
    const map = row._shipments as Map<string, Record<string, unknown>>;
    const shipments = [...map.values()];
    const amount = moneySum(shipments.map((s) => Number(s.pendingAmount ?? 0) || 0));
    const dates = [...new Set(shipments.map((s) => String(s.keptOnDate ?? "")).filter(Boolean))].sort();
    return {
      driverName: String(row.driverName ?? ""),
      tasId: row.tasId == null ? null : String(row.tasId),
      employeeId: row.employeeId == null ? null : String(row.employeeId),
      operationalStatus: row.operationalStatus == null ? null : String(row.operationalStatus),
      mappedFromWorkforce: Boolean(row.mappedFromWorkforce),
      amount,
      shipmentCount: shipments.length,
      dates,
      shipments
    };
  }).sort((a, b) => b.amount - a.amount);

  const summaries = parts.map((p) =>
    (p.summary && typeof p.summary === "object" ? p.summary : {}) as Record<string, unknown>
  );
  const ageingTotal = moneySum(summaries.map((s) => Number(s.ageingTotal ?? 0) || 0));
  const depositedTotal = moneySum(summaries.map((s) => Number(s.depositedTotal ?? 0) || 0));
  const cashDifference = moneySum([ageingTotal - depositedTotal]);
  const ledger = parts.flatMap((p) => (Array.isArray(p.ledger) ? p.ledger : []));

  return {
    window,
    summary: {
      ciaTotal: moneySum(summaries.map((s) => Number(s.ciaTotal ?? 0) || 0)),
      cashAtStationTotal: moneySum(summaries.map((s) => Number(s.cashAtStationTotal ?? 0) || 0)),
      ageingTotal,
      depositedTotal,
      pendingLiability: moneySum(summaries.map((s) => Number(s.pendingLiability ?? 0) || 0)),
      clearedInWindow: moneySum(summaries.map((s) => Number(s.clearedInWindow ?? 0) || 0)),
      cashDifference,
      difference: cashDifference,
      shipmentCount: summaries.reduce((s, row) => s + (Number(row.shipmentCount ?? 0) || 0), 0),
      pendingDriverCount: pendingDrivers.length,
      limitedByRemittanceWindow: summaries.some((s) => Boolean(s.limitedByRemittanceWindow)),
      alignedFromDate: window.from
    },
    ledger,
    pendingDrivers
  };
}

function defaultCiaWindow() {
  // Approximate IST yesterday as UTC+5:30 calendar date.
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const toDate = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - 1));
  const to = toDate.toISOString().slice(0, 10);
  const from = addDaysYmdLocal(to, -(31 - 1));
  return { from, to };
}

/**
 * Refresh one station by loading live-range chunks (each stays under CF limits),
 * merging on the BFF, then saving the snapshot on the worker.
 */
export async function refreshCiaStation(stationCode: string): Promise<CiaStationRefreshResult> {
  const code = stationCode.trim().toUpperCase();

  let window = defaultCiaWindow();
  try {
    const network = await fetchCiaNetwork();
    if (network.window?.from && network.window?.to) {
      window = { from: network.window.from, to: network.window.to };
    }
  } catch {
    /* use default 31-day window */
  }

  const chunks = splitCiaYmdRange(window.from, window.to, CIA_REFRESH_CHUNK_DAYS);
  const parts: Array<Record<string, unknown>> = [];
  for (const chunk of chunks) {
    const raw = await getWorker<Record<string, unknown>>("/api/admin/executive/cash-in-associate", {
      stationCode: code,
      fromDate: chunk.from,
      toDate: chunk.to
    });
    parts.push(raw);
  }

  const precomputedPayload = mergeCiaLiveParts(parts, window);
  const raw = await postWorkerJsonOnce<Record<string, unknown>>(
    "/api/admin/executive/cash-in-associate/refresh",
    { stationCode: code, precomputedPayload },
    { stationCode: code }
  );

  return {
    status: String(raw.status ?? "ok"),
    stationCode: String(raw.stationCode ?? code).toUpperCase(),
    runId: String(raw.runId ?? ""),
    snapshotStatus: String(raw.snapshotStatus ?? "ok"),
    error: raw.error == null ? null : String(raw.error)
  };
}

/** Start/resume full network snapshot (ticker processes one station every ~3 min). */
export async function refreshCiaNetwork(): Promise<CiaNetworkRefreshResult> {
  const raw = await postWorkerJsonOnce<Record<string, unknown>>(
    "/api/admin/executive/cash-in-associate/refresh",
    {}
  );
  const runRaw = raw.run && typeof raw.run === "object" ? (raw.run as Record<string, unknown>) : null;
  return {
    status: String(raw.status ?? "accepted"),
    resumed: Boolean(raw.resumed),
    run: runRaw
      ? {
          id: String(runRaw.id ?? ""),
          status: String(runRaw.status ?? "running"),
          stationsTotal: Number(runRaw.stationsTotal ?? 0) || 0,
          stationsOk: Number(runRaw.stationsOk ?? 0) || 0,
          stationsFailed: Number(runRaw.stationsFailed ?? 0) || 0
        }
      : null,
    message: String(raw.message ?? "Snapshot run started.")
  };
}
