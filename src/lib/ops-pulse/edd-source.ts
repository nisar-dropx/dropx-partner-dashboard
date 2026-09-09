import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { PackageHistoryEvent } from "./tracking-lookup";

// Verified against amazon-edd-worker's production configuration on 9 Sep 2026.
// Fixed origin: never send the shared session to a caller-supplied URL.
const origin = "https://www.amazonlogistics.eu";
type Auth = { cookie: string; x_api_usage_key: string };
export type EddSourceSummary = {
  trackingId: string; currentPackageState?: string; estimatedArrivalDate?: number;
  promisedDeliveryDate?: number; shipOption?: string;
};

export async function eddSourceSession(stationCode: string): Promise<Auth> {
  if (!supabaseAdmin) throw new Error("EDD database is not configured.");
  const { data: station, error: stationError } = await supabaseAdmin.from("edd_station_snapshots")
    .select("account_key").eq("station_code", stationCode).maybeSingle();
  if (stationError || !station) throw new Error("Station source account is unavailable.");
  const { data, error } = await supabaseAdmin.from("amazon_sessions")
    .select("cookie,x_api_usage_key").eq("account_key", station.account_key || "default")
    .eq("status", "active").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error || !data?.cookie || !data?.x_api_usage_key) throw new Error("Station source session needs refresh.");
  return data as Auth;
}

async function sourceRead(auth: Auth, resourcePath: string, requestBody: Record<string, unknown>) {
  const response = await fetch(`${origin}/station/proxyapigateway/data`, {
    method: "POST", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(12000),
    headers: { "content-type": "application/json", accept: "*/*", "accept-language": "en-US,en;q=0.9",
      origin, referer: `${origin}/station/dashboard/search`, cookie: auth.cookie,
      "x-api-usage-key": auth.x_api_usage_key, "x-requested-with": "XMLHttpRequest",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36" },
    body: JSON.stringify({ resourcePath, httpMethod: "post", processName: "oculus", requestBody })
  });
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
