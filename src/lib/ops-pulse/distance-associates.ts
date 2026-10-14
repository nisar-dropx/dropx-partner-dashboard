import type { DistanceEntry } from './distance-register';

/** Group only the already authorized, filtered rows, using identity, never name. */
export function summarizeDistanceAssociates(rows: DistanceEntry[]) {
  const groups = new Map<string, DistanceEntry[]>();
  for (const row of rows) {
    const group = groups.get(row.workforceId) ?? [];
    group.push(row);
    groups.set(row.workforceId, group);
  }
  return [...groups].map(([id, entries]) => {
    const days = [...entries].sort((a, b) => b.date.localeCompare(a.date) || a.station.localeCompare(b.station));
    const ready = days.filter(row => row.status === 'ready');
    const unique = (key: 'station' | 'amazonId' | 'dropxId') => [...new Set(days.map(row => row[key]).filter(Boolean))];
    const sources = [...new Set(days.map(row => row.method))].map(method => ({ method, count: days.filter(row => row.method === method).length }));
    const sum = (key: 'km' | 'fuel') => {
      const values = ready.map(row => row[key]).filter((value): value is number => value !== null);
      return values.length ? values.reduce((total, value) => total + value, 0) : null;
    };
    return { id, name: days[0].name, days, stations: unique('station'), amazonIds: unique('amazonId'), dropxIds: unique('dropxId'), sources,
      from: days[days.length - 1].date, to: days[0].date, dates: new Set(days.map(row => row.date)).size,
      ready: ready.length, pending: days.length - ready.length, km: sum('km'), fuel: sum('fuel') };
  });
}
