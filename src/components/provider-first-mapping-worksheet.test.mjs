import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as mapping from '../lib/provider-first-mapping-view.ts';
import * as history from '../lib/payment-allocation-history.ts';
import * as lookup from '../lib/provider-mapping-lookup.ts';
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
    '@/components/provider-mapping-lookup': { ProviderMappingLookup: 'MappingLookup' },
    '@/components/provider-mapping-schedule': { ProviderMappingSchedule: 'MappingSchedule' },
    '@/components/searchable-select': { SearchableSelect: 'SearchableSelect' },
    '@/components/payment-allocation-history-button': { PaymentAllocationHistoryButton: 'History' },
    '@/components/provider-mapping-worksheet': { MappingMultiFilter: 'MappingMultiFilter' },
    '@/lib/provider-first-mapping-view': mapping,
    '@/lib/provider-mapping-lookup': lookup,
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

test('selecting a legacy-ID parent-station associate asks for dates instead of a false location mismatch', async () => {
  const anchor = {mappingId:'parent-map',stationId:'parent',locationLabel:'JUGD',providerId:'amazon',
    mappedProviderMemberId:row.providerMemberId,paymentMethodId:method.id,paymentValues:{DELIVERY:'15'},
    effectiveFrom:'2026-09-01',effectiveTo:'',status:'active'};
  const ui = worksheet({mappings:[{...row,stationLabel:'JUGF',relatedStationIds:['parent','station-1']}],
    workers:[{...worker,dropxId:'SDGH140021',stationId:'parent',profileStationId:'parent',
      profileLocationLabel:'JUGD',registeredLocationMappings:[anchor],currentMappings:[anchor]}]});
  ui.change('provider_first_worker_0',worker.id);
  assert.equal(ui.all(n=>n.props?.className==='mapping-row-error').length,0);
  assert.match(JSON.stringify(ui.all(n=>n.props?.role==='status')),/Registered at.*JUGD/);
  await ui.save();
  assert.match(JSON.stringify(ui.all(n=>n.props?.className==='mapping-row-error')),/Enter Effective from/);
  ui.one(n=>n.type==='input' && n.props.type==='date' && n.props.required).props.onChange({target:{value:'2026-10-01'}});
  ui.render();
  assert.match(JSON.stringify(ui.all(n=>n.props?.className==='mapping-period-help')),/Keep all.*JUGD/);
});
function saved(data) {
  const value = key => data.get(`rows[0][${key}]`);
  return { ok: true, message: 'Mapping saved.', savedRows: [{ clientKey: value('client_key'), workforceId: value('id'), mappingId: 'saved-1', paymentMethodId: value('payment_method_id'), paymentValues: JSON.parse(value('payment_values_json')), productionThresholdConfig: null, productionThresholdMinimumUnits: '', effectiveFrom: value('effective_from'), effectiveTo: value('effective_to') }] };
}

