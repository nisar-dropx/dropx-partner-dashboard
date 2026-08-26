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

/** Assigned / delivered / returned / held for one station over a window — see the worker's PERFORMANCE_* config for exactly what counts as each bucket. */
export type EddPerformancePayload = {
  stationCode: string;
  window: { from: string; to: string };
  fetchedAt: string;
  assigned: number;
  delivered: number;
  returned: number;
  held: number;
  deliveredPct: number;
  returnedPct: number;
  heldPct: number;
};

/**
 * Live (never cached) — mirrors Amazon's own ageing dashboard's combined
 * status query (adds "Delivered" on top of the live-only EDD statuses), so
 * "assigned" matches what station staff see natively. Can take a while for
 * a wide date range since it's a real Amazon fetch on every call.
 */
export async function fetchEddPerformance(params: { stationCode: string; from: string; to: string }): Promise<EddPerformancePayload> {
  const { baseUrl, adminKey } = workerConfig();
  if (!baseUrl || !adminKey) {
    throw new EddWorkerError("EDD worker is not configured. Set EDD_WORKER_URL and EDD_WORKER_ADMIN_KEY.");
  }

  const stationCode = params.stationCode.trim().toUpperCase();
  const url = new URL(`${baseUrl}/api/admin/executive/edd/performance`);
  url.searchParams.set("stationCode", stationCode);
  url.searchParams.set("from", params.from);
  url.searchParams.set("to", params.to);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { "x-admin-key": adminKey, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(90000)
  });
  const raw = await readJson(response);

  if (!response.ok || raw.status !== "ok") {
    throw new EddWorkerError(String(raw.error ?? `EDD worker returned HTTP ${response.status}.`), {
      code: raw.code == null ? null : String(raw.code)
    });
  }

  const windowRaw = raw.window && typeof raw.window === "object" ? (raw.window as Record<string, unknown>) : {};
  return {
    stationCode: String(raw.stationCode ?? stationCode).toUpperCase(),
    window: { from: String(windowRaw.from ?? params.from), to: String(windowRaw.to ?? params.to) },
    fetchedAt: String(raw.fetchedAt ?? new Date().toISOString()),
    assigned: Number(raw.assigned ?? 0) || 0,
    delivered: Number(raw.delivered ?? 0) || 0,
    returned: Number(raw.returned ?? 0) || 0,
    held: Number(raw.held ?? 0) || 0,
    deliveredPct: Number(raw.deliveredPct ?? 0) || 0,
    returnedPct: Number(raw.returnedPct ?? 0) || 0,
    heldPct: Number(raw.heldPct ?? 0) || 0
  };
}
