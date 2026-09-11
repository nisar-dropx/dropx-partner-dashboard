import { fetchEddNetwork, fetchEddPerformanceNetwork, refreshEddStation, refreshEddPerformanceStation } from "./edd-worker";
import { stationEddToday } from "./station-edd";

type SourceStation = { stationCode: string; fetchedAt: string | null };
const loginBusy = (error: unknown) => error instanceof Error && /login is already in progress/i.test(error.message);
export async function retrySharedLogin<T>(operation: () => Promise<T>, wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {
  try { return await operation(); }
  catch (error) {
    if (!loginBusy(error)) throw error;
    // Respect the upstream lease. No forced login or lock removal; one delayed
    // retry uses the shared session once the other worker has finished.
    await wait(10_000);
    return operation();
  }
}
export function reviewRefreshCandidates(stock: SourceStation[], outcomes: SourceStation[], now = new Date()) {
  const stocks = new Map(stock.map(row => [row.stationCode, Date.parse(row.fetchedAt || "") || 0]));
  const routes = new Map(outcomes.map(row => [row.stationCode, Date.parse(row.fetchedAt || "") || 0]));
  const codes = [...new Set([...stocks.keys(), ...routes.keys()])].sort();
  // Rotate even when an upstream station is failing, so permanent failures
  // cannot starve the rest of the network of refreshes.
  const groups = Math.max(1, Math.ceil(codes.length / 8));
  const offset = (Math.floor(now.getTime() / 300_000) % groups) * 8;
  return codes.slice(offset, offset + 8).map(stationCode => ({ stationCode,
    oldest: Math.min(stocks.get(stationCode) ?? 0, routes.get(stationCode) ?? 0) }))
    .filter(row => now.getTime() - row.oldest >= 5 * 60_000)
    .sort((a, b) => a.oldest - b.oldest || a.stationCode.localeCompare(b.stationCode)).slice(0, 8);
}

/** Eight rotating stations per five-minute run covers the 38-station network
 * inside 30 minutes. Four bounded lanes avoid a 38-way source request burst.
 * Start at 05:30 IST to warm both feeds before the 06:00 checkpoint. */
export async function refreshReviewSources(now = new Date()) {
  const day = stationEddToday(now);
  if (now.getTime() < Date.parse(`${day}T05:30:00+05:30`)) return { refreshed: 0, skipped: "Before 05:30 IST" };
  const [stock, outcomes] = await Promise.all([fetchEddNetwork(), fetchEddPerformanceNetwork()]);
  const candidates = reviewRefreshCandidates(stock.stations, outcomes.stations, now);
  const failedSources: string[] = [];
  const deadline = Date.now() + 240_000;
  let cursor = 0, refreshed = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < candidates.length) {
      const { stationCode } = candidates[cursor++];
      if (Date.now() > deadline - 30_000) {
        failedSources.push(`${stationCode}:refresh-deferred`); continue;
      }
      let outcomeOk = false;
      try {
        // Outcomes first: do not race stock and outcomes for the same login.
        await retrySharedLogin(() => refreshEddPerformanceStation({ stationCode }));
        outcomeOk = true;
      } catch (error) {
        failedSources.push(`${stationCode}:outcomes`);
        if (loginBusy(error)) { failedSources.push(`${stationCode}:stock-login-busy`); continue; }
      }
      try {
        await retrySharedLogin(() => {
          const remaining = deadline - Date.now();
          if (remaining < 1000) throw Error("Refresh deadline reached");
          return refreshEddStation({ stationCode, timeoutMs: Math.min(110_000, remaining) });
        });
        if (outcomeOk) refreshed++;
      } catch { failedSources.push(`${stationCode}:stock`); }
    }
  }));
  return { refreshed, attempted: candidates.length, failedSources };
}
