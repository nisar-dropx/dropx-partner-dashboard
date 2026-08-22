import { loadCodLocations } from "@/lib/ops-pulse/cod";

export type PackageHistoryEvent = {
  state: string;
  reasonCode: string | null;
  time: string | null;
  source: string | null;
  destination: string | null;
  scanBy: string | null;
};

export type TrackingLookupResult =
  | {
      status: "found";
      trackingId: string;
      stationCode: string;
      stationName: string | null;
      packageStatus: string | null;
      reasonCode: string | null;
      driverName: string | null;
      provider: string | null;
      shipDate: string | null;
      promisedDeliveryTime: string | null;
      estimatedArrivalTime: string | null;
      lastUpdatedTime: string | null;
      shipOption: string | null;
      itemDescription: string | null;
      merchantName: string | null;
      customerName: string | null;
      customerAddress: string | null;
      orderId: string | null;
      orderAmount: number | null;
      receivableAmount: number | null;
      paymentMethod: string | null;
      lockerName: string | null;
      history: PackageHistoryEvent[];
    }
  | { status: "not_found" }
  | { status: "not_configured" };

type WorkerLookupResponse = {
  status?: string;
  trackingId?: string;
  stationCode?: string;
  packageStatus?: string | null;
  reasonCode?: string | null;
  driverName?: string | null;
  provider?: string | null;
  shipDate?: string | null;
  promisedDeliveryTime?: string | null;
  estimatedArrivalTime?: string | null;
  lastUpdatedTime?: string | null;
  shipOption?: string | null;
  itemDescription?: string | null;
  merchantName?: string | null;
  customerName?: string | null;
  customerAddress?: string | null;
  orderId?: string | null;
  orderAmount?: number | null;
  receivableAmount?: number | null;
  paymentMethod?: string | null;
  lockerName?: string | null;
  history?: PackageHistoryEvent[];
};

function workerConfig() {
  const baseUrl = (process.env.EDD_WORKER_URL || "").trim().replace(/\/$/, "");
  const adminKey = (process.env.EDD_WORKER_ADMIN_KEY || "").trim();
  return { baseUrl, adminKey };
}

async function lookupViaStationSession(baseUrl: string, adminKey: string, stationCode: string, trackingId: string): Promise<WorkerLookupResponse | null> {
  try {
    const url = new URL(`${baseUrl}/api/admin/executive/edd/lookup`);
    url.searchParams.set("stationCode", stationCode);
    url.searchParams.set("trackingId", trackingId);
    const response = await fetch(url.toString(), {
      headers: { "x-admin-key": adminKey, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) return null;
    const payload = (await response.json().catch(() => ({}))) as WorkerLookupResponse;
    return payload.status === "ok" ? payload : null;
  } catch {
    return null;
  }
}

/** How many of the caller's own stations to try as a session source before giving up. */
const MAX_SESSION_ATTEMPTS = 3;

/**
 * Looks up one tracking ID live against Amazon SCC — the exact
 * `getPackageDetailData` + `getPackageHistoryData` calls Amazon's own
 * station-portal search page makes.
 *
 * Important: Amazon's `nodeId` parameter does NOT scope this resource to one
 * station — confirmed against real traffic, querying a KTUO tracking ID
 * through a completely different station's session still returned it. So
 * `stationCode` here is only used to obtain a *working Amazon session*
 * (tried against a couple of the caller's own stations in case one account's
 * session happens to be stale) — it is never trusted for authorization.
 * Authorization instead checks Amazon's own answer: the real station the
 * response reports back (`stationCode` in the result) must be one the
 * caller is allowed to see, or the whole lookup reports "not_found" (never
 * naming the other station, to avoid leaking its existence).
 */
export async function lookupTrackingId(params: {
  companyId: string;
  trackingId: string;
  locationScopeIds: string[];
  hasAllLocationAccess: boolean;
}): Promise<TrackingLookupResult> {
  const { baseUrl, adminKey } = workerConfig();
  if (!baseUrl || !adminKey) return { status: "not_configured" };

  const trackingId = params.trackingId.trim();
  if (!trackingId) return { status: "not_found" };

  const { locations } = await loadCodLocations(params.companyId, params.locationScopeIds, params.hasAllLocationAccess);
  const byStationCode = new Map(
    locations
      .map((location) => [String(location.station_code ?? "").trim().toUpperCase(), location] as const)
      .filter(([code]) => Boolean(code))
  );
  const ownStationCodes = [...byStationCode.keys()];
  if (!ownStationCodes.length) return { status: "not_found" };

  let found: WorkerLookupResponse | null = null;
  for (const stationCode of ownStationCodes.slice(0, MAX_SESSION_ATTEMPTS)) {
    found = await lookupViaStationSession(baseUrl, adminKey, stationCode, trackingId);
    if (found) break;
  }
  if (!found) return { status: "not_found" };

  const actualStationCode = String(found.stationCode ?? "").trim().toUpperCase();
  const location = byStationCode.get(actualStationCode);
  const authorized = params.hasAllLocationAccess || Boolean(location);
  if (!authorized) return { status: "not_found" };

  return {
    status: "found",
    trackingId: String(found.trackingId ?? trackingId),
    stationCode: actualStationCode,
    stationName: location?.station_name ?? null,
    packageStatus: found.packageStatus ?? null,
    reasonCode: found.reasonCode ?? null,
    driverName: found.driverName ?? null,
    provider: found.provider ?? null,
    shipDate: found.shipDate ?? null,
    promisedDeliveryTime: found.promisedDeliveryTime ?? null,
    estimatedArrivalTime: found.estimatedArrivalTime ?? null,
    lastUpdatedTime: found.lastUpdatedTime ?? null,
    shipOption: found.shipOption ?? null,
    itemDescription: found.itemDescription ?? null,
    merchantName: found.merchantName ?? null,
    customerName: found.customerName ?? null,
    customerAddress: found.customerAddress ?? null,
    orderId: found.orderId ?? null,
    orderAmount: found.orderAmount ?? null,
    receivableAmount: found.receivableAmount ?? null,
    paymentMethod: found.paymentMethod ?? null,
    lockerName: found.lockerName ?? null,
    history: Array.isArray(found.history) ? found.history : []
  };
}
