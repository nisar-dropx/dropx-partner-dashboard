import type { ScrubTypeActivity, StationScrubActivity } from './edd-worker';

export const scrubTypes = ['inStation', 'onRoad'] as const;
export type ScrubStatus = 'done' | 'pending' | 'none' | 'stale' | 'unavailable';
export const scrubStatusLabels: Record<ScrubStatus, string> = {
  done: 'Done today', pending: 'Pending', none: '7+ days pending', stale: 'Refresh needed', unavailable: 'Unavailable'
};
export type ScrubSort = 'pending' | 'station' | 'inStation' | 'onRoad' | 'latest';
export type ScrubCluster = { value: string; label: string; stations: string[] };
export const scrubDay = (value: Date | string) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date(value));
export const scrubDays = (now: Date) => Array.from({length: 7}, (_, i) =>
  new Date(Date.parse(`${scrubDay(now)}T12:00:00Z`) - i * 86400000).toISOString().slice(0, 10));
const validTime = (value: string | null) => value != null && Number.isFinite(Date.parse(value));

export function summarizeScrub(activity: ScrubTypeActivity, fetchedAt: string | null, now: Date) {
  const today = scrubDay(now);
  const days = new Set(scrubDays(now));
  const invocations = activity.invocations.filter(item => validTime(item.at) && Date.parse(item.at) <= now.getTime())
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const lastAt = [activity.lastAt, invocations[0]?.at ?? null].filter((value): value is string =>
    validTime(value) && Date.parse(value!) <= now.getTime()).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  const gap = lastAt ? Math.max(0, Math.round((Date.parse(today) - Date.parse(scrubDay(lastAt))) / 86400000)) : null;
  const fresh = validTime(fetchedAt) && scrubDay(fetchedAt!) === today;
  const status: ScrubStatus = gap === 0 ? 'done' : activity.error || !validTime(fetchedAt) ? 'unavailable' : !fresh ? 'stale' : lastAt ? 'pending' : 'none';
  return { status, lastAt, invocations, error: activity.error,
    pendingDays: status === 'done' ? 0 : status === 'pending' ? gap : status === 'none' ? 7 : null,
    daysScrubbed: new Set(invocations.map(item => scrubDay(item.at)).filter(day => days.has(day))).size,
    label: status === 'pending' ? `${gap}d pending` : scrubStatusLabels[status] };
}
export type ScrubSummary = ReturnType<typeof summarizeScrub>;
export function scrubStationRows(data: StationScrubActivity[], stationNames: Record<string, string>, now: Date) {
  const byCode = new Map(data.map(row => [row.stationCode, row]));
  const missing: ScrubTypeActivity = {lastAt: null, invocations: [], error: 'No saved result for this station.'};
  // The scoped directory is authoritative. Missing worker rows remain visible; extra rows never escape scope.
  return Object.entries(stationNames).map(([stationCode, name]) => {
    const station = byCode.get(stationCode);
    const fetchedAt = station?.fetchedAt ?? null;
    return {stationCode, name, fetchedAt,
      inStation: summarizeScrub(station?.inStation ?? missing, fetchedAt, now),
      onRoad: summarizeScrub(station?.onRoad ?? missing, fetchedAt, now)};
  });
}
export type ScrubStationRow = ReturnType<typeof scrubStationRows>[number];
export function filterScrubRows(rows: ScrubStationRow[], clusters: ScrubCluster[], filters: {
  stations: string[]; clusters: string[]; inStation: string[]; onRoad: string[]; search: string; sort: ScrubSort;
}) {
  const clusterStations = new Set(clusters.filter(c => filters.clusters.includes(c.value)).flatMap(c => c.stations));
  const term = filters.search.trim().toLowerCase();
  const urgency = (value: ScrubSummary) => value.pendingDays ?? 0.5;
  const worst = (row: ScrubStationRow) => Math.max(urgency(row.inStation), urgency(row.onRoad));
  const latest = (row: ScrubStationRow) => Math.max(Date.parse(row.inStation.lastAt ?? '') || 0, Date.parse(row.onRoad.lastAt ?? '') || 0);
  return rows.filter(row => (!filters.stations.length || filters.stations.includes(row.stationCode))
    && (!filters.clusters.length || clusterStations.has(row.stationCode))
    && (!filters.inStation.length || filters.inStation.includes(row.inStation.status))
    && (!filters.onRoad.length || filters.onRoad.includes(row.onRoad.status))
    && (!term || `${row.stationCode} ${row.name}`.toLowerCase().includes(term)))
    .sort((a, b) => (filters.sort === 'station' ? 0 : filters.sort === 'latest' ? latest(b) - latest(a)
      : filters.sort === 'inStation' || filters.sort === 'onRoad' ? urgency(b[filters.sort]) - urgency(a[filters.sort])
      : worst(b) - worst(a)) || a.stationCode.localeCompare(b.stationCode));
}
export function scrubCsv(rows: ScrubStationRow[]) {
  const cell = (value: unknown) => {
    const text = String(value ?? '');
    return `"${(/^[=+\-@\t\r]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
  };
  const header = ['Station', 'Name', ...['In-station', 'On-road'].flatMap(type =>
    [`${type} status`, `${type} pending days (7+ is a lower bound)`, `${type} last scrub`, `${type} days scrubbed (7d)`, `${type} history`]), 'Fetched at'];
  return '\uFEFF' + [header, ...rows.map(row => [row.stationCode, row.name, ...scrubTypes.flatMap(type => {
    const value = row[type];
    return [value.label, value.status === 'none' ? '7+' : value.pendingDays, value.lastAt, value.daysScrubbed,
      value.invocations.map(item => `${item.at} · ${item.operator ?? 'Unknown'}`).join(' | ')];
  }), row.fetchedAt])].map(row => row.map(cell).join(',')).join('\r\n');
}
