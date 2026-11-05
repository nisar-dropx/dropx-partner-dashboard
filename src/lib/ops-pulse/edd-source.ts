import "server-only";
import type { PackageHistoryEvent } from "./tracking-lookup";

// Amazon sessions and all upstream pacing are owned by the worker.
type Auth = { stationCode: string };
export class EddSourceBusyError extends Error {}
export type EddSourceSummary = {
  trackingId: string; currentPackageState?: string; estimatedArrivalDate?: number;
  promisedDeliveryDate?: number; shipOption?: string;
  lastUpdatedTime?: number;
};

export async function eddSourceSession(stationCode: string): Promise<Auth> {
  return { stationCode };
}

async function sourceRead(auth: Auth, resourcePath: string, requestBody: Record<string, unknown>) {
  const base = process.env.EDD_WORKER_URL?.trim().replace(/\/$/, "");
  const key = process.env.EDD_WORKER_ADMIN_KEY?.trim();
  if (!base || !key) throw new Error("EDD worker is not configured.");
  const operation = resourcePath === "/os/batchGetPackageSummary"
    ? { kind: "summary", ids: requestBody.identifiers }
    : { kind: "history", trackingId: requestBody.packageId, pageToken: requestBody.pageToken };
  const response = await fetch(`${base}/api/admin/executive/edd/verification-read`, {
    method: "POST", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(95000),
    headers: { "content-type": "application/json", "x-admin-key": key },
    body: JSON.stringify({ stationCode: auth.stationCode, ...operation })
  });
  if (response.status === 429) throw new EddSourceBusyError("Live refresh owns the Amazon read budget; verification will resume.");
  if (!response.ok) throw new Error(`EDD source unavailable (${response.status}).`);
  // Never log upstream HTML or credentials. Session refresh remains the worker's job.
  const body = await response.json().catch(() => null);
  if (!body || typeof body !== "object") throw new Error("EDD source returned an invalid response.");
  return body as Record<string, unknown>;
}

export async function eddSourceSummaries(stationCode: string, ids: string[], auth: Auth) {
  if (!ids.length || ids.length > 300) throw new Error("Invalid EDD summary batch.");
  const body = await sourceRead(auth, "/os/batchGetPackageSummary", {
    idType: "TRACKING_ID", identifiers: ids, nodeId: stationCode,
    includeFields: ["ESTIMATED_ARRIVAL_DATE", "SCHEDULED_DELIVERY_TIME", "SHIP_METHOD", "PROVIDER_ID", "SHIP_DATE", "SHIP_OPTION", "PROMISED_DELIVERY_DATE"]
  });
  if (!Array.isArray(body.packageSummaryList)) throw new Error("EDD summary list is unavailable.");
  const allowed = new Set(ids);
  return (body.packageSummaryList as EddSourceSummary[]).filter(row => row && allowed.has(String(row.trackingId)));
}

/** A full page with no continuation metadata is incomplete, never proof of no attempt. */
export async function eddSourceHistory(trackingId: string, auth: Auth) {
  const history: PackageHistoryEvent[] = [];
  const seen = new Set<string>();
  let token: string | null = null;
  for (let page = 0; page < 10; page++) {
    const body = await sourceRead(auth, "/os/getPackageHistoryData", {
      packageId: trackingId, pageSize: 20, pageToken: token, startTime: null, endTime: null
    });
    if (!Array.isArray(body.packageHistory)) throw new Error("EDD history is unavailable.");
    const events = body.packageHistory as Array<Record<string, unknown>>;
    for (const event of events) {
      const time = typeof event.stateTime === "number" && Number.isFinite(event.stateTime)
        ? new Date(event.stateTime).toISOString() : null;
      history.push({ state: String(event.packageState || ""), time,
        reasonCode: event.reasonCode == null ? null : String(event.reasonCode),
        scanBy: String(event.driverName || event.scanAssociate || "") || null,
        source: event.source == null ? null : String(event.source),
        destination: event.destination == null ? null : String(event.destination) });
    }
    const next = typeof body.nextPageToken === "string" ? body.nextPageToken : null;
    if (!next) return { history, historyComplete: events.length < 20,
      paginationKeys: Object.keys(body).filter(key => /token|page|more/i.test(key)) };
    if (seen.has(next)) break;
    seen.add(next); token = next;
  }
  return { history, historyComplete: false, paginationKeys: [] as string[] };
}
