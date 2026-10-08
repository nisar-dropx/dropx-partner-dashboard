import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadEddLedger } from "./edd-ledger";
import { stationEddToday, summarizeStationEdd, type StationEddSummary } from "./station-edd";

/** Stored counts older than this are recalculated on request. The background
 * capture rewrites every station each 15 minutes, so this only happens when a
 * capture is late or has not run yet (before 06:00 IST). */
export const STATION_EDD_SUMMARY_MAX_AGE_MS = 20 * 60 * 1000;
/** Stations read from the ledger at once, per server instance. Keeps the database load flat no matter how many tabs are open. */
const MAX_PARALLEL_STATIONS = 3;

export type StationEddNetworkSummary = {
  /** Stations whose counts are ready, in the requested order. */
  stations: StationEddSummary[];
  /** Not calculated within this request's time budget; ask again to continue. */
  pending: string[];
  /** Could not be read from the ledger on this request. */
  failed: string[];
  today: string;
  /** Oldest calculation time among the returned stations. */
  computedAt: string | null;
};

type CachedStationSummary = { summary: StationEddSummary; computedAt: string };

let activeStations = 0;
const waitingStations: Array<() => void> = [];
async function withStationSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeStations >= MAX_PARALLEL_STATIONS) await new Promise<void>(resolve => waitingStations.push(resolve));
  else activeStations++;
  try { return await task(); }
  finally {
    // Hand the slot straight to the next waiter; only release it when nobody is queued.
    const next = waitingStations.shift();
    if (next) next(); else activeStations--;
  }
}

/** The counts for one station, from the fields the rules read. Shared by the
 * background capture and the on-request fallback so both store the same numbers. */
export function stationEddSummaryFromLedger(code: string, ledger: { packages: Parameters<typeof summarizeStationEdd>[1]; fetchedAt: string } | undefined, today: string) {
  return ledger?.packages?.length ? summarizeStationEdd(code, ledger.packages, ledger.fetchedAt, today) : summarizeStationEdd(code, null, null, today);
}
/** Best effort: a failed write only means the next viewer or capture recalculates. */
export async function saveStationEddSummaries(summaries: StationEddSummary[], computedAt = new Date().toISOString()) {
  if (!supabaseAdmin || !summaries.length) return;
  const { error } = await supabaseAdmin.from("edd_station_summaries").upsert(
    summaries.map(summary => ({ station_code: summary.stationCode, edd_day: summary.today, summary, computed_at: computedAt })), { onConflict: "station_code" });
  if (error) console.warn("[station-edd-summary] counts were not stored", error.message);
}
async function summarizeStationFromLedger(code: string, today: string): Promise<CachedStationSummary> {
  const summary = stationEddSummaryFromLedger(code, (await loadEddLedger([code], "counting")).get(code), today);
  const computedAt = new Date().toISOString();
  await saveStationEddSummaries([summary], computedAt);
  return { summary, computedAt };
}

const inFlight = new Map<string, Promise<CachedStationSummary>>();
function computeStationSummary(code: string, today: string) {
  const key = `${today}:${code}`;
  let job = inFlight.get(key);
  if (!job) {
    job = withStationSlot(() => summarizeStationFromLedger(code, today)).finally(() => inFlight.delete(key));
    inFlight.set(key, job);
  }
  return job;
}

/** Counts already stored for today, by station. A read failure is treated as "nothing stored". */
async function storedStationSummaries(codes: string[], today: string) {
  const stored = new Map<string, CachedStationSummary>();
  if (!supabaseAdmin || !codes.length) return stored;
  const { data, error } = await supabaseAdmin.from("edd_station_summaries").select("station_code,summary,computed_at").in("station_code", codes).eq("edd_day", today);
  if (error) { console.warn("[station-edd-summary] stored counts could not be read", error.message); return stored; }
  for (const row of data ?? []) stored.set(row.station_code, { summary: row.summary as StationEddSummary, computedAt: new Date(row.computed_at).toISOString() });
  return stored;
}

/** Callers must resolve authorized station codes first. Serves the stored
 * counts; a station with none for today, or only stale ones, is recalculated
 * inside the time budget and the rest comes back as `pending` so the caller
 * can ask again instead of holding one long request open. */
export async function loadStationEddNetworkSummary(authorizedCodes: string[], budgetMs = 20000): Promise<StationEddNetworkSummary> {
  const codes = [...new Set(authorizedCodes)];
  const today = stationEddToday();
  const deadline = Date.now() + budgetMs;
  const stored = await storedStationSummaries(codes, today);
  const ready = new Map<string, CachedStationSummary>();
  for (const [code, entry] of stored) if (Date.now() - Date.parse(entry.computedAt) <= STATION_EDD_SUMMARY_MAX_AGE_MS) ready.set(code, entry);
  const due = codes.filter(code => !ready.has(code));
  const pending = new Set<string>(), failed = new Set<string>();
  let failure: unknown = null, cursor = 0;
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_STATIONS, due.length) }, async () => {
    while (cursor < due.length) {
      const code = due[cursor++];
      if (Date.now() > deadline) { pending.add(code); continue; }
      try { ready.set(code, await computeStationSummary(code, today)); }
      catch (cause) {
        // Older counts from today are better than none; `computedAt` tells the viewer their age.
        const earlier = stored.get(code);
        if (earlier) ready.set(code, earlier); else { failure ??= cause; failed.add(code); }
      }
    }
  }));
  if (!ready.size && failure) throw failure instanceof Error ? failure : new Error("Unable to load EDD backlog.");
  const computed = [...ready.values()].map(entry => entry.computedAt).sort();
  return {
    stations: codes.flatMap(code => ready.has(code) ? [ready.get(code)!.summary] : []),
    pending: codes.filter(code => pending.has(code)), failed: codes.filter(code => failed.has(code)),
    today, computedAt: computed[0] ?? null
  };
}
