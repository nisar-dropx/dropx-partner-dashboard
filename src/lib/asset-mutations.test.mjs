import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
const require = createRequire(import.meta.url), cache = new Map();
function load(path) {
  path = resolve(path); if (cache.has(path)) return cache.get(path).exports;
  const module = { exports: {} }; cache.set(path, module);
  const output = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'exports', 'module', output)(name => name === 'server-only' ? {} : name.startsWith('.') ? load(resolve(dirname(path), name + '.ts')) : require(name), module.exports, module);
  return module.exports;
}
const { editAsset, changeAssetDeleted } = load('src/lib/asset-mutations.ts');
const { assetVersion } = load('src/lib/asset-version.ts');
const { emptyAssetForm, assetFormValues, parseAssetEdit } = load('src/lib/asset-form.ts');
const id = '11111111-1111-4111-8111-111111111111', location = '22222222-2222-4222-8222-222222222222';
function fixture({ rented = false, assigned = false, otherCompany = false, fail = null, concurrent = false } = {}) {
  const asset = { id, company_id: otherCompany ? 'other' : 'company', asset_code: 'IT-0001', barcode_value: 'IT-0001', asset_type_id: 'type', is_active: true, status: 'available', location_id: location, tracking_mode: 'individual', quantity_total: 1, quantity_working: 1, quantity_faulty: 0, condition: 'good', ownership_type: rented ? 'rented' : 'owned', notes: 'Keep me', manufacturer: 'Old make', updated_by: 'previous' };
  const term = rented ? { id: 'term', company_id: 'company', asset_id: id, vendor_name: 'Vendor', rental_rate: 100, billing_frequency: 'monthly', security_deposit: 0, starts_on: '2026-09-01', ends_on: null, notice_period_days: 30, status: 'active', updated_by: 'previous' } : null;
  const rows = { assets: [asset], asset_rental_terms: term ? [term] : [], asset_assignments: assigned ? [{ id: 'assignment', company_id: 'company', asset_id: id, returned_at: null }] : [], asset_events: [] };
  const calls = []; let failed = false, raced = false;
  const db = { from(table) {
    let op = 'select', data, filters = [], one = false;
    const b = {
      select() { return this; }, eq(k, v) { filters.push(r => String(r[k] ?? '') === String(v ?? '')); return this; },
      is(k, v) { filters.push(r => (r[k] ?? null) === v); return this; }, in(k, vs) { filters.push(r => vs.includes(r[k])); return this; },
      limit() { return this; }, maybeSingle() { one = true; return this; },
      update(v) { op = 'update'; data = v; return this; }, insert(v) { op = 'insert'; data = v; return this; }, delete() { op = 'delete'; return this; },
      then(ok, bad) {
        calls.push({ table, op, data });
        if (fail === table && op !== 'select' && !failed) { failed = true; return Promise.resolve({ data: null, error: { message: 'DB failure' } }).then(ok, bad); }
        if (concurrent && table === 'assets' && op === 'update' && !raced) { raced = true; rows.assets[0].manufacturer = 'Concurrent edit'; }
        let selected = rows[table].filter(r => filters.every(f => f(r)));
        if (op === 'update') selected.forEach(r => Object.assign(r, data));
        if (op === 'insert') { const r = structuredClone(data); rows[table].push(r); selected = [r]; }
        if (op === 'delete') rows[table] = rows[table].filter(r => !selected.includes(r));
        return Promise.resolve({ data: structuredClone(one ? selected[0] ?? null : selected), error: null }).then(ok, bad);
      },
    }; return b;
  } };
  const context = { db, companyId: 'company', locations: [{ id: location }], authorization: { userId: 'editor', fullName: 'Finance', hasAllLocationAccess: false, locationScopeIds: [location] } };
  const input = { ...emptyAssetForm, ...assetFormValues({ ...asset, category_name: 'IT', type_name: 'Laptop', rental_term: term }), id, version: assetVersion(asset, term), manufacturer: 'New make' };
  return { rows, calls, context, input, resolveType: async () => ({ id: 'type' }) };
}
test('edit preserves identity, attachments and original records; rental zero is retained', async () => {
  const f = fixture({ rented: true });
  await editAsset(f.context, { ...f.input, rental_rate: '0', change_reason: 'Correct invoice' }, f.resolveType);
  assert.equal(f.rows.assets[0].manufacturer, 'New make'); assert.equal(f.rows.assets[0].asset_code, 'IT-0001');
  assert.equal(f.rows.asset_rental_terms[0].rental_rate, 0); assert.equal(f.rows.asset_events.length, 1);
  assert.equal(f.rows.asset_events[0].metadata.previous.manufacturer, 'Old make');
  assert.equal(f.rows.asset_events[0].actor_user_id, 'editor');
  assert.ok(f.calls.every(c => !['asset_attachments', 'asset_assignments'].includes(c.table) || c.op === 'select'));
});
test('delete and restore retain asset, agreement and history', async () => {
  const f = fixture({ rented: true });
  await changeAssetDeleted(f.context, { id, version: f.input.version, deleted: true, reason: 'Duplicate record' });
  assert.equal(f.rows.assets[0].is_active, false); assert.equal(f.rows.asset_rental_terms[0].status, 'active');
  await changeAssetDeleted(f.context, { id, version: assetVersion(f.rows.assets[0], f.rows.asset_rental_terms[0]), deleted: false });
  assert.equal(f.rows.assets[0].is_active, true); assert.deepEqual(f.rows.asset_events.map(r => r.event_type), ['deleted', 'restored']);
  assert.ok(!f.calls.some(c => c.op === 'delete'));
});
test('stale editors and concurrent writes cannot overwrite newer values', async () => {
  const f = fixture(); f.rows.assets[0].manufacturer = 'Newer';
  await assert.rejects(editAsset(f.context, f.input, f.resolveType), /changed after/);
  const g = fixture({ concurrent: true }); await assert.rejects(editAsset(g.context, g.input, g.resolveType), /changed after/);
  assert.equal(g.rows.assets[0].manufacturer, 'Concurrent edit'); assert.equal(g.rows.asset_events.length, 0);
});
test('company and location scope are enforced before every mutation', async () => {
  const f = fixture({ otherCompany: true }); await assert.rejects(changeAssetDeleted(f.context, { id, version: f.input.version, deleted: true }), /outside/);
  const g = fixture(); g.context.authorization.locationScopeIds = [];
  await assert.rejects(editAsset(g.context, g.input, g.resolveType), /outside/);
  const h = fixture(); await assert.rejects(editAsset(h.context, { ...h.input, location_id: '' }, h.resolveType), /scope/);
  for (const x of [f, g, h]) assert.ok(x.calls.every(c => c.op === 'select'));
});
test('issued assets allow detail corrections but block deletion and location changes', async () => {
  const f = fixture({ assigned: true });
  await assert.rejects(changeAssetDeleted(f.context, { id, version: f.input.version, deleted: true }), /issued/);
  await assert.rejects(editAsset(f.context, { ...f.input, tracking_mode: 'quantity' }, f.resolveType), /issued/);
  await editAsset(f.context, f.input, f.resolveType); assert.equal(f.rows.assets[0].manufacturer, 'New make');
});
test('failed rental writes restore asset details; failed history writes restore both', async () => {
  for (const fail of ['asset_rental_terms', 'asset_events']) {
    const f = fixture({ rented: true, fail }); const before = structuredClone(f.rows);
    await assert.rejects(editAsset(f.context, { ...f.input, rental_rate: '200' }, f.resolveType), /Unable/);
    for (const key of ['manufacturer', 'ownership_type', 'notes', 'updated_by']) assert.equal(f.rows.assets[0][key], before.assets[0][key]);
    assert.equal(f.rows.asset_rental_terms[0].rental_rate, 100); assert.equal(f.rows.asset_events.length, 0);
  }
});
test('failed archive history restores visibility', async () => {
  const f = fixture({ fail: 'asset_events' }); await assert.rejects(changeAssetDeleted(f.context, { id, version: f.input.version, deleted: true }), /history/);
  assert.equal(f.rows.assets[0].is_active, true);
});
test('owned to rental conversion cleans up only its new term if history fails', async () => {
  const f = fixture({ fail: 'asset_events' });
  await assert.rejects(editAsset(f.context, { ...f.input, ownership_type: 'rented', rental_vendor_name: 'Vendor', rental_rate: '100', rental_starts_on: '2026-09-01' }, f.resolveType), /history/);
  assert.equal(f.rows.assets[0].ownership_type, 'owned'); assert.equal(f.rows.asset_rental_terms.length, 0);
});
test('rental to owned retains the prior agreement as expired', async () => {
  const f = fixture({ rented: true }); await editAsset(f.context, { ...f.input, ownership_type: 'owned' }, f.resolveType);
  assert.equal(f.rows.assets[0].ownership_type, 'owned'); assert.equal(f.rows.asset_rental_terms[0].status, 'expired'); assert.equal(f.rows.asset_rental_terms[0].rental_rate, 100);
});
test('deleted assets cannot be edited until restored', async () => {
  const f = fixture(); f.rows.assets[0].is_active = false; f.input.version = assetVersion(f.rows.assets[0], null);
  await assert.rejects(editAsset(f.context, f.input, f.resolveType), /Restore/);
});
test('asset form preserves zeroes and validates dates, quantities and money', () => {
  const f = fixture({ rented: true }); const v = assetFormValues({ ...f.rows.assets[0], purchase_value: 0, rental_term: f.rows.asset_rental_terms[0] });
  assert.equal(v.purchase_value, '0'); assert.equal(v.rental_rate, '100'); assert.equal(v.rental_security_deposit, '0');
  for (const [field, value] of [['purchase_date', '2026-02-30'], ['gst_rate', '101'], ['purchase_value', '-1'], ['rental_ends_on', '2026-01-01'], ['rental_notice_period_days', '1.5'], ['tracking_mode', 'bad']]) assert.throws(() => parseAssetEdit({ ...f.input, [field]: value }));
  assert.throws(() => parseAssetEdit({ ...f.input, tracking_mode: 'quantity', quantity_total: '2', quantity_faulty: '3' }), /cannot exceed/);
});
test('server actions require Finance edit permission before update, delete or restore', () => {
  const source = readFileSync('src/app/master/assets/actions.ts', 'utf8');
  for (const name of ['updateAsset', 'setAssetDeleted']) {
    const action = source.slice(source.indexOf(`export async function ${name}(`)).split('\nexport async function')[0];
    assert.match(action, /financeContext\("finance_assets"\)/); assert.match(action, /hasPermission\(context.authorization, "finance_assets", "edit"\)/);
  }
});
