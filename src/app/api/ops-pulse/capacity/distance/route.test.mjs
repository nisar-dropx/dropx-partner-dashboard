import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const routeId = '11111111-1111-4111-8111-111111111111';
const geometry = { station: [76, 10], path: [[76, 10]], method: 'amazon_gps', customer: 'private', stops: [{ point: [76, 10], firstScanAt: '10:30', scanCount: 1, customer: 'private', packageId: 'private' }] };
function compile({ auth = { locationScopeIds: ['allowed'], hasAllLocationAccess: false }, permission = true, station = 'allowed', company = 'own', scopeError = null } = {}) {
  const filters = [];
  const mocks = {
    '@/lib/authorization': { getAuthorization: async () => auth, hasPermission: (_a, code, action) => permission && code === 'capacity_associates' && action === 'access' },
    '@/lib/company-scope': { requireCompanyId: () => 'own' },
    '@/lib/ops-pulse/cod': { loadCodLocations: async () => ({ locations: [{ id: 'allowed', program: 'EDSP' }, { id: 'non-amazon', program: 'OTHER' }], error: scopeError }) },
    '@/lib/ops-pulse/operating-context': { isAmazonEdspXptLocation: s => s.program === 'EDSP' },
    '@/lib/supabase-admin': { supabaseAdmin: { from(table) {
      assert.equal(table, 'workforce_route_distances');
      return { select() { return this; }, eq(key, value) { filters.push([key, value]); return this; }, in(key, value) { filters.push([key, value]); return this; }, async maybeSingle() {
        return { error: null, data: filters.some(([k, v]) => k === 'company_id' && v === company) && filters.some(([k, v]) => k === 'station_id' && v.includes(station)) ? { route_geometry: geometry } : null };
      } };
    } } },
  };
  const module = { exports: {} };
  new Function('require', 'exports', 'module', ts.transpileModule(readFileSync(new URL('./route.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(key => mocks[key], module.exports, module);
  return { ...module.exports, filters };
}
const request = () => new Request('https://ops.dropxlogistics.com/api/ops-pulse/capacity/distance?routeId=' + routeId);
test('signed out and missing page permission are denied before querying routes', async () => {
  for (const options of [{ auth: null }, { permission: false }]) {
    const api = compile(options); assert.equal((await api.GET(request())).status, 403); assert.deepEqual(api.filters, []);
  }
});
test('guessed routes outside company or station access are not exposed', async () => {
  for (const options of [{ station: 'foreign' }, { company: 'foreign' }, { station: 'non-amazon' }]) {
    assert.equal((await compile(options).GET(request())).status, 404);
  }
  assert.equal((await compile({ scopeError: 'failed' }).GET(request())).status, 500);
});
test('authorized maps exclude customer and package data and are never publicly cached', async () => {
  const api = compile(); const response = await api.GET(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const data = await response.json();
  assert.deepEqual(Object.keys(data.geometry).sort(), ['method', 'path', 'station', 'stops']);
  assert.deepEqual(Object.keys(data.geometry.stops[0]).sort(), ['firstScanAt', 'point', 'scanCount']);
  assert.ok(api.filters.some(([key, value]) => key === 'id' && value === routeId));
  assert.ok(api.filters.some(([key, value]) => key === 'status' && value === 'ready'));
});
