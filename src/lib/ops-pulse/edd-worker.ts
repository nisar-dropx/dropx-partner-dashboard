export type EddBucketKey = "overdue" | "dueToday" | "dueTomorrow" | "future" | "unknown";

export type EddPackage = {
  trackingId: string;
  state: string | null;
  internalEAD: string | null;
  promisedDeliveryDate: string | null;
  estimatedArrivalTimeUTC: string | null;
  ead: string | null;
  bucket: EddBucketKey;
  minutesInState: number;
  lastScanBy: string | null;
  driverId: string | null;
  dspName: string | null;
  paymentMethod: string | null;
  city: string | null;
  postalCode: string | null;
  stateProvinceCode: string | null;
  orderingOrderId: string | null;
  shipOption: string | null;
  packageType: string | null;
  lockerName: string | null;
};

export type EddStationPayload = {
  status: string;
  stationCode: string;
  fetchedAt: string;
  todayYmd: string;
  window: { from: string; to: string };
  totalCount: number;
  buckets: Record<EddBucketKey, number>;
  byDate: Array<{ date: string; count: number }>;
  packages: EddPackage[];
  sessionSource: string | null;
  accountKey: string | null;
};

/** GET result: either a cached snapshot, or nothing has ever been saved for this station yet. */
export type EddStationResult =
  | { status: "ok"; payload: EddStationPayload }
  | { status: "no_snapshot"; stationCode: string };

/** One row of the network overview table — station + its latest cached totals. */
export type EddNetworkStation = {
  stationCode: string;
  hasSnapshot: boolean;
  fetchedAt: string | null;
  totalCount: number;
  buckets: Record<EddBucketKey, number>;
};

export type EddNetworkRunStatus = {
  id: string;
  status: "running" | "completed" | "failed";
  stationsTotal: number;
  stationsDone: number;
  stationsOk: number;
  stationsFailed: number;
  startedAt: string;
  finishedAt: string | null;
};

export type EddNetworkPayload = {
  asOf: string;
  stations: EddNetworkStation[];
  run: EddNetworkRunStatus | null;
};

function normalizeRun(raw: unknown): EddNetworkRunStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const status = String(entry.status ?? "");
  if (status !== "running" && status !== "completed" && status !== "failed") return null;
  return {
    id: String(entry.id ?? ""),
    status,
    stationsTotal: Number(entry.stationsTotal ?? 0) || 0,
    stationsDone: Number(entry.stationsDone ?? 0) || 0,
    stationsOk: Number(entry.stationsOk ?? 0) || 0,
    stationsFailed: Number(entry.stationsFailed ?? 0) || 0,
    startedAt: String(entry.startedAt ?? ""),
    finishedAt: entry.finishedAt == null ? null : String(entry.finishedAt)
  };
}

export class EddWorkerError extends Error {
  readonly code: string | null;
  constructor(message: string, options: { code?: string | null } = {}) {
    super(message);
    this.name = "EddWorkerError";
    this.code = options.code ?? null;
  }
}

function workerConfig() {
  const baseUrl = (process.env.EDD_WORKER_URL || "").trim().replace(/\/$/, "");
  const adminKey = (process.env.EDD_WORKER_ADMIN_KEY || "").trim();
  return { baseUrl, adminKey };
}

export function isEddWorkerConfigured() {
  const { baseUrl, adminKey } = workerConfig();
  return Boolean(baseUrl && adminKey);
}

function emptyBuckets(): Record<EddBucketKey, number> {
  return { overdue: 0, dueToday: 0, dueTomorrow: 0, future: 0, unknown: 0 };
}

function normalizeBuckets(raw: unknown): Record<EddBucketKey, number> {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const buckets = emptyBuckets();
  (Object.keys(buckets) as EddBucketKey[]).forEach((key) => {
    buckets[key] = Number(source[key] ?? 0) || 0;
  });
  return buckets;
}

