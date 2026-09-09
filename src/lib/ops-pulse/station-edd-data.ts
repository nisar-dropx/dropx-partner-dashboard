import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { EddPackage } from "@/lib/ops-pulse/edd-worker";
import { stationEddToday, summarizeStationEdd, type StationEddSummary } from "./station-edd";

/** Callers must resolve authorized station codes first. Small batches bound
 * memory; only summaries cross the browser boundary. This is the actual
 * backlog source, not the unrelated delivery-attempt performance feed. */
export async function loadStationEddNetwork(authorizedCodes: string[]) {
  if (!supabaseAdmin) throw new Error("EDD snapshot database is not configured.");
  const codes = [...new Set(authorizedCodes)];
  const today = stationEddToday();
  const summaries = new Map<string, StationEddSummary>();
  for (let offset = 0; offset < codes.length; offset += 6) {
    const { data, error } = await supabaseAdmin.from("edd_station_snapshots")
      .select("station_code,fetched_at,packages").in("station_code", codes.slice(offset, offset + 6));
    if (error) throw new Error(`Unable to read EDD backlog: ${error.message}`);
    for (const row of data ?? []) {
      if (!Array.isArray(row.packages)) throw new Error(`Invalid backlog snapshot for ${row.station_code}.`);
      summaries.set(row.station_code, summarizeStationEdd(row.station_code, row.packages as EddPackage[], row.fetched_at, today));
    }
  }
  return codes.map((code) => summaries.get(code) ?? summarizeStationEdd(code, null, null, today));
}
