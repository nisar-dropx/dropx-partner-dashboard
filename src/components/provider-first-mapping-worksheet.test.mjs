import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as mapping from '../lib/provider-first-mapping-view.ts';
import * as history from '../lib/payment-allocation-history.ts';
import * as threshold from '../lib/production-threshold-snapshot.ts';
import { dashboardDateInputValue } from '../lib/date-format.ts';

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL('./provider-first-mapping-worksheet.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const method = { id: 'variable', code: 'VAR', name: 'Variable pay', components: [{ code: 'DELIVERY', label: 'Delivery rate', type: 'amount' }], productionThresholdConfig: null };
const worker = { id: 'worker-1', dropxId: 'DROPX1', fullName: 'Asha Devi', stationId: 'station-1', profileStationId: 'station-1', providerId: 'amazon', dateOfJoin: '2026-10-01', mappingId: '', paymentMethodId: '', paymentValues: {}, productionThresholdConfig: null, productionThresholdMinimumUnits: '', effectiveFrom: '', effectiveTo: '', mappedProviderMemberId: '', locationLabel: 'KOZA', onboardingStatus: 'Active' };
const row = { providerMemberId: '12345678901', providerMemberName: 'Asha Devi', stationId: 'station-1', stationLabel: 'KOZA', providerId: 'amazon', workforceId: '', dropxId: '', dropxName: '', mappingId: '', paymentMethodId: '', paymentValues: {}, productionThresholdConfig: null, productionThresholdMinimumUnits: '', effectiveFrom: '', effectiveTo: '', outboundMonths: ['2026-10'], history: [] };

// Drive the real worksheet's event handlers and hook state. Only rendering-only
// children and the server boundary are substituted; filtering/validation/save
// reconciliation use production code. Nothing writes to a live database.
function worksheet(props = {}, save = async () => ({ ok: false, savedRows: [], message: 'Retry required' })) {
  const slots = [];
  let cursor = 0;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useMemo(fn, deps) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) slots[index] = { deps, value: fn() };
      return slots[index].value;
    },
    useDeferredValue(value) { return value; }
  };
  const boundaries = {
    react: hooks,
    '@/app/provider-mapping/actions': { saveProviderFirstMappingsInline: save },
    '@/components/searchable-select': { SearchableSelect: 'SearchableSelect' },
    '@/components/payment-allocation-history-button': { PaymentAllocationHistoryButton: 'History' },
    '@/components/provider-mapping-worksheet': { MappingMultiFilter: 'MappingMultiFilter' },
    '@/lib/provider-first-mapping-view': mapping,
    '@/lib/payment-allocation-history': history,
    '@/lib/production-threshold-snapshot': threshold
  };
  const module = { exports: {} };
  new Function('require', 'exports', 'module', compiled)(name => boundaries[name] ?? require(name), module.exports, module);
  const input = { initialOutboundMonth: '2026-10', canEdit: true, mappings: [row], workers: [worker], paymentMethods: [method], shipmentMonths: ['2026-09', '2026-10'], ...props };
  let tree;
  const render = () => { cursor = 0; tree = module.exports.ProviderFirstMappingWorksheet(input); return tree; };
  function all(predicate, root = tree) {
    if (Array.isArray(root)) return root.flatMap(child => all(predicate, child));
    if (!root || typeof root !== 'object') return [];
    return [...(predicate(root) ? [root] : []), ...all(predicate, root.props?.children ?? null)];
  }
  const one = predicate => { const found = all(predicate); assert.equal(found.length, 1); return found[0]; };
  render();
  return {
    render, all, one,
    cards: () => all(node => node.type === 'div' && node.props.className?.includes('mapping-row-card')),
    filter: label => one(node => node.type === 'MappingMultiFilter' && node.props.label === label).props,
    select: name => one(node => node.type === 'SearchableSelect' && node.props.name === name).props,
    change(name, value) { this.select(name).onValueChange(value); render(); },
    async save() { one(node => node.type === 'button' && node.props.className?.includes('mapping-save-all')).props.onClick(); await new Promise(setImmediate); render(); }
  };
}
function completeDraft(ui, index = 0) {
  ui.change(`provider_first_worker_${index}`, worker.id);
  assert.equal(ui.select(`provider_first_worker_${index}`).value, worker.id);
  ui.change(`provider_first_payment_method_${index}`, method.id);
  ui.one(node => node.type === 'input' && node.props.type === 'number').props.onChange({ target: { value: '15' } });
  ui.render();
  ui.one(node => node.type === 'input' && node.props.type === 'date' && node.props.required).props.onChange({ target: { value: '2026-10-03' } });
  ui.render();
}
function saved(data) {
  const value = key => data.get(`rows[0][${key}]`);
  return { ok: true, message: 'Mapping saved.', savedRows: [{ clientKey: value('client_key'), workforceId: value('id'), mappingId: 'saved-1', paymentMethodId: value('payment_method_id'), paymentValues: JSON.parse(value('payment_values_json')), productionThresholdConfig: null, productionThresholdMinimumUnits: '', effectiveFrom: value('effective_from'), effectiveTo: value('effective_to') }] };
}