function normalizePackage(raw: Record<string, unknown>): EddPackage {
  const bucket = String(raw.bucket ?? "unknown");
  const validBucket: EddBucketKey = ["overdue", "dueToday", "dueTomorrow", "future", "unknown"].includes(bucket)
    ? (bucket as EddBucketKey)
    : "unknown";
  return {
    trackingId: String(raw.trackingId ?? "").trim(),
    state: raw.state == null ? null : String(raw.state),
    internalEAD: raw.internalEAD == null ? null : String(raw.internalEAD),
    promisedDeliveryDate: raw.promisedDeliveryDate == null ? null : String(raw.promisedDeliveryDate),
    estimatedArrivalTimeUTC: raw.estimatedArrivalTimeUTC == null ? null : String(raw.estimatedArrivalTimeUTC),
    ead: raw.ead == null ? null : String(raw.ead),
    bucket: validBucket,
    minutesInState: Number(raw.minutesInState ?? 0) || 0,
    lastScanBy: raw.lastScanBy == null ? null : String(raw.lastScanBy),
    driverId: raw.driverId == null ? null : String(raw.driverId),
    dspName: raw.dspName == null ? null : String(raw.dspName),
    paymentMethod: raw.paymentMethod == null ? null : String(raw.paymentMethod),
    city: raw.city == null ? null : String(raw.city),
    postalCode: raw.postalCode == null ? null : String(raw.postalCode),
    stateProvinceCode: raw.stateProvinceCode == null ? null : String(raw.stateProvinceCode),
    orderingOrderId: raw.orderingOrderId == null ? null : String(raw.orderingOrderId),
    shipOption: raw.shipOption == null ? null : String(raw.shipOption),
    packageType: raw.packageType == null ? null : String(raw.packageType),
    lockerName: raw.lockerName == null ? null : String(raw.lockerName)
  };
}

