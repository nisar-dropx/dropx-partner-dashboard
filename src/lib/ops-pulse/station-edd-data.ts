import "server-only";
import { loadEddLedger } from "./edd-ledger";
import type { EddPackage } from "@/lib/ops-pulse/edd-worker";
import { stationEddToday, summarizeStationEdd, type StationEddSummary } from "./station-edd";

/** Callers must resolve authorized station codes first. Small batches bound
 * memory; only summaries cross the browser boundary. This is the actual
 * backlog source, not the unrelated delivery-attempt performance feed. */
export async function loadStationEddNetwork(authorizedCodes: string[], onSnapshot?: (code: string, packages: EddPackage[], fetchedAt: string, today: string) => void) {
  const codes = [...new Set(authorizedCodes)];
  const today = stationEddToday();
  const summaries = new Map<string, StationEddSummary>();
  for (let offset = 0; offset < codes.length; offset += 6) {
    const ledger = await loadEddLedger(codes.slice(offset, offset + 6));
    for (const [code, row] of ledger) {
      summaries.set(code, summarizeStationEdd(code, row.packages, row.fetchedAt, today));
      onSnapshot?.(code, row.packages, row.fetchedAt, today);
    }
  }
  return codes.map((code) => summaries.get(code) ?? summarizeStationEdd(code, null, null, today));
}
