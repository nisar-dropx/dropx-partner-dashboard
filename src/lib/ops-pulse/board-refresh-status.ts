export function boardRefreshStatus(next: {
  refreshRunning?: boolean; refreshDone?: number; refreshPulled?: number;
  refreshTotal?: number; refreshFailed?: number;
}): string {
  const total = next.refreshTotal || 0;
  if (!total) return '';
  const saved = next.refreshDone || 0;
  const failed = next.refreshFailed || 0;
  if (next.refreshRunning) return `Refreshing in background · ${saved}/${total} saved${failed ? ` · ${failed} failed` : ''}`;
  if (failed || saved < total) return `Refresh incomplete · ${saved}/${total} saved · ${Math.max(failed, total - saved)} not updated. Previous data retained.`;
  return `Refresh complete · ${saved}/${total} saved`;
}