test('opens with current outbound month and Unmapped, including when that month has no imported data', () => {
  const ui = worksheet({ shipmentMonths: ['2026-09'], mappings: [{ ...row, outboundMonths: ['2026-09'] }] });
  assert.deepEqual(ui.filter('Outbound month').selected, ['2026-10']);
  assert.deepEqual(ui.filter('Mapping').selected, ['unmapped']);
  assert.equal(ui.filter('Outbound month').options[0].label, 'October 2026');
  assert.equal(ui.cards().length, 0);
  ui.filter('Outbound month').setSelected(['2026-09']); ui.render();
  assert.equal(ui.cards().length, 1);
  ui.one(node => node.type === 'button' && node.props.children === 'Clear').props.onClick(); ui.render();
  assert.deepEqual(ui.filter('Outbound month').selected, []);
  assert.deepEqual(ui.filter('Mapping').selected, []);
});

test('associate, method, rate and date edits stay visible under all original filters until successful save', async () => {
  let submitted;
  let fail = true;
  const ui = worksheet({}, async data => {
    submitted = data;
    return fail ? { ok: false, savedRows: [], failedClientKey: data.get('rows[0][client_key]'), message: 'Temporary save failure' } : saved(data);
  });
  ui.filter('Payment method').setSelected(['unassigned']);
  ui.filter('Validation').setSelected(['unmapped']); ui.render();
  completeDraft(ui);
  assert.equal(ui.cards().length, 1);
  await ui.save();
  assert.equal(submitted.get('rows[0][effective_from]'), '2026-10-03');
  assert.equal(submitted.get('rows[0][payment_values_json]'), '{"DELIVERY":"15"}');
  assert.equal(ui.cards().length, 1);
  assert.equal(ui.select('provider_first_worker_0').value, worker.id);
  assert.equal(ui.one(node => node.type === 'input' && node.props.type === 'number').props.value, '15');
  fail = false; await ui.save();
  assert.equal(ui.cards().length, 0, 'Saved row now leaves Unmapped');
  ui.filter('Payment method').setSelected([]); ui.filter('Validation').setSelected([]); ui.filter('Mapping').setSelected(['mapped']); ui.render();
  assert.equal(ui.cards().length, 1);
  assert.equal(ui.select('provider_first_worker_0').value, worker.id);
});

test('a transport failure retains the draft and its fields for retry', async () => {
  const ui = worksheet({}, async () => { throw new Error('Network unavailable'); });
  completeDraft(ui); await ui.save();
  assert.equal(ui.cards().length, 1);
  assert.equal(ui.select('provider_first_payment_method_0').value, method.id);
  assert.equal(ui.one(node => node.type === 'p' && node.props['aria-live'] === 'polite').props.children, 'Network unavailable');
});

test('clearing an existing associate stays visible in Mapped until Save', () => {
  const mapped = { ...row, workforceId: worker.id, dropxId: worker.dropxId, dropxName: worker.fullName, mappingId: 'saved-1', paymentMethodId: method.id, paymentValues: { DELIVERY: '15' }, effectiveFrom: '2026-10-01' };
  const ui = worksheet({ mappings: [mapped] });
  ui.filter('Mapping').setSelected(['mapped']); ui.render();
  ui.change('provider_first_worker_0', '');
  assert.equal(ui.cards().length, 1);
  assert.equal(ui.select('provider_first_worker_0').value, '');
});

test('selection does not shrink the last page or jump to another page', () => {
  const ui = worksheet({ mappings: Array.from({ length: 51 }, (_, i) => ({ ...row, providerMemberId: String(12345678901 + i) })) });
  ui.one(node => node.type === 'button' && node.props.children === 'Next').props.onClick(); ui.render();
  assert.equal(ui.cards().length, 1);
  ui.change('provider_first_worker_50', worker.id);
  assert.equal(ui.cards().length, 1);
  assert.equal(ui.select('provider_first_worker_50').value, worker.id);
});

test('current month uses IST at month and year boundaries and is passed by the server', () => {
  assert.equal(dashboardDateInputValue(new Date('2026-09-30T18:29:59Z')).slice(0, 7), '2026-09');
  assert.equal(dashboardDateInputValue(new Date('2026-09-30T18:30:00Z')).slice(0, 7), '2026-10');
  assert.equal(dashboardDateInputValue(new Date('2026-12-31T18:30:00Z')).slice(0, 7), '2027-01');
  const page = readFileSync(new URL('../app/provider-id-mapping/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /initialOutboundMonth=\{dashboardDateInputValue\(\)\.slice\(0, 7\)\}/);
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts['test:provider-mapping-period'], /provider-first-mapping-worksheet\.test\.mjs/);
  assert.match(pkg.scripts.build, /test:provider-mapping-period/);
});
