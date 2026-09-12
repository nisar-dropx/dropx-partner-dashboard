import "server-only";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { refreshEddStation, refreshEddPerformanceStation } from "./edd-worker";
import { stationEddToday } from "./station-edd";

type RefreshJob = { station_code: string; source: "stock" | "outcomes"; lease_token: string };
export function reviewRefreshError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/login is already in progress/i.test(message)) return "login_busy";
  if (/502/.test(message)) return "upstream_502";
  if (/timeout|timed out|abort/i.test(message)) return "timeout";
  if (/stale source response/i.test(message)) return "stale_response";
  return "upstream_error";
}

/** Database-backed queue: all tracked stations, two global HTTP lanes, 15-minute
 * success cadence, persistent retries and expired-lease recovery. The minute
 * cron is a recovery tick, NOT a full-network Amazon refresh every minute. */
export async function refreshReviewSources(now = new Date()) {
  const day = stationEddToday(now);
  if (now.getTime() < Date.parse(`${day}T05:30:00+05:30`)) return { refreshed: 0, skipped: "Before 05:30 IST" };
  if (!supabaseAdmin) throw Error("EDD refresh queue database is unavailable.");
  const db = supabaseAdmin;
  // Both RPCs use the same token on retry. The database recognises an already
  // committed claim/completion, including when its HTTP response was lost.
  async function queueRpc(name: string, args: Record<string, unknown>) {
    for (let attempt = 0; ; attempt++) {
      const response = await db.rpc(name, args);
      if (!response.error) return response;
      const code = /^[A-Z0-9]{5,12}$/.test(response.error.code ?? "") ? response.error.code : "network_or_timeout";
      console.warn("[edd-source-refresh] queue RPC unavailable", { operation: name, code, attempt: attempt + 1 });
      if (attempt >= 1) return response;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  const failedSources: string[] = [];
  const deadline = Date.now() + 270_000;
  let refreshed = 0, attempted = 0;
  const lanes = await Promise.allSettled(Array.from({ length: 2 }, async () => {
    // Leave room for bounded database retries and the 170s stock request. Unclaimed
    // jobs remain in Postgres; no location disappears when this process stops.
    while (Date.now() < deadline - 250_000) {
      if (stationEddToday(new Date()) !== day) break;
      const claim = await queueRpc("edd_claim_review_source", { p_token: randomUUID() });
      if (claim.error) throw Error("EDD refresh queue could not claim work.");
      const job = (claim.data as RefreshJob[] | null)?.[0];
      if (!job) break;
      attempted++;
      let sourceAt: string | null = null;
      let failure: ReturnType<typeof reviewRefreshError> | null = null;
      try {
        const result = job.source === "stock"
          ? await refreshEddStation({ stationCode: job.station_code, timeoutMs: 170_000 })
          : await refreshEddPerformanceStation({ stationCode: job.station_code });
        const fetched = Date.parse(result.fetchedAt);
        // Stock intentionally includes overdue/future backlog. Its window is
        // NOT today's outcome cohort; only todayYmd identifies the stock day.
        const correctDay = job.source === "stock"
          ? "todayYmd" in result && result.todayYmd === day
          : result.window.from === day && result.window.to === day;
        if (result.stationCode !== job.station_code || !Number.isFinite(fetched) || fetched > Date.now()
          || Date.now() - fetched > 15 * 60_000 || stationEddToday(new Date(fetched)) !== day
          || !correctDay) {
          throw Error("Stale source response");
        }
        sourceAt = result.fetchedAt;
      } catch (error) {
        failure = reviewRefreshError(error);
        failedSources.push(`${job.station_code}:${job.source}:${failure}`);
      }
      // Only the current lease owner may finish; a late response from an old
      // invocation cannot erase a newer attempt or its saved source timestamp.
      const saved = await queueRpc("edd_finish_review_source", { p_station_code: job.station_code,
        p_source: job.source, p_token: job.lease_token, p_source_at: sourceAt, p_error: failure });
      if (saved.error || saved.data !== true) throw Error("EDD refresh result was not saved; its lease will recover automatically.");
      if (!failure) refreshed++;
      // A shared login is already being recovered upstream. Keep remaining
      // jobs durable for the next tick instead of hammering all stations now.
      if (failure === "login_busy") break;
    }
  }));
  const interrupted = lanes.find(result => result.status === "rejected");
  if (interrupted?.status === "rejected") throw interrupted.reason;
  const queue = await db.from("ops_review_edd_refresh_jobs").select("station_code,source_at,last_error,next_attempt_at,lease_until");
  if (queue.error) throw Error("EDD refresh coverage could not be read.");
  const rows = queue.data ?? [], checkedAt = Date.now();
  const stations = [...new Set(rows.map(row => row.station_code))];
  const waitingStations = stations.filter(code => {
    const feeds = rows.filter(row => row.station_code === code);
    return feeds.length !== 2 || feeds.some(row => !row.source_at || checkedAt - Date.parse(row.source_at) > 35 * 60_000);
  });
  return { refreshed, attempted, failedSources, trackedStations: stations.length,
    freshStations: stations.length - waitingStations.length, waitingStations,
    retryingSources: rows.filter(row => row.last_error).length, targetRefreshMinutes: 15 };
}