function normalizePayload(raw: Record<string, unknown>, stationCode: string): EddStationPayload {
  const packages = Array.isArray(raw.packages)
    ? raw.packages.map((row) => normalizePackage((row ?? {}) as Record<string, unknown>))
    : [];
  const byDate = Array.isArray(raw.byDate)
    ? raw.byDate
        .map((row) => {
          const entry = (row ?? {}) as Record<string, unknown>;
          return { date: String(entry.date ?? ""), count: Number(entry.count ?? 0) || 0 };
        })
        .filter((row) => row.date)
    : [];
  const windowRaw = raw.window && typeof raw.window === "object" ? (raw.window as Record<string, unknown>) : {};

  return {
    status: String(raw.status ?? "ok"),
    stationCode: String(raw.stationCode ?? stationCode).toUpperCase(),
    fetchedAt: String(raw.fetchedAt ?? new Date().toISOString()),
    todayYmd: String(raw.todayYmd ?? ""),
    window: { from: String(windowRaw.from ?? ""), to: String(windowRaw.to ?? "") },
    totalCount: Number(raw.totalCount ?? packages.length) || packages.length,
    buckets: normalizeBuckets(raw.buckets),
    byDate,
    packages,
    sessionSource: raw.sessionSource == null ? null : String(raw.sessionSource),
    accountKey: raw.accountKey == null ? null : String(raw.accountKey)
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

/**
 * Reads the cached EDD snapshot for a station — instant, no live Amazon
 * calls. amazon-edd-worker's full bulk-enrichment pass takes ~60-90s, far
 * too slow for a page load, so this only ever reads what the daily cron or
 * a manual "Refresh live" (see refreshEddStation) last saved.
 */
export async function fetchEddStation(params: { stationCode: string }): Promise<EddStationResult> {
  const { baseUrl, adminKey } = workerConfig();
  if (!baseUrl || !adminKey) {
    throw new EddWorkerError("EDD worker is not configured. Set EDD_WORKER_URL and EDD_WORKER_ADMIN_KEY.");
  }

  const stationCode = params.stationCode.trim().toUpperCase();
  const url = new URL(`${baseUrl}/api/admin/executive/edd`);
  url.searchParams.set("stationCode", stationCode);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { "x-admin-key": adminKey, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(20000)
  });
  const raw = await readJson(response);

  if (!response.ok) {
    throw new EddWorkerError(String(raw.error ?? `EDD worker returned HTTP ${response.status}.`), {
      code: raw.code == null ? null : String(raw.code)
    });
  }
  if (raw.status === "no_snapshot") {
    return { status: "no_snapshot", stationCode };
  }
  return { status: "ok", payload: normalizePayload(raw, stationCode) };
}

/**
 * Network overview — every allowed station with its latest cached totals
 * (or hasSnapshot: false if it's never been refreshed). Always instant, this
 * is the EDD Dashboard's landing page, mirroring fetchCiaNetwork().
 */
export async function fetchEddNetwork(): Promise<EddNetworkPayload> {
  const { baseUrl, adminKey } = workerConfig();
  if (!baseUrl || !adminKey) {
    throw new EddWorkerError("EDD worker is not configured. Set EDD_WORKER_URL and EDD_WORKER_ADMIN_KEY.");
  }

  const response = await fetch(`${baseUrl}/api/admin/executive/edd/network`, {
    method: "GET",
    headers: { "x-admin-key": adminKey, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(20000)
  });
  const raw = await readJson(response);

  if (!response.ok) {
    throw new EddWorkerError(String(raw.error ?? `EDD worker returned HTTP ${response.status}.`), {
      code: raw.code == null ? null : String(raw.code)
    });
  }

  const stations = Array.isArray(raw.stations)
    ? raw.stations.map((row) => {
        const entry = (row ?? {}) as Record<string, unknown>;
        return {
          stationCode: String(entry.stationCode ?? "").toUpperCase(),
          hasSnapshot: Boolean(entry.hasSnapshot),
          fetchedAt: entry.fetchedAt == null ? null : String(entry.fetchedAt),
          totalCount: Number(entry.totalCount ?? 0) || 0,
          buckets: normalizeBuckets(entry.buckets)
        };
      })
    : [];

  return { asOf: String(raw.asOf ?? new Date().toISOString()), stations, run: normalizeRun(raw.run) };
}

/**
 * Starts (or reports the progress of) a network-wide background sweep —
 * idempotent, since the worker leaves an already-running sweep alone. The
 * sweep advances one station roughly every minute (the per-minute cron), so
 * this never blocks: it just kicks the sweep off and hands back its status.
 */
export async function refreshAllEddNetwork(): Promise<EddNetworkRunStatus | null> {
  const { baseUrl, adminKey } = workerConfig();
  if (!baseUrl || !adminKey) {
    throw new EddWorkerError("EDD worker is not configured. Set EDD_WORKER_URL and EDD_WORKER_ADMIN_KEY.");
  }

  const response = await fetch(`${baseUrl}/api/admin/executive/edd/network/refresh-all`, {
    method: "POST",
    headers: { "x-admin-key": adminKey, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(20000)
  });
  const raw = await readJson(response);

  if (!response.ok) {
    throw new EddWorkerError(String(raw.error ?? `EDD worker returned HTTP ${response.status}.`), {
      code: raw.code == null ? null : String(raw.code)
    });
  }
  return normalizeRun(raw.run);
}

/**
 * Triggers the slow (~60-90s) live pull + bulk enrichment for one station
 * and saves it as the new cached snapshot — what the dashboard's manual
 * "Refresh live" button calls.
 */
export async function refreshEddStation(params: { stationCode: string }): Promise<EddStationPayload> {
  const { baseUrl, adminKey } = workerConfig();
  if (!baseUrl || !adminKey) {
    throw new EddWorkerError("EDD worker is not configured. Set EDD_WORKER_URL and EDD_WORKER_ADMIN_KEY.");
  }

  const stationCode = params.stationCode.trim().toUpperCase();
  const url = new URL(`${baseUrl}/api/admin/executive/edd/refresh`);
  url.searchParams.set("stationCode", stationCode);

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: { "x-admin-key": adminKey, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(170000)
  });
  const raw = await readJson(response);

  if (!response.ok || raw.status !== "ok") {
    throw new EddWorkerError(String(raw.error ?? `EDD worker returned HTTP ${response.status}.`), {
      code: raw.code == null ? null : String(raw.code)
    });
  }
  return normalizePayload(raw, stationCode);
}

/** One package's role in a performance snapshot — enough to build the "By associate" driver breakdown. Only ever populated for today's snapshot. */
export type EddPerformancePackage = {
  trackingId: string;
  state: string | null;
  bucket: "delivered" | "returned" | "held" | "yetToDispatch";
  driverId: string | null;
  driverName: string | null;
  /** True when this "driver" is actually a locker/store access point, not a person — see amazon-edd-worker's eddPerformanceSnapshot.ts. */
  isAccessPoint: boolean;
  paymentMethod: string | null;
  city: string | null;
  orderingOrderId: string | null;
};

/** Assigned / delivered / returned / held for one station, always "today" (IST) — see the worker's PERFORMANCE_* config for exactly what counts as each bucket. */
/**
 * `assigned` is packages actually dispatched to a driver or store —
 * delivered + returned + held — and deliberately excludes `yetToDispatch`
 * (packages still sitting at the station with no driver/store attached,
 * e.g. just INDUCTED): those haven't started a delivery attempt, so
 * folding them into "assigned" would understate the real delivery
 * percentage. See amazon-edd-worker's PerformancePayload for the full
 * rationale — this mirrors that type exactly.
 */
export type EddPerformancePayload = {
  stationCode: string;
  window: { from: string; to: string };
  fetchedAt: string;
  assigned: number;
  delivered: number;
  returned: number;
  held: number;
  yetToDispatch: number;
  deliveredPct: number;
  returnedPct: number;
  heldPct: number;
  packages: EddPerformancePackage[];
};

/** One archived day for the "By date" / "Day-wise ledger" views — aggregate only, no per-package detail. */
export type EddPerformanceDailyRow = {
  stationCode: string;
  date: string;
  assigned: number;
  delivered: number;
  returned: number;
  held: number;
  yetToDispatch: number;
  deliveredPct: number;
  returnedPct: number;
  heldPct: number;
  updatedAt: string;
};

/** GET result: either a cached snapshot, or nothing has ever been saved for this station yet today. */
export type EddPerformanceResult =
  | { status: "ok"; payload: EddPerformancePayload }
  | { status: "no_snapshot"; stationCode: string };

export type EddPerformanceNetworkStation = {
  stationCode: string;
  hasSnapshot: boolean;
  fetchedAt: string | null;
  assigned: number;
  delivered: number;
  returned: number;
  held: number;
  yetToDispatch: number;
  deliveredPct: number;
  returnedPct: number;
  heldPct: number;
};

export type EddPerformanceNetworkPayload = {
  asOf: string;
  stations: EddPerformanceNetworkStation[];
  run: EddNetworkRunStatus | null;
};

function normalizePerformancePackage(raw: Record<string, unknown>): EddPerformancePackage {
  const bucket = String(raw.bucket ?? "held");
  const validBucket: EddPerformancePackage["bucket"] = ["delivered", "returned", "held", "yetToDispatch"].includes(bucket)
    ? (bucket as EddPerformancePackage["bucket"])
    : "held";
  return {
    trackingId: String(raw.trackingId ?? "").trim(),
    state: raw.state == null ? null : String(raw.state),
    bucket: validBucket,
    driverId: raw.driverId == null ? null : String(raw.driverId),
    driverName: raw.driverName == null ? null : String(raw.driverName),
    isAccessPoint: Boolean(raw.isAccessPoint),
    paymentMethod: raw.paymentMethod == null ? null : String(raw.paymentMethod),
    city: raw.city == null ? null : String(raw.city),
    orderingOrderId: raw.orderingOrderId == null ? null : String(raw.orderingOrderId)
  };
}

function normalizePerformancePayload(raw: Record<string, unknown>, stationCode: string): EddPerformancePayload {
  const windowRaw = raw.window && typeof raw.window === "object" ? (raw.window as Record<string, unknown>) : {};
  const packages = Array.isArray(raw.packages)
    ? raw.packages.map((row) => normalizePerformancePackage((row ?? {}) as Record<string, unknown>))
    : [];
  return {
    stationCode: String(raw.stationCode ?? stationCode).toUpperCase(),
    window: { from: String(windowRaw.from ?? ""), to: String(windowRaw.to ?? "") },
    fetchedAt: String(raw.fetchedAt ?? new Date().toISOString()),
    assigned: Number(raw.assigned ?? 0) || 0,
    delivered: Number(raw.delivered ?? 0) || 0,
    returned: Number(raw.returned ?? 0) || 0,
    held: Number(raw.held ?? 0) || 0,
    yetToDispatch: Number(raw.yetToDispatch ?? 0) || 0,
    deliveredPct: Number(raw.deliveredPct ?? 0) || 0,
    returnedPct: Number(raw.returnedPct ?? 0) || 0,
    heldPct: Number(raw.heldPct ?? 0) || 0,
    packages
  };
}

/** Reads today's cached performance snapshot for a station — instant, no live Amazon calls. Kept current by the 15-minute sweep and refreshEddPerformanceStation. */
export async function fetchEddPerformanceStation(params: { stationCode: string }): Promise<EddPerformanceResult> {
  const { baseUrl, adminKey } = workerConfig();
  if (!baseUrl || !adminKey) {
    throw new EddWorkerError("EDD worker is not configured. Set EDD_WORKER_URL and EDD_WORKER_ADMIN_KEY.");
  }

  const stationCode = params.stationCode.trim().toUpperCase();
  const url = new URL(`${baseUrl}/api/admin/executive/edd/performance`);
  url.searchParams.set("stationCode", stationCode);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { "x-admin-key": adminKey, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(20000)
  });
  const raw = await readJson(response);

  if (!response.ok) {
    throw new EddWorkerError(String(raw.error ?? `EDD worker returned HTTP ${response.status}.`), {
      code: raw.code == null ? null : String(raw.code)
    });
  }
  if (raw.status === "no_snapshot") {
    return { status: "no_snapshot", stationCode };
  }
  return { status: "ok", payload: normalizePerformancePayload(raw, stationCode) };
}

/** Recomputes and saves today's performance snapshot for one station — the dashboard's per-station "Refresh" button. */
export async function refreshEddPerformanceStation(params: { stationCode: string }): Promise<EddPerformancePayload> {
  const { baseUrl, adminKey } = workerConfig();
  if (!baseUrl || !adminKey) {
    throw new EddWorkerError("EDD worker is not configured. Set EDD_WORKER_URL and EDD_WORKER_ADMIN_KEY.");
  }

  const stationCode = params.stationCode.trim().toUpperCase();
  const url = new URL(`${baseUrl}/api/admin/executive/edd/performance/refresh`);
  url.searchParams.set("stationCode", stationCode);

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: { "x-admin-key": adminKey, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(30000)
  });
  const raw = await readJson(response);

  if (!response.ok || raw.status !== "ok") {
    throw new EddWorkerError(String(raw.error ?? `EDD worker returned HTTP ${response.status}.`), {
      code: raw.code == null ? null : String(raw.code)
    });
  }
  return normalizePerformancePayload(raw, stationCode);
}

