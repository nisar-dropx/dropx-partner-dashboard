export type BoardRefreshFailedStation = {
  stationCode: string;
  attempts?: number;
  retrying?: boolean;
  reason?: string;
};

const NAME_LIMIT = 6;
const REASON_LIMIT = 3;

function formatStationList(codes: string[]): string {
  if (!codes.length) return '';
  if (codes.length <= NAME_LIMIT) return codes.join(', ');
  const shown = codes.slice(0, NAME_LIMIT);
  return `${shown.join(', ')} +${codes.length - NAME_LIMIT} more`;
}

/** Short Ops note naming up to a few station:reason pairs. */
export function boardRefreshReasonNote(
  failedStations?: BoardRefreshFailedStation[] | null,
): string {
  if (!failedStations?.length) return '';
  const parts = failedStations
    .filter((row) => row.stationCode && row.reason)
    .slice(0, REASON_LIMIT)
    .map((row) => `${row.stationCode}: ${String(row.reason).replace(/;?\s*retry required\.?$/i, '').trim()}`);
  if (!parts.length) return '';
  const extra = failedStations.length > REASON_LIMIT ? ` +${failedStations.length - REASON_LIMIT} more` : '';
  return parts.join(' · ') + extra;
}

export function boardRefreshStatus(next: {
  refreshRunning?: boolean;
  refreshDone?: number;
  refreshPulled?: number;
  refreshTotal?: number;
  refreshFailed?: number;
  refreshFailedStations?: BoardRefreshFailedStation[] | null;
}): string {
  const total = next.refreshTotal || 0;
  if (!total) return '';
  const saved = next.refreshDone || 0;
  const pulled = Math.max(saved, next.refreshPulled || 0);
  const listed = next.refreshFailedStations ?? [];
  const retryingCodes = listed
    .filter((row) => row.retrying)
    .map((row) => row.stationCode)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const leftoverCodes = listed
    .map((row) => row.stationCode)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const failedCount = Math.max(
    next.refreshFailed || 0,
    leftoverCodes.length,
    listed.length,
  );
  // Pulled can lead saved while KV drains serially to Supabase — only show when gap is meaningful.
  const pulledNote = pulled > saved + 2 ? ` · pulled ${pulled}/${total}` : '';

  if (next.refreshRunning) {
    if (retryingCodes.length || (failedCount > 0 && leftoverCodes.length)) {
      const codes = retryingCodes.length ? retryingCodes : leftoverCodes;
      const count = Math.max(failedCount, codes.length);
      return `Refreshing · ${saved}/${total} saved · retrying ${count} (${formatStationList(codes)})`;
    }
    if (failedCount > 0) {
      return `Refreshing · ${saved}/${total} saved · retrying ${failedCount}`;
    }
    return `Refreshing · ${saved}/${total} saved${pulledNote}`;
  }

  if (failedCount > 0 || saved < total) {
    const notUpdated = Math.max(failedCount, total - saved);
    if (leftoverCodes.length) {
      return `Refresh complete · ${saved}/${total} saved · ${notUpdated} not updated: ${formatStationList(leftoverCodes)} · previous data kept`;
    }
    return `Refresh complete · ${saved}/${total} saved · ${notUpdated} not updated · previous data kept`;
  }
  return `Refresh complete · ${saved}/${total} saved`;
}