test('unmapped selection never inherits a closed September method, rates, thresholds or dates', async () => {
  const oldPeriod = { mappingId: 'september-closed', stationId: row.stationId, locationLabel: 'KOZA', providerId: row.providerId, mappedProviderMemberId: row.providerMemberId, paymentMethodId: 'old-method', paymentValues: { DELIVERY: '13' }, productionThresholdConfig: { period: 'day', component_codes: ['DELIVERY'] }, productionThresholdMinimumUnits: '20', effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30', status: 'closed' };
  const historicWorker = { ...worker, dateOfJoin: '2026-09-01', mappingHistory: [oldPeriod], registeredLocationMappings: [oldPeriod] };
  const historyEntry = { id: oldPeriod.mappingId, paymentMethodId: oldPeriod.paymentMethodId, paymentMethodName: 'Old method', paymentValues: oldPeriod.paymentValues, effectiveFrom: oldPeriod.effectiveFrom, effectiveTo: oldPeriod.effectiveTo, storedStatus: 'closed' };
  let submitted;
  const ui = worksheet({ workers: [historicWorker], mappings: [{ ...row, history: [historyEntry] }] }, async data => { submitted = data; return saved(data); });
  ui.change('provider_first_worker_0', worker.id);
  assert.equal(ui.cards().length, 1);
  assert.equal(ui.select('provider_first_payment_method_0').value, '');
  assert.equal(ui.all(node => node.type === 'input' && node.props.type === 'number').length, 0);
  assert.deepEqual(ui.all(node => node.type === 'input' && node.props.type === 'date').map(node => node.props.value), ['', '']);
  assert.deepEqual(ui.one(node => node.type === 'History').props.entries, [historyEntry]);
  assert.equal(ui.one(node => node.type === 'button' && node.props.children === '+ Add payment period').props.disabled, true);
  await ui.save();
  assert.equal(submitted, undefined, 'Incomplete new pay details must not be submitted');
  ui.change('provider_first_payment_method_0', method.id);
  ui.one(node => node.type === 'input' && node.props.type === 'number').props.onChange({ target: { value: '17' } }); ui.render();
  // Choosing even the old exact interval must not restore its rate or edit ID.
  ui.one(node => node.type === 'input' && node.props.type === 'date' && node.props.required).props.onChange({ target: { value: '2026-09-01' } }); ui.render();
  ui.one(node => node.type === 'input' && node.props.type === 'date' && !node.props.required).props.onChange({ target: { value: '2026-09-30' } }); ui.render();
  assert.equal(ui.select('provider_first_payment_method_0').value, method.id);
  assert.equal(ui.one(node => node.type === 'input' && node.props.type === 'number').props.value, '17');
  ui.one(node => node.type === 'input' && node.props.type === 'date' && node.props.required).props.onChange({ target: { value: '2026-10-01' } }); ui.render();
  ui.one(node => node.type === 'input' && node.props.type === 'date' && !node.props.required).props.onChange({ target: { value: '' } }); ui.render();
  await ui.save();
  assert.equal(submitted.get('rows[0][mapping_id]'), '');
  assert.equal(submitted.get('rows[0][payment_values_json]'), '{"DELIVERY":"17"}');
  assert.equal(submitted.get('rows[0][effective_from]'), '2026-10-01');
  assert.equal(submitted.get('rows[0][effective_to]'), '');
  assert.equal(submitted.get('rows[0][production_threshold_minimum_units]'), '');
});

test('reselecting the same new associate preserves manual fields; switching associates clears them', () => {
  const second = { ...worker, id: 'worker-2', dropxId: 'DROPX2' };
  const ui = worksheet({ workers: [worker, second] });
  completeDraft(ui);
  ui.change('provider_first_worker_0', worker.id);
  assert.equal(ui.select('provider_first_payment_method_0').value, method.id);
  assert.equal(ui.one(node => node.type === 'input' && node.props.type === 'number').props.value, '15');
  ui.change('provider_first_worker_0', second.id);
  assert.equal(ui.select('provider_first_payment_method_0').value, '');
  assert.deepEqual(ui.all(node => node.type === 'input' && node.props.type === 'date').map(node => node.props.value), ['', '']);
});

test('existing mapped rows retain their saved pay details when reselected', () => {
  const mapped = { ...row, workforceId: worker.id, dropxId: worker.dropxId, dropxName: worker.fullName, mappingId: 'saved-1', paymentMethodId: method.id, paymentValues: { DELIVERY: '15' }, effectiveFrom: '2026-10-01', effectiveTo: '2026-10-20' };
  const ui = worksheet({ mappings: [mapped] });
  ui.filter('Mapping').setSelected(['mapped']); ui.render();
  ui.change('provider_first_worker_0', worker.id);
  assert.equal(ui.select('provider_first_payment_method_0').value, method.id);
  assert.equal(ui.one(node => node.type === 'input' && node.props.type === 'number').props.value, '15');
  assert.deepEqual(ui.all(node => node.type === 'input' && node.props.type === 'date').map(node => node.props.value), ['2026-10-01', '2026-10-20']);
});

test('previous payment details are copied only on request, explain their source, and retain new dates', async () => {
  const previous = { mappingId: 'september-closed', stationId: row.stationId, locationLabel: 'KOZA', providerId: row.providerId, mappedProviderMemberId: row.providerMemberId, paymentMethodId: method.id, paymentValues: { DELIVERY: '13' }, productionThresholdConfig: null, productionThresholdMinimumUnits: '', effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30', status: 'closed' };
  let submitted;
  const ui = worksheet({ workers: [{ ...worker, mappingHistory: [previous] }] }, async data => { submitted = data; return saved(data); });
  ui.change('provider_first_worker_0', worker.id);
  assert.equal(ui.select('provider_first_payment_method_0').value, '');
  ui.one(node => node.type === 'input' && node.props.type === 'date' && node.props.required).props.onChange({ target: { value: '2026-10-01' } }); ui.render();
  ui.one(node => node.type === 'button' && node.props.children === 'Use previous payment details').props.onClick(); ui.render();
  assert.equal(submitted, undefined, 'Copying only changes the draft');
  assert.equal(ui.select('provider_first_payment_method_0').value, method.id);
  assert.equal(ui.one(node => node.type === 'input' && node.props.type === 'number').props.value, '13');
  assert.deepEqual(ui.all(node => node.type === 'input' && node.props.type === 'date').map(node => node.props.value), ['2026-10-01', '']);
  const notice = ui.one(node => node.type === 'div' && node.props.role === 'status');
  const text = JSON.stringify(notice.props.children);
  assert.match(text, /Previous payment details loaded/);
  assert.match(text, /Variable pay/);
  assert.match(text, /KOZA/);
  assert.match(text, /2026-09-01/);
  assert.match(text, /2026-09-30/);
  assert.match(text, /Previous dates were not copied/);
  await ui.save();
  assert.equal(submitted.get('rows[0][mapping_id]'), '');
  assert.equal(submitted.get('rows[0][effective_from]'), '2026-10-01');
  assert.equal(submitted.get('rows[0][effective_to]'), '');
});

test('previous payment templates select the latest exact identity and reject unrelated history', () => {
  const selected = { ...row, workforceId: worker.id };
  const old = { mappingId: 'old', stationId: row.stationId, locationLabel: 'KOZA', providerId: row.providerId, mappedProviderMemberId: row.providerMemberId, paymentMethodId: method.id, paymentValues: { DELIVERY: '13' }, productionThresholdConfig: null, productionThresholdMinimumUnits: '', effectiveFrom: '2026-08-01', effectiveTo: '2026-08-31', status: 'closed' };
  const recent = { ...old, mappingId: 'recent', paymentValues: { DELIVERY: '17' }, effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30' };
  const unrelated = [ { ...recent, mappingId: 'wrong-member', mappedProviderMemberId: 'other' }, { ...recent, mappingId: 'wrong-provider', providerId: 'other' }, { ...recent, mappingId: 'wrong-station', stationId: 'other' }, { ...recent, mappingId: 'future', effectiveFrom: '2099-01-01', effectiveTo: '2099-01-31' } ];
  assert.equal(mapping.providerFirstPaymentTemplateForRow(selected, { ...worker, mappingHistory: unrelated }), undefined);
  assert.equal(mapping.providerFirstPaymentTemplateForRow(selected, { ...worker, mappingHistory: [old, ...unrelated, recent] }).mappingId, 'recent');
});

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

test('payment-period plus requires the first end date and opens the plan without hiding the row',()=>{
 const ui=worksheet();completeDraft(ui);
 const plus=()=>ui.one(n=>n.type==='button'&&n.props.children==='+ Add payment period');
 assert.equal(plus().props.disabled,true);
 ui.one(n=>n.type==='input'&&n.props.type==='date'&&!n.props.required).props.onChange({target:{value:'2026-10-10'}});ui.render();
 assert.equal(plus().props.disabled,false);
 plus().props.onClick();ui.render();
 assert.equal(ui.one(n=>n.type==='MappingSchedule').props.row.effectiveTo,'2026-10-10');
 assert.equal(ui.cards().length,1);
});

test('dropdown offers every authorized associate across locations and lookup reflects only successful saves',async()=>{
 const ui=worksheet({workers:[worker,{...worker,id:'elsewhere',profileStationId:'station-2'}],lookupEntries:[{key:'u',stationId:'station-1',providerMemberId:row.providerMemberId,history:[]}]},async data=>saved(data));
 assert.deepEqual(ui.select('provider_first_worker_0').options.map(option=>option.value),[worker.id,'elsewhere']);
 completeDraft(ui);
 assert.equal(ui.one(n=>n.type==='MappingLookup').props.entries[0].history.length,0);
 await ui.save();
 assert.equal(ui.one(n=>n.type==='MappingLookup').props.entries[0].dropxId,worker.dropxId);
 assert.equal(ui.one(n=>n.type==='MappingLookup').props.entries[0].history[0].id,'saved-1');
});
