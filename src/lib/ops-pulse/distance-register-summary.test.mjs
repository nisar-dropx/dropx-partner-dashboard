import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { filterDistanceEntries, groupDistanceAssociates } from './distance-register.ts';
import { distanceWorkbookBytes } from './distance-register-export.ts';
const filters = { from: '2026-10-01', to: '2026-10-10', stations: ['JGBA'], regions: [], clusters: [], statuses: [], methods: [], query: '' };
const row = { key: 'a1', workforceId: 'w1', name: 'Example Associate', dropxId: 'DF1001', amazonId: '200012345', transporterId: 'A1TEST', stationId: 's1', station: 'JGBA', region: 'North', cluster: 'A', date: '2026-10-01', status: 'ready', reason: null, km: 25, rate: 3, fuel: 75, departureKm: 2, deliveryKm: 21, returnKm: 2, updatedAt: null, routeId: 'r1', method: 'scan_roads', scans: 10 };
const records = [row, { ...row, key: 'a2', date: '2026-10-10', km: 40, fuel: 120 }, { ...row, key: 'a3', date: '2026-10-11', km: 999, fuel: 2997 }, { ...row, key: 'pending', date: '2026-10-03', status: 'pending', km: null, fuel: null, method: 'pending', reason: 'route_not_received', routeId: null }, { ...row, key: 'excluded', date: '2026-10-04', status: 'pending', km: null, fuel: null, method: 'pending', reason: 'route_excluded', routeId: null }, { ...row, key: 'outside', station: 'KBWE', stationId: 's2', km: 1000 }];
test('default filter is Ready-only; pending and excluded days stay out of the payout view', () => {
  const groups = groupDistanceAssociates(filterDistanceEntries(records, filters));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].km, 65); assert.equal(groups[0].fuel, 195);
  assert.equal(groups[0].days, 2); assert.equal(groups[0].pendingDays, 0);
  assert.deepEqual(groups[0].rows.map(r => r.date), ['2026-10-10', '2026-10-01']);
  assert.deepEqual(groups[0].amazonIds, ['200012345']); assert.deepEqual(groups[0].dropxIds, ['DF1001']);
});
test('same names are separate, while historical IDs for one associate remain visible in one group', () => {
  const grouped = groupDistanceAssociates([row, { ...row, key: 'changed-id', date: '2026-10-02', amazonId: '200098765' }, { ...row, key: 'namesake', workforceId: 'w2', dropxId: 'DF1002' }]);
  assert.equal(grouped.length, 2);
  assert.deepEqual(grouped[0].amazonIds, ['200098765', '200012345']);
  assert.equal(grouped[0].days, 2); assert.equal(grouped[1].days, 1);
});
test('explicit Pending filter still works; status/source/search filters apply before grouping', () => {
  const pending = groupDistanceAssociates(filterDistanceEntries(records, { ...filters, statuses: ['Pending'] }));
  assert.equal(pending[0].km, null); assert.equal(pending[0].fuel, null); assert.equal(pending[0].days, 1);
  assert.equal(filterDistanceEntries(records, { ...filters, methods: ['OSM roads between scans'], query: 'a1test', regions: ['North'], clusters: ['A'] }).length, 2);
  assert.equal(filterDistanceEntries(records, { ...filters, regions: ['South'] }).length, 0);
  assert.equal(filterDistanceEntries(records, { ...filters, query: 'unknown' }).length, 0);
});
test('downloaded workbook is Ready-only on main sheets and lists non-ready days on No payouts', () => {
  const bytes = distanceWorkbookBytes(records, filters);
  const book = XLSX.read(bytes, { type: 'array' });
  assert.deepEqual(book.SheetNames, ['Associate summary', 'Daily details', 'No payouts', 'Applied filters']);
  const summary = XLSX.utils.sheet_to_json(book.Sheets['Associate summary']);
  const daily = XLSX.utils.sheet_to_json(book.Sheets['Daily details']);
  const none = XLSX.utils.sheet_to_json(book.Sheets['No payouts']);
  assert.equal(summary.length, 1); assert.equal(summary[0]['Recorded distance (km)'], 65);
  assert.equal(summary[0]['Recorded fuel (INR)'], 195);
  assert.equal(daily.length, 2); assert.ok(daily.every(r => r.Status === 'Ready' && r.Date <= filters.to && r.Station === 'JGBA'));
  assert.equal(none.length, 2);
  assert.ok(none.some(r => r.Reason === 'route_not_received'));
  assert.ok(none.some(r => r.Reason === 'route_excluded'));
  assert.equal(book.Sheets['Daily details'].F2.t, 's');
  assert.equal(book.Sheets['Daily details'].I2.t, 'n');
  assert.ok(book.Sheets['Daily details']['!autofilter']);
  assert.equal(XLSX.utils.sheet_to_json(book.Sheets['Applied filters']).find(r => r.Filter === 'To').Value, filters.to);
});
test('export includes every filtered associate beyond the UI page and excludes personal route details', () => {
  const many = Array.from({length: 60}, (_, i) => ({ ...row, key: String(i), workforceId: `w${i}`, name: i === 0 ? '=HYPERLINK("bad")' : `Associate ${i}` }));
  const book = XLSX.read(distanceWorkbookBytes(many, filters), { type: 'array' });
  assert.equal(XLSX.utils.sheet_to_json(book.Sheets['Associate summary']).length, 60);
  assert.equal(XLSX.utils.sheet_to_json(book.Sheets['Daily details']).length, 60);
  assert.equal(book.Sheets['Associate summary'].A2.t, 's'); assert.equal(book.Sheets['Associate summary'].A2.f, undefined);
  assert.ok(!JSON.stringify(book).includes('routeId'));
});