/** Every allowed station's latest cached performance snapshot, plus the active sweep's progress if one is running. Always instant. */
export async function fetchEddPerformanceNetwork(): Promise<EddPerformanceNetworkPayload> {
  const { baseUrl, adminKey } = workerConfig();
  if (!baseUrl || !adminKey) {
    throw new EddWorkerError("EDD worker is not configured. Set EDD_WORKER_URL and EDD_WORKER_ADMIN_KEY.");
  }

  const response = await fetch(`${baseUrl}/api/admin/executive/edd/performance/network`, {
    method: "GET",
    headers: { "x-admin-key": adminKey, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(20000)
  });
  const raw = await readJson(response);

  if (!response.ok) {
    throw new EddWorkerError(String(raw.error ?? `EDD worker returned HTTP ${response.status}.`), {
      code: raw.code == null ? null : String(raw.code)
    });
  }

  const stations = Array.isArray(raw.stations)
    ? raw.stations.map((row) => {
        const entry = (row ?? {}) as Record<string, unknown>;
        return {
          stationCode: String(entry.stationCode ?? "").toUpperCase(),
          hasSnapshot: Boolean(entry.hasSnapshot),
          fetchedAt: entry.fetchedAt == null ? null : String(entry.fetchedAt),
          assigned: Number(entry.assigned ?? 0) || 0,
          delivered: Number(entry.delivered ?? 0) || 0,
          returned: Number(entry.returned ?? 0) || 0,
          held: Number(entry.held ?? 0) || 0,
          yetToDispatch: Number(entry.yetToDispatch ?? 0) || 0,
          deliveredPct: Number(entry.deliveredPct ?? 0) || 0,
          returnedPct: Number(entry.returnedPct ?? 0) || 0,
          heldPct: Number(entry.heldPct ?? 0) || 0
        };
      })
    : [];

  return { asOf: String(raw.asOf ?? new Date().toISOString()), stations, run: normalizeRun(raw.run) };
}

/** Starts (or reports the progress of) a network-wide performance sweep — idempotent, runs in the background on the worker side. */
export async function refreshAllEddPerformanceNetwork(): Promise<EddNetworkRunStatus | null> {
  const { baseUrl, adminKey } = workerConfig();
  if (!baseUrl || !adminKey) {
    throw new EddWorkerError("EDD worker is not configured. Set EDD_WORKER_URL and EDD_WORKER_ADMIN_KEY.");
  }

  const response = await fetch(`${baseUrl}/api/admin/executive/edd/performance/network/refresh-all`, {
    method: "POST",
    headers: { "x-admin-key": adminKey, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(20000)
  });
  const raw = await readJson(response);

  if (!response.ok) {
    throw new EddWorkerError(String(raw.error ?? `EDD worker returned HTTP ${response.status}.`), {
      code: raw.code == null ? null : String(raw.code)
    });
  }
  return normalizeRun(raw.run);
}

/** The worker's own recognized station codes (its ALLOWED_STATIONS) — used to filter out master-data rows that aren't real Amazon-tracked stations. Public, unauthenticated. */
export async function fetchEddAllowedStations(): Promise<Set<string>> {
  const { baseUrl } = workerConfig();
  if (!baseUrl) {
    throw new EddWorkerError("EDD worker is not configured. Set EDD_WORKER_URL.");
  }

  const response = await fetch(`${baseUrl}/api/stations`, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10000)
  });
  const raw = await readJson(response);
  if (!response.ok) {
    throw new EddWorkerError(String(raw.error ?? `EDD worker returned HTTP ${response.status}.`));
  }
  const stations = Array.isArray(raw.stations) ? raw.stations.map((code) => String(code).trim().toUpperCase()) : [];
  return new Set(stations);
}

