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

/**
 * Calls amazon-edd-worker (a Cloudflare Worker, sibling of cash-recon-worker)
 * for one station's live (undelivered) backlog, bucketed by day-level EAD.
 * The worker reads its Amazon session from the same Supabase
 * `amazon_sessions` table cash-recon-worker maintains, so there is no
 * separate login/credentials to configure here — only the worker's own URL
 * and its `x-admin-key`.
 */
export async function fetchEddStation(params: {
  stationCode: string;
  fromDate?: string;
  toDate?: string;
}): Promise<EddStationPayload> {
  const { baseUrl, adminKey } = workerConfig();
  if (!baseUrl || !adminKey) {
    throw new EddWorkerError("EDD worker is not configured. Set EDD_WORKER_URL and EDD_WORKER_ADMIN_KEY.");
  }

  const stationCode = params.stationCode.trim().toUpperCase();
  const url = new URL(`${baseUrl}/api/admin/executive/edd`);
  url.searchParams.set("stationCode", stationCode);
  if (params.fromDate) url.searchParams.set("fromDate", params.fromDate);
  if (params.toDate) url.searchParams.set("toDate", params.toDate);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { "x-admin-key": adminKey, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(60000)
  });

  const text = await response.text();
  let raw: Record<string, unknown> = {};
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    raw = {};
  }

  if (!response.ok || raw.status !== "ok") {
    const message = String(raw.error ?? `EDD worker returned HTTP ${response.status}.`);
    throw new EddWorkerError(message, { code: raw.code == null ? null : String(raw.code) });
  }

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
