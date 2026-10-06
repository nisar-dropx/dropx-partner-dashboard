import "server-only";
import { unstable_cache } from "next/cache";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { EddPackage } from "./edd-worker";
import { eddCurrentState, type EddVerification } from "./edd-verification";
import { stationEddToday, summarizeStationEdd, type StationEddSummary } from "./station-edd";

/** How long one station's counts are shared by every viewer before they are recalculated. */
export const STATION_EDD_SUMMARY_TTL_SECONDS = 180;
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

// Only the fields the counting rules read. The full `source` document is
// ~2 KB a row; pulling it for ~215k rows on every page view and every
// minute per open tab is what saturated the database (2026-09-29, 2026-10).
const SUMMARY_COLUMNS = [
  "tracking_id", "source_at", "verified_at", "verification",
  "state:source->state", "ead:source->ead", "internalEAD:source->internalEAD",
  "promisedDeliveryDate:source->promisedDeliveryDate", "packageType:source->packageType",
  "shipOption:source->shipOption", "summaryCheckedAt:source->summaryCheckedAt",
  "stateUpdatedAt:source->stateUpdatedAt"
].join(",");

type SummaryRow = {
  tracking_id: string; source_at: string; verified_at: string | null; verification: EddVerification | null;
  state: string | null; ead: string | null; internalEAD: string | null; promisedDeliveryDate: string | null;
  packageType: string | null; shipOption: string | null; summaryCheckedAt: string | null; stateUpdatedAt: string | null;
};

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

async function summarizeStationFromLedger(code: string, today: string): Promise<CachedStationSummary> {
  if (!supabaseAdmin) throw new Error("EDD database is not configured.");
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const packages: EddPackage[] = [];
  let fetchedAt: string | null = null;
  // Same keyset walk as loadEddLedger: one station, ordered by the primary key, no OFFSET and no sort.
  for (let after = ""; ;) {
    let query = supabaseAdmin.from("edd_package_ledger").select(SUMMARY_COLUMNS)
      .eq("station_code", code).gte("last_seen_at", since).order("tracking_id").limit(1000);
    if (after) query = query.gt("tracking_id", after);
    const { data, error } = await query;
    if (error) throw new Error(`Unable to load verified EDD records: ${error.message}`);
    const page = (data ?? []) as unknown as SummaryRow[];
    for (const row of page) {
      const pkg = {
        state: row.state, ead: row.ead, internalEAD: row.internalEAD, promisedDeliveryDate: row.promisedDeliveryDate,
        packageType: row.packageType, shipOption: row.shipOption,
        summaryCheckedAt: row.summaryCheckedAt ?? undefined, stateUpdatedAt: row.stateUpdatedAt,
        observedStationCode: code, trackingId: row.tracking_id, sourceAt: row.source_at,
        verifiedAt: row.verified_at, verification: row.verification
      } as EddPackage;
      pkg.state = eddCurrentState(pkg);
      packages.push(pkg);
      fetchedAt = [fetchedAt ?? row.source_at, row.source_at, row.verified_at || ""].sort().at(-1)!;
    }
    if (page.length < 1000) break;
    after = page[page.length - 1].tracking_id;
  }
  return {
    summary: packages.length ? summarizeStationEdd(code, packages, fetchedAt, today) : summarizeStationEdd(code, null, null, today),
    computedAt: new Date().toISOString()
  };
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

// Shared across every viewer and server instance. `today` is part of the key
// so the IST day rollover never serves yesterday's cohort.
const cachedStationSummary = unstable_cache(computeStationSummary, ["station-edd-summary-v1"], { revalidate: STATION_EDD_SUMMARY_TTL_SECONDS });

/** Callers must resolve authorized station codes first. Returns whatever is
 * ready inside the time budget; the rest comes back as `pending` so the
 * caller can ask again instead of holding one long request open. */
export async function loadStationEddNetworkSummary(authorizedCodes: string[], budgetMs = 20000): Promise<StationEddNetworkSummary> {
  const codes = [...new Set(authorizedCodes)];
  const today = stationEddToday();
  const deadline = Date.now() + budgetMs;
  const ready = new Map<string, CachedStationSummary>();
  const pending = new Set<string>(), failed = new Set<string>();
  let failure: unknown = null, cursor = 0;
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_STATIONS, codes.length) }, async () => {
    while (cursor < codes.length) {
      const code = codes[cursor++];
      if (Date.now() > deadline) { pending.add(code); continue; }
      try { ready.set(code, await cachedStationSummary(code, today)); }
      catch (cause) { failure ??= cause; failed.add(code); }
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