/**
 * The day-over-day archive for one station — aggregate assigned/delivered/
 * returned/held per day, no per-package detail (only "today" ever has
 * that). Starts empty and fills in one real day at a time from whenever
 * the sweep/refresh started running against this station.
 */
export async function fetchEddPerformanceDaily(params: { stationCode: string; days?: number }): Promise<EddPerformanceDailyRow[]> {
  const { baseUrl, adminKey } = workerConfig();
  if (!baseUrl || !adminKey) {
    throw new EddWorkerError("EDD worker is not configured. Set EDD_WORKER_URL and EDD_WORKER_ADMIN_KEY.");
  }

  const stationCode = params.stationCode.trim().toUpperCase();
  const url = new URL(`${baseUrl}/api/admin/executive/edd/performance/daily`);
  url.searchParams.set("stationCode", stationCode);
  if (params.days) url.searchParams.set("days", String(params.days));

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { "x-admin-key": adminKey, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(20000)
  });
  const raw = await readJson(response);

  if (!response.ok) {
    throw new EddWorkerError(String(raw.error ?? `EDD worker returned HTTP ${response.status}.`), {
      code: raw.code == null ? null : String(raw.code)
    });
  }

  const rows = Array.isArray(raw.days) ? raw.days : [];
  return rows.map((row) => normalizePerformanceDailyRow((row ?? {}) as Record<string, unknown>, stationCode));
}

