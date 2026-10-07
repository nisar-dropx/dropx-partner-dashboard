import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function fixture({ authenticated = true, permission = true, fail = false } = {}) {
  const writes = [], scopeCalls = [];
  const auth = { locationScopeIds: ['ds1', 'lm1', 'ho', 'hidden'], hasAllLocationAccess: false };
  const mocks = {
    'next/headers': { cookies: () => ({ set: (...args) => writes.push(args) }) },
    '@/lib/authorization': { getAuthorization: async () => authenticated ? auth : null, hasPermission: () => permission },
    '@/lib/company-scope': { requireCompanyId: () => 'company' },
    '@/lib/ops-pulse/cod': { loadCodLocations: async (...args) => {
      scopeCalls.push(args);
      if (fail) throw Error('offline');
      return { locations: [{ id: 'ds1', mode: 'amazon_now' }, { id: 'ds2', mode: 'amazon_now' }, { id: 'lm1', mode: 'amazon_edsp' }, { id: 'ho', mode: 'amazon_now', is_ho: true }, { id: 'hidden', mode: 'amazon_now', hide_from_location_list: true }] };
    } },
    '@/lib/ops-pulse/operating-context': { operatingModes: [{ code: 'amazon_now' }, { code: 'amazon_edsp' }, { code: 'flipkart_odh_mdh' }], locationsForMode: (locations, mode) => locations.filter(l => l.mode === mode) }
  };
  const m = { exports: {} };
  const source = ts.transpileModule(readFileSync(new URL('./route.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'exports', 'module', source)(name => mocks[name], m.exports, m);
  return { POST: m.exports.POST, writes, scopeCalls };
}
function request(mode = 'amazon_now', origin = 'https://ops.example.com') {
  const body = new FormData(); body.set('mode', mode); body.set('locations', 'ds2');
  return new Request('https://ops.example.com/api/ops-pulse/workspace', { method: 'POST', headers: { origin }, body });
}
test('switch only selects permitted operational locations and ignores supplied location IDs', async () => {
  const f = fixture(), result = await f.POST(request());
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), { ok: true });
  assert.deepEqual(f.writes.map(w => w.slice(0, 2)), [['dropx-ops-mode', 'amazon_now'], ['dropx-ops-location', 'ds1'], ['dropx-ops-locations', 'ds1']]);
  assert.deepEqual(f.scopeCalls[0], ['company', ['ds1', 'lm1', 'ho', 'hidden'], false]);
  assert(f.writes.every(w => w[2].httpOnly && w[2].sameSite === 'lax'));
});
test('cross-origin requests and unauthenticated or unauthorized sessions never change preference', async () => {
  for (const [config, origin] of [[{}, 'https://outside.example.com'], [{ authenticated: false }, 'https://ops.example.com'], [{ permission: false }, 'https://ops.example.com']]) {
    const f = fixture(config); assert.equal((await f.POST(request('amazon_now', origin))).status, 403); assert.equal(f.writes.length, 0);
  }
});
test('invalid or unavailable workspaces do not fall back to broader access', async () => {
  for (const [mode, status] of [['invalid', 400], ['flipkart_odh_mdh', 403]]) {
    const f = fixture(); assert.equal((await f.POST(request(mode))).status, status); assert.equal(f.writes.length, 0);
  }
});
test('a source failure retains the current workspace', async () => {
  const f = fixture({ fail: true }); assert.equal((await f.POST(request())).status, 503); assert.equal(f.writes.length, 0);
});
