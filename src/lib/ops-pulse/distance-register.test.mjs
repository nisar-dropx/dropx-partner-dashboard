import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDistanceEntries, distancePeriod, selectedDistanceStations } from './distance-register.ts';

const station = { id: 's1', station_code: 'JGBA', region: 'North', cluster: 'Cluster A' };
const mapping = { id: 'm1', workforce_id: 'w1', station_id: 's1', provider_member_id: '200012345', payment_values: { KM_RUN: 3 }, effective_from: '2026-10-01' };
const date = '2026-10-12';
const route = { id: 'r1', workforce_id: 'w1', station_id: 's1', mapping_id: 'm1', work_date: date, status: 'ready', distance_km: 89.4, departure_km: 4, delivery_km: 81.4, return_km: 4, calculated_at: '2026-10-13T00:00:00Z' };
function input() {
  return {
    stations: [station], mappings: [mapping],
    people: [{ id: 'w1', full_name: 'Test Associate', dropx_id: 'DF1001' }],
    activity: [{ station_code: 'JGBA', provider_employee_id: '200012345', work_date: date, total_delivery: 25 }],
    metadata: [{ id: 'r1', transporter_id: 'A123', scan_count: 25, route_method: 'amazon_gps' }],
    context: { enabledFrom: '2026-10-01', rows: [route], manual: [], rateOverrides: [] },
    from: '2026-10-01', to: '2026-10-14',
  };
}
test('keeps Amazon, DropX and LSC IDs distinct and uses the payout distance and rate', () => {
  const [row] = buildDistanceEntries(input());
  assert.equal(row.amazonId, '200012345');
  assert.equal(row.dropxId, 'DF1001');
  assert.equal(row.transporterId, 'A123');
  assert.equal(row.km, 89.4);
  assert.equal(row.fuel, 268.2);
  assert.equal(row.method, 'amazon_gps');
  assert.equal(row.routeId, 'r1');
});
test('worked days with no route remain visible as pending, not zero; absent days are not invented', () => {
  const data = input(); data.context.rows = []; data.metadata = [];
  const rows = buildDistanceEntries(data);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].reason, 'route_not_received');
  assert.equal(rows[0].km, null); assert.equal(rows[0].fuel, null);
  data.activity = [];
  assert.deepEqual(buildDistanceEntries(data), []);
});
test('never borrows activity or routes from another Amazon ID, station or mapping', () => {
  const data = input(); data.context.rows = [];
  data.activity[0].provider_employee_id = 'different';
  assert.deepEqual(buildDistanceEntries(data), []);
  data.activity[0].provider_employee_id = mapping.provider_member_id;
  data.activity[0].station_code = 'OTHER';
  assert.deepEqual(buildDistanceEntries(data), []);
  const changed = input(); changed.context.rows = [{ ...route, mapping_id: 'old' }];
  const [row] = buildDistanceEntries(changed);
  assert.equal(row.reason, 'mapping_changed'); assert.equal(row.fuel, null); assert.equal(row.routeId, null);
});
test('respects assignment windows and only includes positive kilometre fuel mappings', () => {
  for (const replacement of [
    { ...mapping, effective_from: '2026-10-13' },
    { ...mapping, effective_to: '2026-10-11' },
    { ...mapping, payment_values: { DELIVERY: 14 } },
    { ...mapping, payment_values: { KM_RUN: 0 } },
  ]) {
    const data = input(); data.mappings = [replacement];
    assert.deepEqual(buildDistanceEntries(data), []);
  }
});
test('same daily overrides and approved imported units as payouts are used', () => {
  const data = input();
  data.context.rateOverrides = [{ workforce_id: 'w1', station_id: 's1', field_code_snapshot: 'KM_RUN', effective_from: date, effective_to: date, input_value: 4 }];
  assert.equal(buildDistanceEntries(data)[0].fuel, 357.6);
  data.context.manual = [{ workforce_id: 'w1', station_id: 's1', field_code_snapshot: 'KM_RUN', work_date: date, units: 50 }];
  const [row] = buildDistanceEntries(data);
  assert.equal(row.km, 50); assert.equal(row.fuel, 200); assert.equal(row.method, 'manual'); assert.equal(row.routeId, null);
});
test('overlapping mappings and conflicting route inputs never double count distance or fuel', () => {
  const data = input(); data.mappings.push({ ...mapping, id: 'm2', provider_member_id: '200099999' });
  const [row] = buildDistanceEntries(data);
  assert.equal(row.reason, 'input_conflict'); assert.equal(row.km, null); assert.equal(row.fuel, null);
  assert.equal(row.amazonId, '200012345 / 200099999');
  const duplicate = input(); duplicate.context.rows.push({ ...route, id: 'duplicate' });
  assert.equal(buildDistanceEntries(duplicate)[0].reason, 'input_conflict');
});
test('multi-select filters intersect the authorized station set and cannot widen it', () => {
  const stations = [station, { id: 's2', station_code: 'KBWE', region: 'South', cluster: 'Cluster B' }];
  assert.deepEqual(selectedDistanceStations(stations, { stations: [], regions: [], clusters: [] }), stations);
  assert.deepEqual(selectedDistanceStations(stations, { stations: ['JGBA', 'UNAUTHORIZED'], regions: ['North', 'South'], clusters: ['Cluster A'] }), [station]);
  assert.deepEqual(selectedDistanceStations(stations, { stations: ['JGBA'], regions: ['South'], clusters: [] }), []);
  assert.deepEqual(selectedDistanceStations(stations, { stations: ['UNAUTHORIZED'], regions: [], clusters: [] }), []);
});
test('date selection defaults to the running month and is bounded to 31 days', () => {
  assert.deepEqual(distancePeriod(undefined, undefined, '2026-10-14'), { from: '2026-10-01', to: '2026-10-14' });
  assert.deepEqual(distancePeriod('2026-09-01', '2026-09-30', '2026-10-14'), { from: '2026-09-01', to: '2026-09-30' });
  assert.throws(() => distancePeriod('2026-09-01', '2026-10-14', '2026-10-14'), /31 days/);
  assert.throws(() => distancePeriod('2026-10-14', '2026-10-12', '2026-10-14'), /31 days/);
});
