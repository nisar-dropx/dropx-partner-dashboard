const fs = require('fs'), path = require('path'), ts = require('typescript'), assert = require('node:assert/strict');
const cache = new Map(), root = process.cwd();
function load(file) {
  file = path.resolve(file); if (!path.extname(file)) file += fs.existsSync(`${file}.ts`) ? '.ts' : '.tsx';
  if (cache.has(file)) return cache.get(file).exports;
  const m = { exports: {} }; cache.set(file, m);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function('require', 'module', 'exports', js)(id => {
    if (id.endsWith('.css')) return { default: new Proxy({}, { get: (_, key) => key }) };
    if (id.startsWith('@/')) return load(path.join(root, 'src', id.slice(2)));
    if (id.startsWith('.')) return load(path.join(path.dirname(file), id));
    return require(id);
  }, m, m.exports);
  return m.exports;
}
const { recoveryUpdates, totalRecoveryUpdates, filterRecoveryUpdates } = load('src/lib/ops-pulse/loss-recovery-updates.ts');
const plan = (extra = {}) => ({ source_amount: 100, source_status: 'Recoverable', approval_status: 'approved', is_deleted: false, outcome_code: 'responsible', outcome_label: 'Responsible person', deduction_month: '2026-10', allocations: [{ ref: 'employee:1', full_name: 'Example Person', employee_code: 'EMP1', amount: 100 }], updated_at: '2026-10-28T08:00:00Z', recovery_details: {}, ...extra });
const row = (key, extra = {}) => ({ month: '2026-09', case_key: key, station_code: 'AAA', amount: 100, report: 'nl', source_present: true, source_status: 'Recoverable', details: { case_status: 'resolved' }, recovery: plan(), ...extra });
const line = (key, ref, extra = {}) => ({ month: '2026-09', case_key: key, station_code: 'AAA', employee_ref: ref, total: 100, deducted: 0, waived: 0, in_payroll: 0, outstanding: 100, status: 'scheduled', first_salary_month: '2026-10', recovery_mode: 'full', ...extra });
const build = (rows, lines = []) => recoveryUpdates(rows, lines, ['Recoverable'], '2026-10');

let updates = build([row('saved'), row('older', { month: '2026-06' }), row('no-plan', { recovery: null }), row('deleted', { recovery: plan({ is_deleted: true }) }), row('nl-initial', { details: { case_status: 'pending', extra: { current_sla_stage: 'NL1' } } }), row('slp-initial', { report: 'slp', details: { in_initial: true } }), row('slp-final', { report: 'slp', details: { in_final: true } }), row('claim', { report: 'station', source_status: 'Approved' })]);
assert.deepEqual(updates.map(r => r.caseKey).sort(), ['claim', 'older', 'saved', 'slp-final']);
assert.equal(totalRecoveryUpdates(updates).count, 4, 'saved updates appear before any payroll exists');
assert.equal(totalRecoveryUpdates(updates).collected, 0);
assert.equal(totalRecoveryUpdates(updates).outstanding, 400);
assert.equal(totalRecoveryUpdates(updates).people, 1, 'typed people count is unique');
assert.equal(filterRecoveryUpdates(updates, { month: '2026-09' }).length, 3, 'loss month is separate from payroll month');
assert.equal(filterRecoveryUpdates(updates, { query: 'EMP1' }).length, 4);
assert.equal(filterRecoveryUpdates(updates, { station: 'OUTSIDE' }).length, 0);
assert.equal(filterRecoveryUpdates(updates, { status: 'recovered' }).length, 0);

updates = build([row('split'), row('split')], [line('split', 'employee:1', { deducted: 20, in_payroll: 40 }), line('split', 'employee:1', { deducted: 20, in_payroll: 40 }), line('split', 'workforce:1', { deducted: 30 })]);
assert.equal(updates.length, 1);
assert.equal(updates[0].collected, 50, 'split payroll allocations counted once');
assert.equal(updates[0].draft, 40);
assert.equal(updates[0].outstanding, 50, 'draft payroll remains outstanding');
updates = build([row('receipt', { recovery: plan({ outcome_code: 'already_recovered', recovery_details: { received_amount: '100' } }) })], [line('receipt', 'employee:1', { deducted: 40 })]);
assert.equal(updates[0].collected, 100, 'receipt is not added again to payroll');
assert.equal(updates[0].outstanding, 0);
updates = build([row('receipt', { recovery: plan({ approval_status: 'proposed', outcome_code: 'already_recovered', recovery_details: { received_amount: '100' } }) })]);
assert.equal(updates[0].collected, 0, 'pending receipt approval is not recovered');
assert.equal(updates[0].outstanding, 100);
assert.equal(totalRecoveryUpdates(updates).review, 1);
updates = build([row('missing', { source_present: false }), row('returned', { recovery: plan({ approval_status: 'returned' }) }), row('paused', { redispute: { enabled: true, workflow_status: 'review' } }), row('won', { redispute: { workflow_status: 'won' } }), row('cleared', { source_status: 'Non-Recoverable', source_final_nonrecoverable: true })]);
assert.equal(updates.length, 5, 'saved review/stopped cases remain inspectable');
assert.equal(updates.find(r => r.caseKey === 'missing').status, 'review');
assert.equal(updates.find(r => r.caseKey === 'paused').outstanding, 100);
assert.equal(updates.find(r => r.caseKey === 'won').outstanding, 0);
assert.equal(updates.find(r => r.caseKey === 'cleared').outstanding, 0);
assert.equal(totalRecoveryUpdates(updates).collected, 0, 'stopping recovery never fabricates collection');
updates = build([row('waiver')], [line('waiver', 'employee:1', { waived: 100 })]);
assert.equal(updates[0].waived, 100);
assert.equal(updates[0].collected, 0);
assert.equal(updates[0].outstanding, 0);

// Render the production component with saved data and no payroll rows: the original regression.
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const { LossRecoveryUpdates } = load('src/components/loss-recovery-updates.tsx');
const html = renderToStaticMarkup(React.createElement(LossRecoveryUpdates, { rows: build([row('saved')]) }));
assert.match(html, /All months · till date/);
assert.match(html, /Saved recovery TIDs/);
assert.match(html, /saved/);
assert.match(html, /case=saved&amp;month=2026-09/);
assert.match(html, /Example Person/);
console.log('PASS recovery updates: saved before payroll, historical months, initial-case exclusion, split allocations, draft/receipt accounting, stopped/review cases, filters and component rendering.');
