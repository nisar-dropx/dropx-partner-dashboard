/**
 * Site Summary history selection helpers (pure).
 * Live tables hold the latest snapshot; history tables hold timed archives.
 */

export type SiteSummaryHistoryCandidate = {
  id: string;
  fetched_at: string;
};

/** Pick the newest history row at or before asOfMs. */
export function nearestSnapshotBefore(
  rows: SiteSummaryHistoryCandidate[],
  asOfMs: number
): SiteSummaryHistoryCandidate | null {
  let best: SiteSummaryHistoryCandidate | null = null;
  let bestMs = -Infinity;
  for (const row of rows ?? []) {
    const ms = Date.parse(row.fetched_at);
    if (!Number.isFinite(ms) || ms > asOfMs) continue;
    if (ms >= bestMs) {
      best = row;
      bestMs = ms;
    }
  }
  return best;
}

/** IST wall `YYYY-MM-DD` + `HH:mm` → UTC epoch ms. */
export function istWallClockMs(date: string, hour: number, minute = 0): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const h = Number.isFinite(hour) ? Math.trunc(hour) : 0;
  const m = Number.isFinite(minute) ? Math.trunc(minute) : 0;
  const utc = Date.parse(`${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`);
  if (!Number.isFinite(utc)) return NaN;
  return utc - 5.5 * 3600 * 1000;
}

/** Parse `asOf` query: ISO instant, or `YYYY-MM-DDTHH:mm` treated as IST. */
export function parseSiteSummaryAsOf(value: string | null | undefined, fallbackMs = Date.now()): number {
  const raw = String(value ?? "").trim();
  if (!raw) return fallbackMs;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const date = raw.slice(0, 10);
    const hour = Number(raw.slice(11, 13));
    const minute = Number(raw.slice(14, 16) || 0);
    const ms = istWallClockMs(date, hour, minute);
    return Number.isFinite(ms) ? ms : fallbackMs;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : fallbackMs;
}

export function shouldArchiveSiteSummaryHistory(input: {
  lastArchivedAtMs: number | null;
  nowMs: number;
  minIntervalMs?: number;
  previousSignature?: string | null;
  nextSignature: string;
}): boolean {
  const minInterval = input.minIntervalMs ?? 2 * 60 * 1000;
  if (input.previousSignature != null && input.previousSignature !== input.nextSignature) return true;
  if (input.lastArchivedAtMs == null) return true;
  return input.nowMs - input.lastArchivedAtMs >= minInterval;
}

export function siteSummaryArchiveSignature(parts: {
  activeOrders: number;
  pendingAcceptance: number;
  totalAssociates: number;
  waitingForOrders: number;
  picking: number;
}): string {
  return [
    parts.activeOrders,
    parts.pendingAcceptance,
    parts.totalAssociates,
    parts.waitingForOrders,
    parts.picking
  ].join("|");
}
