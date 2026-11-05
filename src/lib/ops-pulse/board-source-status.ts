import type { StationBoardStation } from './station-board';
import type { BoardShareTable } from './station-board-share';

export function boardSourceStatus(station: Pick<StationBoardStation, 'hasSnapshot' | 'fetchedAt' | 'businessDate'>, now = Date.now()) {
  const at = Date.parse(station.fetchedAt || '');
  if (!station.hasSnapshot || !Number.isFinite(at)) return 'missing';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(now));
  return station.businessDate === today && now - at > 90 * 60_000 ? 'older' : 'current';
}

/** Missing source reads are not operational zeroes. Preserve real empty snapshots. */
export function withBoardSourceStatus(table: BoardShareTable, stations: StationBoardStation[], now = Date.now()): BoardShareTable {
  const stationColumn = table.headers.indexOf('Station');
  if (stationColumn < 0) return table;
  const byCode = new Map(stations.map(station => [station.stationCode, station]));
  return { ...table, headers: [...table.headers, 'Source updated (IST)'], rows: table.rows.map(row => {
    const station = byCode.get(row[stationColumn]?.text);
    if (!station) return [...row, { text: '', align: 'left' as const }];
    const status = boardSourceStatus(station, now);
    const cells = row.map((cell, index) => status === 'missing' && !['Station', 'Location', "DA's Name"].includes(table.headers[index])
      ? { ...cell, text: '—', bg: undefined, color: undefined } : cell);
    const time = status === 'missing' ? 'Not fetched' : new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(station.fetchedAt!));
    return [...cells, { text: `${status === 'older' ? 'Older · ' : ''}${time}`, align: 'left' as const,
      ...(status !== 'current' ? { bg: '#fff7ed', color: '#9a3412' } : {}) }];
  }) };
}
