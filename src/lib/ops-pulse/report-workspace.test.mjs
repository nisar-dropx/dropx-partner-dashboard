import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as catalog from './report-catalog.ts';
function compile(path, mocks) {
  const m = { exports: {} };
  new Function('require', 'exports', 'module', ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(name => { if (name in mocks) return mocks[name]; throw Error(name); }, m.exports, m);
  return m.exports;
}
let preference = 'amazon_now';
const operating = compile('./operating-context.ts', {
  'next/headers': { cookies: () => ({ get: key => key === 'dropx-ops-mode' ? { value: preference } : undefined }) },
  '@/lib/ops-pulse/cod': { locationModelName: row => row.model, providerName: row => row.provider }
});
const scope = compile('./report-scope.ts', { '@/lib/ops-pulse/operating-context': operating });
const ds = { id: 'ds', station_code: 'STORE', model: 'NOW', provider: 'Amazon' };
const lm = { id: 'lm', station_code: 'LASTMILE', model: 'EDSP', provider: 'Amazon' };
const fk = { id: 'fk', station_code: 'FK', model: 'ODH', provider: 'Flipkart' };

test('DS catalog contains attendance, expense comparison and authorized CPU only', () => {
  assert.deepEqual(catalog.reportsForWorkspace('ds', true).map(r => r.type), ['cpu', 'expense_variance', 'attendance']);
  assert(!catalog.reportsForWorkspace('ds').some(r => r.type === 'cpu'));
  assert(catalog.reportsForWorkspace('lm').some(r => r.type === 'shipment_station'));
  assert(!catalog.reportsForWorkspace('lm', true).some(r => r.type === 'cpu'));
});
test('report scope separates stores from last mile and excludes hidden/HO locations', () => {
  preference = 'amazon_now';
  assert.deepEqual(scope.resolveReportScope([ds, lm, fk, { ...ds, id:'ho', is_ho:true }, { ...ds, id:'hidden', hide_from_location_list:true }]).locations, [ds]);
  preference = 'amazon_edsp';
  assert.deepEqual(scope.resolveReportScope([ds, lm, fk]).locations, [lm, fk]);
  preference = 'amazon_now';
  assert.deepEqual(scope.resolveReportScope([lm]).locations, [lm]);
});
test('explicit invalid or cross-workspace selections fail closed instead of exporting all stores', () => {
  assert.deepEqual(scope.requestedReportCodes([], ['STORE']), ['STORE']);
  assert.deepEqual(scope.requestedReportCodes([' store ', 'STORE'], ['STORE']), ['STORE']);
  assert.deepEqual(scope.requestedReportCodes(['STORE', 'LASTMILE'], ['STORE']), []);
});
function handler({ locations=[ds,lm], cpuAllowed=true, locationError=null } = {}) {
  const calls = [];
  const db = { from: table => {
    calls.push({ table });
    const query = new Proxy({}, { get: (_, method) => (...args) => {
      calls.push({ method, args });
      if (method === 'range') return Promise.resolve({ data: [], error: null });
      return query;
    } }); return query;
  } };
  const api = compile('../../app/api/ops-pulse/reports/download/route.ts', {
    '@/lib/expense-variance-data': {},
    '@/lib/authorization': { getAuthorization: async () => ({ hasAllLocationAccess: true, locationScopeIds: [] }), hasPermission: (_, permission) => permission !== 'cpu_overview' || cpuAllowed },
    '@/lib/company-scope': { requireCompanyId: () => 'company' },
    '@/lib/ops-pulse/cod': { loadCodLocations: async () => ({ locations, error: locationError }) },
    '@/lib/ops-pulse/report-catalog': catalog,
    '@/lib/ops-pulse/report-scope': scope,
    '@/lib/supabase-admin': { supabaseAdmin: db },
    '@/lib/ops-pulse/adhoc-da-report': {},
    '@/lib/ops-pulse/dark-store': { loadCpu: async (auth) => { calls.push({ cpuScope: auth }); return { period: { from: '2026-10-01' }, rows: [] }; } },
    xlsx: {}
  });
  return { get: params => api.GET(new Request(`https://ops.example/api/ops-pulse/reports/download?from=2026-10-01&to=2026-10-09&${params}`)), calls };
}
test('DS download rejects last-mile reports before reading data', async () => {
  preference = 'amazon_now'; const api=handler();
  for(const type of ['shipment_station','cps','cod','adhoc_da','da_delivery','capacity']) assert.equal((await api.get(`type=${type}`)).status,403);
  assert.deepEqual(api.calls,[]);
});
test('attendance download defaults to DS stores only and labels them as stores', async () => {
  preference = 'amazon_now'; const api=handler(); const response=await api.get('type=attendance&workspace=ds');
  assert.equal(response.status,200); assert.match(await response.text(),/"Store","Employee"/);
  assert(api.calls.some(call=>call.method==='in'&&call.args[0]==='station_code'&&JSON.stringify(call.args[1])==='["STORE"]'));
});
test('cross-workspace requests and failed access lookups never query report data', async () => {
  preference='amazon_now'; const api=handler();
  assert.equal((await api.get('type=attendance&stations=LASTMILE')).status,403);
  assert.equal((await api.get('type=attendance&workspace=lm')).status,409);
  assert.deepEqual(api.calls,[]);
  const unavailable=handler({locationError:'timeout'});
  assert.equal((await unavailable.get('type=attendance')).status,503);
  assert.deepEqual(unavailable.calls,[]);
});
test('CPU export requires existing CPU permission and passes only selected authorized store IDs', async () => {
  preference='amazon_now'; const denied=handler({cpuAllowed:false});
  assert.equal((await denied.get('type=cpu')).status,403); assert.deepEqual(denied.calls,[]);
  const api=handler();assert.equal((await api.get('type=cpu&stations=STORE')).status,200);
  assert.deepEqual(api.calls,[{cpuScope:{hasAllLocationAccess:false,locationScopeIds:['ds']}}]);
});

test('DS expense exports use Store and omit shipment/CPS columns', () => {
  const expenses = compile('../expense-variance-data.ts', { 'server-only': {}, './expense-variance': {} });
  const row = { date:'2026-10-09', station:'STORE', reference:'REQ', head:'Housekeeping', status:'Approved', estimated:100, actual:100, delta:0, percent:0, state:'Within estimate', shipments:20, cps:5 };
  const [dsRow]=expenses.expenseVarianceExport([row],true);
  assert.equal(dsRow.Store,'STORE');
  assert(!('Station' in dsRow));assert(!('Estimated shipments' in dsRow));assert(!('Estimated CPS' in dsRow));
  assert.equal(expenses.expenseVarianceExport([row])[0]['Estimated CPS'],5);
});
