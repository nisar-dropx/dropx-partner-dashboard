import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { canonicalizeProviderFirstMembers, providerFirstScopeOptions, filterProviderFirstRowIndexes, providerMappingMonthOptions, providerSourceMemberKey } from './provider-first-mapping-view.ts';

import { isProviderMappingLocation } from './provider-mapping-location-scope.ts';

const filters = { query: '', stationIds: [], paymentMethodIds: [], mappingStatuses: [], validationStatuses: [] };
const row = { providerMemberId: '12345678901', providerMemberName: 'Asha', stationId: 'a', stationLabel: 'A', workforceId: '', dropxId: '', dropxName: '', paymentMethodId: '', paymentValues: {}, productionThresholdConfig: null, productionThresholdMinimumUnits: '', effectiveFrom: '', effectiveTo: '' };
const visible = (rows, changes = {}) => filterProviderFirstRowIndexes({ rows, workerById: new Map(), paymentMethodById: new Map(), filters: { ...filters, ...changes } });

test('month selection uses any selected month and intersects other filters without changing edits', () => {
  const rows = [{ ...row, outboundMonths: ['2026-09', '2026-10'], paymentValues: { delivery: 'edited' } }, { ...row, stationId: 'b', outboundMonths: ['2026-08'] }, { ...row, outboundMonths: [] }];
  assert.deepEqual(visible(rows), [0, 1, 2]);
  assert.deepEqual(visible(rows, { outboundMonths: ['2026-09'] }), [0]);
  assert.deepEqual(visible(rows, { outboundMonths: ['2026-09', '2026-08'] }), [0, 1]);
  assert.deepEqual(visible(rows, { outboundMonths: ['2026-09', '2026-08'], stationIds: ['b'] }), [1]);
  assert.deepEqual(visible(rows, { outboundMonths: ['2025-09'] }), []);
  assert.deepEqual(visible(rows, { outboundMonths: ['2026-09'], query: 'missing' }), []);
  assert.deepEqual(visible(rows, { outboundMonths: [] }), [0, 1, 2]);
  assert.equal(rows[0].paymentValues.delivery, 'edited');
});

test('available month options are unique, searchable by name or year/month, and newest first', () => {
  assert.deepEqual(providerMappingMonthOptions(['2026-09', '2025-09', '2026-10', '2026-09', 'bad', '2026-13']), [
    { value: '2026-10', label: 'October 2026', searchText: 'October 2026 2026-10' },
    { value: '2026-09', label: 'September 2026', searchText: 'September 2026 2026-09' },
    { value: '2025-09', label: 'September 2025', searchText: 'September 2025 2025-09' }
  ]);
});

test('region and People cluster/AOM filters intersect month, status and location filters', () => {
  const rows = [
    { ...row, region: 'North', clusterKeys: ['cm:1'], outboundMonths: ['2026-10'] },
    { ...row, stationId: 'b', region: 'South', clusterKeys: ['aom:2'], outboundMonths: ['2026-10'] },
    { ...row, region: 'North', clusterKeys: ['cm:3'], outboundMonths: ['2026-09'] },
    { ...row, region: 'North', clusterKeys: ['cm:1'], outboundMonths: ['2026-10'], workforceId: 'mapped' },
    { ...row, region: 'Unassigned', clusterKeys: ['unmapped'], outboundMonths: [] }
  ];
  assert.deepEqual(visible(rows, { regions: ['North', 'South'], clusterKeys: ['cm:1', 'aom:2'], outboundMonths: ['2026-10'], mappingStatuses: ['unmapped'] }), [0, 1]);
  assert.deepEqual(visible(rows, { regions: ['South'], clusterKeys: ['aom:2'], stationIds: ['b'] }), [1]);
  assert.deepEqual(visible(rows, { regions: ['North'], clusterKeys: ['aom:2'] }), []);
  assert.deepEqual(visible(rows, { regions: ['Unassigned'], clusterKeys: ['unmapped'] }), [4]);
});

test('mapping scope admits Amazon EDSP/XPT and Flipkart hubs but excludes Amazon Now and unrelated models', () => {
  const location = (provider, model) => ({ providers: { code: provider }, location_models: { code: model } });
  for (const model of ['EDSP', 'XPT', 'XPD']) assert.equal(isProviderMappingLocation(location('AMAZON', model)), true);
  for (const model of ['ODH', 'MDH']) assert.equal(isProviderMappingLocation(location('FLIPKART', model)), true);
  for (const model of ['NOW', 'AMXL', 'DROPX_HO', '']) assert.equal(isProviderMappingLocation(location('AMAZON', model)), false);
  assert.equal(isProviderMappingLocation(location('AMAZON NOW', 'EDSP')), false);
  assert.equal(isProviderMappingLocation(location('FLIPKART', 'NOW')), false);
  assert.equal(isProviderMappingLocation({}), false);
  assert.equal(isProviderMappingLocation({ providers: [{ name: 'Amazon' }], location_models: [{ code: 'XPT' }] }), true);
});

