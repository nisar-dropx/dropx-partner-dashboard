import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
function compile(file, deps = {}) { const exports = {}; new Function('require', 'exports', ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(name => deps[name] ?? require(name), exports); return exports; }
const p = compile('src/lib/fleet/daily-report.ts');
const v = { vehicle_no: 'KL11BZ2194', station_code: 'ERSE', model: 'Van', fuel_type: 'Diesel', status: 'active' };
const km = { vehicle_no: v.vehicle_no, movement_date: '2026-09-22', km: 100, point_count: 20, source: 'wheelseye', calculated_at: '2026-09-23T00:00:00Z' };
const fuel = { vehicle_no: v.vehicle_no, transaction_date: '2026-09-22', fuel_quantity: 10, fuel_amount: 1000, provider: 'IOC' };
assert.equal(p.istDate(new Date('2026-09-22T18:29:59Z')), '2026-09-22');
assert.equal(p.istDate(new Date('2026-09-22T18:30:00Z')), '2026-09-23');
assert.equal(p.validDate('2026-02-30'), false);
assert.equal(p.validDate('2024-02-29'), true);
assert.match(p.validateReportRange('2026-09-24', '2026-09-23', '2026-09-24'), /From date/);
assert.match(p.validateReportRange('2026-09-24', '2026-09-25', '2026-09-24'), /Future/);
assert.match(p.validateReportRange('2026-01-01', '2026-09-24', '2026-09-24'), /93/);
const rows = p.buildDailyFleetRows([v, { ...v, vehicle_no: 'OTHER' }], [km], [fuel, { ...fuel, fuel_quantity: 10, fuel_amount: 1000, provider: 'BPCL' }], '2026-09-22', '2026-09-23', '2026-09-23');
assert.equal(rows.length, 4);
assert.equal(rows[0].km, 100);
assert.equal(rows[0].litres, 20);
assert.equal(rows[0].mileage, 5);
assert.equal(rows[0].costPerKm, 20);
assert.equal(rows[0].fuelTransactions, 2);
assert.deepEqual(rows[0].fuelSources, ['BPCL', 'IOC']);
assert.equal(rows[1].km, null, 'Missing GPS must not be zero');
assert.equal(rows[1].litres, null, 'Missing fuel is not measured zero consumption');
assert.equal(rows[1].mileage, null);
assert.equal(rows[2].provisional, true);
assert.equal(rows[2].dataStatus, 'gps_missing');
const build = (distances, fuels = [fuel]) => p.buildDailyFleetRows([v], distances, fuels, '2026-09-22', '2026-09-22', '2026-09-23')[0];
assert.equal(build([{ ...km, km: 0, point_count: 0 }]).km, null);
assert.equal(build([{ ...km, km: 0, point_count: 1 }]).km, null);
assert.equal(build([{ ...km, km: 0 }]).km, 0, 'A stationary day with GPS samples is a real zero');
assert.equal(build([{ ...km, km: -5 }]).km, null);
assert.equal(build([{ ...km, km: null }]).km, null);
assert.equal(build([km], [{ ...fuel, fuel_quantity: 0 }]).mileage, null);
assert.equal(build([km], []).dataStatus, 'fuel_missing');
assert.equal(build([km, { ...km, km: 120, source: 'manual', point_count: 0 }]).km, 120, 'Alternative distance sources must not be summed');
assert.equal(build([km, { ...km, km: 0, point_count: 0, calculated_at: '2026-09-23T01:00:00Z' }]).km, 100, 'Missing refresh must not hide recorded GPS');
assert.equal(build([km, { ...km, km: 110, calculated_at: '2026-09-23T01:00:00Z' }]).km, 110);
assert.equal(build([{ ...km, vehicle_no: 'KL 11 BZ 2194' }]).km, 100);
assert.equal(p.buildDailyFleetRows([{ ...v, status: 'sold' }], [km], [], '2026-09-22', '2026-09-23', '2026-09-23').length, 1);
assert.equal(p.buildDailyFleetRows([], [km], [fuel], '2026-09-22', '2026-09-23', '2026-09-23').length, 0, 'Only permitted vehicles become rows');
for (const direction of ['asc', 'desc']) assert.equal(p.sortDailyRows(rows, 'km', direction).at(-1).km, null, 'Missing values sort last');
assert.match(p.dailyFleetCsv([{ ...rows[0], model: '=HYPERLINK("test")' }]), /'=HYPERLINK/);
assert.match(p.dailyFleetCsv([rows[1]]), /Distance unavailable/);
assert.match(p.dailyFleetCsv([rows[0]]), /fuel purchased/);

const electric = p.buildDailyFleetRows([{ ...v, fuel_type: 'EV' }], [km], [fuel], '2026-09-22', '2026-09-22', '2026-09-23')[0];
assert.equal(electric.mileage, null); assert.equal(electric.litres, null); assert.equal(electric.dataStatus, 'not_applicable');
const originalFetch = globalThis.fetch;
const gpsHistory = compile('src/lib/wheelseye-history.ts');
try {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ Vehicle: [{ latitude: 11.25, longitude: 75.78 }, { latitude: 0, longitude: 0 }, { latitude: 999, longitude: 75 }, { latitude: 11.26, longitude: 75.79 }] }) });
  const movement = await gpsHistory.loadWheelseyeMovement('test', v.vehicle_no, '2026-09-22');
  assert.equal(movement.summary.pointCount, 2); assert.ok(movement.summary.km > 1 && movement.summary.km < 2);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [] }) });
  await assert.rejects(gpsHistory.loadWheelseyeMovement('test', v.vehicle_no, '2026-09-22'), /unexpected/);
} finally { globalThis.fetch = originalFetch; }