function normalizePerformanceDailyRow(entry: Record<string, unknown>, stationCode: string): EddPerformanceDailyRow {
  return {
    stationCode: String(entry.stationCode ?? stationCode).toUpperCase(),
    date: String(entry.date ?? ""),
    assigned: Number(entry.assigned ?? 0) || 0,
    delivered: Number(entry.delivered ?? 0) || 0,
    returned: Number(entry.returned ?? 0) || 0,
    held: Number(entry.held ?? 0) || 0,
    yetToDispatch: Number(entry.yetToDispatch ?? 0) || 0,
    deliveredPct: Number(entry.deliveredPct ?? 0) || 0,
    returnedPct: Number(entry.returnedPct ?? 0) || 0,
    heldPct: Number(entry.heldPct ?? 0) || 0,
    updatedAt: String(entry.updatedAt ?? "")
  };
}

/**
 * Pulls one specific past day live from Amazon and archives it — used when
 * "By date" picks a day the archive doesn't have yet (today is never
 * backfilled this way; it's always tracked live instead).
 */
export async function backfillEddPerformanceDay(params: { stationCode: string; date: string }): Promise<EddPerformanceDailyRow> {
  const { baseUrl, adminKey } = workerConfig();
  if (!baseUrl || !adminKey) {
    throw new EddWorkerError("EDD worker is not configured. Set EDD_WORKER_URL and EDD_WORKER_ADMIN_KEY.");
  }

  const stationCode = params.stationCode.trim().toUpperCase();
  const url = new URL(`${baseUrl}/api/admin/executive/edd/performance/backfill-day`);
  url.searchParams.set("stationCode", stationCode);
  url.searchParams.set("date", params.date);

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: { "x-admin-key": adminKey, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(60000)
  });
  const raw = await readJson(response);

  if (!response.ok) {
    throw new EddWorkerError(String(raw.error ?? `EDD worker returned HTTP ${response.status}.`), {
      code: raw.code == null ? null : String(raw.code)
    });
  }
  return normalizePerformanceDailyRow((raw.day ?? {}) as Record<string, unknown>, stationCode);
}

