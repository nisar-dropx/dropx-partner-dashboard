import { CRETURN_DISPLAY, CRETURN_SHORT, CRETURN_PICKED_UP_BUCKET, pickupPctColor, pickupPctTextColor, sumDaDsr, dsrHeatColor, dsrPctTextColor, oorTextColor, type StationBoardStation } from './station-board.ts';
import type { BoardShareCell, BoardShareTable } from './station-board-share.ts';

export type BoardDetailLevel = 'station' | 'associate';
export type CReturnAssociate = { stationCode: string; driverId: string; driverName: string; statuses: Record<string, number>; total: number };
export type CReturnShipment = { stationCode: string; trackingId: string; driverId: string; driverName: string; status: string };

/** Each shipment belongs to one station/associate. Missing assignments remain visible. */
export function aggregateCReturnAssociates(shipments: CReturnShipment[]): CReturnAssociate[] {
  const groups = new Map<string, CReturnAssociate>();
  const seen = new Set<string>();
  for (const row of shipments) {
    const shipmentKey = `${row.stationCode}\t${row.trackingId}`;
    if (!row.trackingId || seen.has(shipmentKey)) continue;
    seen.add(shipmentKey);
    const id = row.driverId?.trim() || row.driverName?.trim() || '(unassigned)';
    const key = `${row.stationCode}\t${id}`;
    const group = groups.get(key) || { stationCode: row.stationCode, driverId: id, driverName: row.driverName?.trim() || (id === '(unassigned)' ? 'Unassigned' : id), statuses: {}, total: 0 };
    const raw = row.status?.trim().toUpperCase() || 'UNKNOWN';
    const status = CRETURN_PICKED_UP_BUCKET.has(raw) ? 'PICKUP_DONE' : raw;
    group.statuses[status] = (group.statuses[status] || 0) + 1;
    group.total++;
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function pendingCReturn(statuses: Record<string, number>, total: number) {
  return Math.max(0, total - (statuses.PICKUP_DONE || 0) - (statuses.CANCELLED || 0) - (statuses.UNPICKUPABLE || 0));
}
const numberCell = (n: number): BoardShareCell => ({ text: String(n), align: 'right' });

export function cReturnDetailTable(stations: StationBoardStation[], associates: CReturnAssociate[], level: BoardDetailLevel, names: Record<string, string>): BoardShareTable {
  const codes = new Set(stations.map(s => s.stationCode));
  const items = level === 'associate' ? associates.filter(r => codes.has(r.stationCode)) : stations.map(s => ({ stationCode: s.stationCode, driverId: '', driverName: '', statuses: s.board.cReturn, total: s.board.cReturnTotal }));
  const known = new Set<string>(CRETURN_DISPLAY);
  const other = (r: CReturnAssociate) => Object.entries(r.statuses).reduce((n, [k, v]) => n + (known.has(k) ? 0 : v), 0);
  const hasOther = items.some(r => other(r) > 0);
  const headers = ['Station', level === 'associate' ? "DA's Name" : 'Location', 'Total', 'Pending pickup', ...CRETURN_DISPLAY.map(k => CRETURN_SHORT[k]), ...(hasOther ? ['Other'] : []), 'Pickup %'];
  const metrics = (r: CReturnAssociate): BoardShareCell[] => {
    const pct = r.total ? Math.round((r.statuses.PICKUP_DONE || 0) / r.total * 100) : 0;
    return [numberCell(r.total), { ...numberCell(pendingCReturn(r.statuses, r.total)), bold: true }, ...CRETURN_DISPLAY.map(k => numberCell(r.statuses[k] || 0)), ...(hasOther ? [numberCell(other(r))] : []), { text: r.total ? `${pct}%` : '—', align: 'right', bold: true, bg: r.total ? pickupPctColor(pct) : undefined, color: r.total ? pickupPctTextColor(pct) : undefined }];
  };
  const rows: BoardShareCell[][] = items.map(r => [{ text: r.stationCode, align: 'left', bold: true }, { text: level === 'associate' ? r.driverName || r.driverId : names[r.stationCode] || '', align: 'left' }, ...metrics(r)]);
  const total: CReturnAssociate = { stationCode: '', driverId: '', driverName: '', statuses: {}, total: 0 };
  items.forEach(r => { total.total += r.total; Object.entries(r.statuses).forEach(([k, v]) => { total.statuses[k] = (total.statuses[k] || 0) + v; }); });
  if (items.length) rows.push([{ text: 'Grand Total', bold: true }, { text: level === 'associate' ? `${items.length} assignments` : `${items.length} stations` }, ...metrics(total)]);
  return { title: `C-Return · ${level === 'associate' ? 'Associates' : 'Stations'}`, subtitle: '', headers, rows };
}

export function dsrStationTable(stations: StationBoardStation[], names: Record<string, string>, zeroOnly = false): BoardShareTable {
  const headers = ['Station', 'Location', 'Total', 'Delivered', 'Out on Road', 'Delivery Failed', 'Delivery Rejected', 'DSR%'];
  const all = stations.flatMap(s => s.board.daDsr).filter(d => !zeroOnly || (d.total > 0 && d.delivered === 0));
  const metrics = (sum: ReturnType<typeof sumDaDsr>, at?: string | null): BoardShareCell[] => [numberCell(sum.total), numberCell(sum.delivered), { ...numberCell(sum.oor), color: oorTextColor(sum.oor, sum.total, at) }, numberCell(sum.failed), numberCell(sum.rejected), { text: sum.total ? `${sum.dsrPct}%` : '—', align: 'right', bold: true, bg: sum.total ? dsrHeatColor(sum.dsrPct) : undefined, color: sum.total ? dsrPctTextColor(sum.dsrPct) : undefined }];
  const rows: BoardShareCell[][] = stations.flatMap(s => {
    const sum = sumDaDsr(s.board.daDsr.filter(d => !zeroOnly || (d.total > 0 && d.delivered === 0)));
    if (zeroOnly && !sum.total) return [];
    return [[{ text: s.stationCode, bold: true }, { text: names[s.stationCode] || '' }, ...metrics(sum, s.fetchedAt)]];
  });
  if (rows.length) rows.push([{ text: 'Grand Total', bold: true }, { text: `${rows.length} stations` }, ...metrics(sumDaDsr(all))]);
  return { title: `${zeroOnly ? 'Zero deliveries' : 'DSR'} · Stations`, subtitle: '', headers, rows };
}