test('Region cascades to Cluster/AOM and Location options without mixing same-named people', () => {
  const rows = [
    { ...row, stationLabel: 'A', region: 'AP', clusterKeys: ['cm:ap'] },
    { ...row, stationId: 'b', stationLabel: 'B', region: 'ODCG', clusterKeys: ['cm:od'] },
    { ...row, stationId: 'c', stationLabel: 'C', region: 'ODCG', clusterKeys: ['aom:od'] }
  ];
  const options = [{ value: 'cm:ap', label: 'Same name' }, { value: 'cm:od', label: 'Same name' }, { value: 'aom:od', label: 'Area manager (AOM)' }, { value: 'cm:now', label: 'Amazon Now manager' }];
  assert.deepEqual(providerFirstScopeOptions(rows, ['ODCG'], [], options), {
    clusters: options.slice(1, 3), stations: [['b', 'B'], ['c', 'C']]
  });
  assert.deepEqual(providerFirstScopeOptions(rows, ['ODCG'], ['aom:od'], options).stations, [['c', 'C']]);
  assert.deepEqual(providerFirstScopeOptions(rows, ['AP', 'ODCG'], [], options).clusters, options.slice(0, 3));
  assert.deepEqual(providerFirstScopeOptions(rows, ['KL'], [], options), { clusters: [], stations: [] });
});

test('rounded legacy IDs contribute months only to an unambiguous canonical ID', () => {
  const exact = { providerMemberId: '12345678901', providerMemberName: 'Asha', stationCode: 'A', outboundMonths: ['2026-10'] };
  const rounded = { ...exact, providerMemberId: '1.234568E+10', outboundMonths: ['2026-09'] };
  const members = canonicalizeProviderFirstMembers([exact, rounded]);
  assert.deepEqual(members[0].outboundMonths, ['2026-10', '2026-09']);
  assert.deepEqual(exact.outboundMonths, ['2026-10']);
  const protectedMembers = canonicalizeProviderFirstMembers([exact, rounded], new Set([providerSourceMemberKey('A', rounded.providerMemberId)]));
  assert.equal(protectedMembers.length, 2);
  assert.deepEqual(protectedMembers[0].outboundMonths, ['2026-10']);
  const ambiguous = canonicalizeProviderFirstMembers([exact, { ...exact, providerMemberId: '12345678902' }, rounded]);
  assert.equal(ambiguous.length, 3);
  assert.deepEqual(ambiguous[0].outboundMonths, ['2026-10']);
});

test('database months retain full history, exclude non-outbound counts, and enforce company/station scope', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create table stations(id uuid, company_id uuid, station_code text);
      create table cps_shipment_daily(company_id uuid, station_code text, provider_employee_id text, provider_employee_name text, work_date date, updated_at timestamptz, client text, amazon_delivery numeric, c_return numeric);
      insert into stations values ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000010','A'),('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000010','B'),('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000020','A');
      insert into cps_shipment_daily values
        ('00000000-0000-0000-0000-000000000010','A',' member ','Old name','2026-09-01',now(),'Amazon',5,0),
        ('00000000-0000-0000-0000-000000000010','A','MEMBER','Latest name','2026-10-01',now(),'Amazon',3,0),
        ('00000000-0000-0000-0000-000000000010','A','MEMBER','Latest name','2026-09-30',now(),'Amazon',0,10),
        ('00000000-0000-0000-0000-000000000010','A','return-only','Return','2026-08-01',now(),'Amazon',0,8),
        ('00000000-0000-0000-0000-000000000010','A','other-client','Other','2026-07-01',now(),'Other',99,0),
        ('00000000-0000-0000-0000-000000000010','B','MEMBER','Elsewhere','2026-06-01',now(),'Amazon',7,0),
        ('00000000-0000-0000-0000-000000000020','A','private','Other company','2025-01-01',now(),'Amazon',7,0);`);
    await db.exec(await readFile(new URL('../../supabase/migrations/20261007143958_provider_mapping_outbound_months.sql', import.meta.url), 'utf8'));
    const call = async (scope) => (await db.query('select ops_cps_mapping_members($1, $2::uuid[]) as members', ['00000000-0000-0000-0000-000000000010', scope])).rows[0].members;
    const members = await call(['00000000-0000-0000-0000-000000000001']);
    assert.equal(members.length, 3);
    const member = members.find((m) => m.provider_employee_id === 'MEMBER');
    assert.equal(member.provider_employee_name, 'Latest name');
    assert.deepEqual(member.outbound_months, ['2026-10', '2026-09']);
    assert.deepEqual(members.find((m) => m.provider_employee_id === 'return-only').outbound_months, []);
    assert.deepEqual(members.find((m) => m.provider_employee_id === 'return-only').shipment_months, ['2026-08']);
    assert.deepEqual(members.find((m) => m.provider_employee_id === 'other-client').shipment_months, []);
    assert.deepEqual(await call([]), []);
    assert.equal((await call(null)).length, 4);
    const grants = (await db.query("select has_function_privilege('anon','ops_cps_mapping_members(uuid,uuid[])','EXECUTE') as anon, has_function_privilege('authenticated','ops_cps_mapping_members(uuid,uuid[])','EXECUTE') as authenticated, has_function_privilege('service_role','ops_cps_mapping_members(uuid,uuid[])','EXECUTE') as service")).rows[0];
    assert.deepEqual(grants, { anon: false, authenticated: false, service: true });
  } finally { await db.close(); }
});