export type EddPerformanceBackfillStatus = { status: "started"; stationCode: string; days: number };

/**
 * Kicks off a background backfill of the last `days` calendar days for one
 * station — "download all the monthly data" for the Day-wise ledger.
 * Returns immediately; poll fetchEddPerformanceDaily for the same station
 * to watch days fill in.
 */
export async function backfillEddPerformanceHistory(params: { stationCode: string; days?: number }): Promise<EddPerformanceBackfillStatus> {
  const { baseUrl, adminKey } = workerConfig();
  if (!baseUrl || !adminKey) {
    throw new EddWorkerError("EDD worker is not configured. Set EDD_WORKER_URL and EDD_WORKER_ADMIN_KEY.");
  }

  const stationCode = params.stationCode.trim().toUpperCase();
  const url = new URL(`${baseUrl}/api/admin/executive/edd/performance/backfill`);
  url.searchParams.set("stationCode", stationCode);
  if (params.days) url.searchParams.set("days", String(params.days));

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: { "x-admin-key": adminKey, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(20000)
  });
  const raw = await readJson(response);

  if (!response.ok) {
    throw new EddWorkerError(String(raw.error ?? `EDD worker returned HTTP ${response.status}.`), {
      code: raw.code == null ? null : String(raw.code)
    });
  }
  return { status: "started", stationCode: String(raw.stationCode ?? stationCode).toUpperCase(), days: Number(raw.days ?? params.days ?? 30) };
}
