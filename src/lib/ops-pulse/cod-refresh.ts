import type { CodStatusSnapshot } from './cod-status';

/** The page polls only while visible. Failed/partial reads back off instead of
 * retrying on every render; explicit Refresh bypasses this scheduling decision. */
export function codRefreshDue(row: { snapshot?: CodStatusSnapshot; loading?: boolean; error?: string; lastAttemptAt?: number } | undefined, configuredMinutes: number | null | undefined, now: Date) {
  if (!row || row.loading || !row.lastAttemptAt) return false; // Initial load has its own bounded queue.
  const minutes = Number.isInteger(configuredMinutes) && Number(configuredMinutes) >= 1 && Number(configuredMinutes) <= 60 ? Number(configuredMinutes) : 15;
  const snapshot = row.snapshot;
  const incomplete = !!row.error || !snapshot || [snapshot.reconciliation, snapshot.prepareDeposit, snapshot.remittances].some(part => part.state !== 'ok' || !part.data);
  if (incomplete) return now.getTime() - row.lastAttemptAt >= Math.min(minutes, 5) * 60000;
  const times = [snapshot.fetchedAt, snapshot.reconciliation.checkedAt, snapshot.prepareDeposit.checkedAt, snapshot.remittances.checkedAt].map(Date.parse);
  const oldest = times.every(Number.isFinite) ? Math.min(...times) : row.lastAttemptAt;
  // Honour source age on cached loads; a minute guard avoids duplicate bursts.
  return now.getTime() - row.lastAttemptAt >= 60000 && now.getTime() - oldest >= minutes * 60000;
}