// Query-level scope and pagination, plus route authorization.
const calls = []; let stationFailure = false;
const db = { from(table) {
  const filters = []; const query = { select() { return this; }, eq(key, value) { filters.push(['eq', key, value]); return this; }, in(key, value) { filters.push(['in', key, value]); return this; }, order() { return this; },
    async then(resolve) { calls.push({ table, filters }); return resolve(table === 'stations' ? { data: [{ station_code: 'ERSE' }], error: stationFailure ? { message: 'denied' } : null } : { data: [v], error: null }); } };
  return query;
} };
const scope = compile('src/lib/fleet/report-data.ts', { '@/lib/authorization': { hasPermission: a => a.allowed }, '@/lib/company-scope': { requireCompanyId: a => a.companyId }, '@/lib/supabase-admin': { supabaseAdmin: db }, '@/lib/supabase-pagination': { readAllRows: async q => await q }, './daily-report': p });
const locationAuth = { allowed: true, companyId: 'company-A', isMasterOwner: false, hasAllLocationAccess: false, locationScopeIds: ['station-id'] };
await assert.rejects(scope.reportScope({ ...locationAuth, allowed: false }), error => error.status === 403);
assert.equal(calls.length, 0);
assert.deepEqual((await scope.reportScope({ ...locationAuth, locationScopeIds: [] })).vehicles, []);
assert.equal(calls.length, 0);
assert.equal((await scope.reportScope(locationAuth)).vehicles.length, 1);
assert.ok(calls.every(call => call.filters.some(([op, key, value]) => op === 'eq' && key === 'company_id' && value === 'company-A')));
assert.deepEqual(calls.find(call => call.table === 'fleet_vehicles').filters.find(([, key]) => key === 'station_code')[2], ['ERSE']);
stationFailure = true;
await assert.rejects(scope.reportScope(locationAuth));
const pagination = compile('src/lib/supabase-pagination.ts');
const fullLedger = Array.from({ length: 1251 }, (_, i) => ({ id: i }));
assert.equal((await pagination.readAllRows({ range: async (start, end) => ({ data: fullLedger.slice(start, end + 1), error: null }) })).data.length, 1251);
let auth = null;
const route = compile('src/app/api/fleet/daily-report/route.ts', { '@/lib/authorization': { getAuthorization: async () => auth }, '@/lib/fleet/daily-report': p, '@/lib/fleet/report-data': { ...scope, loadDailyReport: async a => { if (!a.allowed) throw new scope.FleetReportError('Denied', 403); return { rows: [] }; } } });
const request = () => new Request('https://ops.dropxlogistics.com/api/fleet/daily-report?from=2026-09-22&to=2026-09-23');
assert.equal((await route.GET(request())).status, 401);
auth = { allowed: false }; assert.equal((await route.GET(request())).status, 403);
auth = { allowed: true }; assert.equal((await route.GET(request())).status, 200);
assert.equal((await route.GET(new Request('https://ops.dropxlogistics.com/api/fleet/daily-report?from=invalid&to=2026-09-23'))).status, 400);
let gpsCalls = 0, samples = 0;
const writes = [];
const saveDb = { from(table) {
  const filters = [];
  const query = { select() { return this; }, eq(key, value) { filters.push([key, value]); return this; },
    maybeSingle: async () => ({ data: { id: 'record-1', calculated_at: '2026-09-23T00:00:00Z' }, error: null }),
    update(values) { writes.push({ table, values, filters }); return this; },
    then(resolve) { return Promise.resolve(resolve({ data: [{ id: 'record-1' }], error: null })); }
  }; return query;
} };
const refresh = compile('src/app/api/fleet/daily-report/refresh/route.ts', { '@/lib/authorization': { getAuthorization: async () => auth }, '@/lib/supabase-admin': { supabaseAdmin: saveDb }, '@/lib/wheelseye': { getWheelseyeAccessToken: async () => 'test' }, '@/lib/wheelseye-history': { loadWheelseyeMovement: async () => { gpsCalls++; return { summary: { pointCount: samples, km: 25 } }; } }, '@/lib/fleet/daily-report': p, '@/lib/fleet/report-data': { FleetReportError: scope.FleetReportError, reportScope: async a => { if (!a.allowed) throw new scope.FleetReportError('Denied', 403); return { companyId: 'company-A', vehicles: [v] }; } } });
const post = (pairs, origin = 'https://ops.dropxlogistics.com') => new Request('https://ops.dropxlogistics.com/api/fleet/daily-report/refresh', { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ pairs }) });
const pair = { vehicle: v.vehicle_no, date: p.shiftDay(p.istDate(), -1) };
assert.equal((await refresh.POST(post([pair], 'https://other.example'))).status, 403);
assert.equal((await refresh.POST(post([{ ...pair, vehicle: 'OUTSIDE' }]))).status, 403);
assert.equal((await refresh.POST(post(Array(13).fill(pair)))).status, 400);
auth = { allowed: true, isPreview: true }; assert.equal((await refresh.POST(post([pair]))).status, 403);
auth = null; assert.equal((await refresh.POST(post([pair]))).status, 401);
assert.equal(gpsCalls, 0);
auth = { allowed: true };
const refreshed = await refresh.POST(post([pair, pair]));
assert.equal(refreshed.status, 200); assert.equal((await refreshed.json()).results[0].status, 'no_data'); assert.equal(gpsCalls, 1, 'De-duplicate batch and do not save false zero for missing samples');
samples = 10;
const savedGps = await refresh.POST(post([pair]));
assert.equal(savedGps.status, 200);
assert.equal((await savedGps.json()).results[0].status, 'updated');
assert.equal(writes.length, 1);
assert.equal(writes[0].values.km, 25);
assert.ok(writes[0].filters.some(([key, value]) => key === 'company_id' && value === 'company-A'));
assert.ok(writes[0].filters.some(([key, value]) => key === 'id' && value === 'record-1'));
assert.ok(writes[0].filters.some(([key]) => key === 'calculated_at'));
console.log('Fleet daily report: date boundaries, complete ledgers, daily joins, no-data handling, mileage, CSV, sorting, company/location scope and refresh authorization passed.');
