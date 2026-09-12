import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
function compile(path, dependencies = {}) {
  const exports = {};
  new Function('require', 'exports', ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX
  } }).outputText)(name => dependencies[name] ?? require(name), exports);
  return exports;
}
const cod = compile('src/lib/ops-pulse/review-cod.ts');
const logic = compile('src/lib/ops-pulse/review-cod-rca.ts');
const importedAt = '2026-09-10T05:30:00Z';
function snapshot(bucket = '2 Days', amount = 123.45) {
  const rows = [{ row_number: 1, station_code: 'TEST', normalized_data: { balance_due: 1000, age_bucket: '0-1 Days' } },
    { row_number: 2, station_code: 'TEST', normalized_data: { balance_due: amount, age_bucket: bucket } }];
  return { stationCode: 'TEST', batchId: 'batch1', importedAt, fileName: 'test.csv', error: null,
    summary: cod.summarizeReviewCod(rows.map(r => cod.parseReviewCodLine(r, 'TEST', importedAt)).filter(Boolean)) };
}
for (const bucket of ['0 Days', '1 Day', '0-1 Days']) assert.equal(logic.buildCodRca(snapshot(bucket)).length, 0);
for (const bucket of ['2 Days', '2+ Days', '3-4 Days']) assert.equal(logic.buildCodRca(snapshot(bucket))[0].actual, 123.45);
assert.equal(logic.buildCodRca(snapshot('2 Days', 0)).length, 0);
assert.equal(logic.buildCodRca({ ...snapshot(), error: 'Incomplete import' }).length, 0);
assert.equal(logic.codRemark(' Bank\n reconciliation  pending '), 'Bank reconciliation pending');
assert.throws(() => logic.codRemark(' \n '), /short COD/);
assert.throws(() => logic.codRemark('x'.repeat(241)), /240/);
assert.equal(logic.codRemark('x'.repeat(240)).length, 240);
assert.equal(logic.missingCodRemark(logic.buildCodRca(snapshot()), [{ metric_key: 'other', root_cause: 'Saved' }]), true);
assert.equal(logic.missingCodRemark([], []), false);

let current = snapshot();
const source = compile('src/lib/ops-pulse/review-cod-rca-data.ts', {
  'server-only': {}, './review-cod-rca': logic, './review-cod-data': { loadReviewCod: async (company, station) => {
    assert.equal(company, 'company1'); assert.equal(station, 'TEST'); return { snapshot: current };
  } }
});
current = { ...snapshot(), summary: null };
await assert.rejects(() => source.loadCodRca('company1', 'TEST'), /Unable to verify COD/);
current = { ...snapshot(), error: 'Incomplete' };
await assert.rejects(() => source.loadCodRca('company1', 'TEST'), /Unable to verify COD/);
current = snapshot();

// In-memory database only. No production reviews are started, changed or completed.
let saved = [], calls = [], scope = true, canEdit = false, canComplete = true, canBypass = true, savedError = false;
const review = { id: 'review1', station_id: 'station1', station_code: 'TEST', source_date: '2026-09-09', updated_at: 'version1', current_step_order: 1, status: 'in_review' };
let steps = [{ id: 'step1', step_order: 1, status: 'pending' }];
const db = { from(table) {
  const filters = [];
  const result = () => {
    const data = table === 'stations' ? scope ? { id: 'station1', station_code: 'TEST' } : null
      : table === 'ops_performance_reviews' ? filters.every(([k,v]) => k === 'company_id' ? v === 'company1' : review[k] === v) ? review : null
      : table === 'ops_performance_review_steps' ? steps : saved;
    return { data, error: savedError && table === 'ops_performance_review_items' ? { message: 'Unavailable' } : null };
  };
  const q = { select() { return q; }, eq(k,v) { filters.push([k,v]); calls.push([table,k,v]); return q; },
    order() { return Promise.resolve(result()); }, maybeSingle() { return Promise.resolve(result()); }, then(a,b) { return Promise.resolve(result()).then(a,b); } }; return q;
}, async rpc(name, args) { calls.push([name,args]); if (args.p_action === 'item') saved = [args.p_data]; return { error: null }; } };
const discipline = { isDisciplineRcaKey: () => false, missingDisciplineReasons: () => [] };
const actions = compile('src/app/ops-pulse/performance/actions.ts', {
  'next/cache': { revalidatePath() {} }, '@/lib/company-scope': { requireCompanyId: () => 'company1' }, '@/lib/supabase-admin': { supabaseAdmin: db },
  '@/lib/authorization': { requirePagePermission: async () => ({ userId: 'user1', fullName: 'Test reviewer', hasAllLocationAccess: false, locationScopeIds: ['station1'] }) },
  '@/lib/ops-pulse/performance-review': {}, '@/lib/ops-pulse/review-policy': { visibleReviewStep: () => true, reviewBypassReason: v => v },
  '@/lib/ops-pulse/review-access': {
    isScorecardImported: async () => true,
    getReviewAccess: async () => ({ scorecardImported: true, canEditRca: canEdit, canComplete, canComment: true, canBypass, actor: { label: 'AOM' } })
  },
  '@/lib/ops-pulse/review-discipline-rca': discipline, '@/lib/ops-pulse/review-discipline-rca-data': { loadDisciplineRca: async () => [] },
  '@/lib/ops-pulse/review-cod-rca': logic, '@/lib/ops-pulse/review-cod-rca-data': source
});
const form = (values = {}) => { const f = new FormData(); Object.entries({ review_id: 'review1', station_code: 'TEST', source_date: '2026-09-09', metric_key: logic.COD_REMARK_KEY, root_cause: 'Bank reconciliation pending', metric_label: 'Forged', actual_value: '999', intent: 'complete', step_id: 'step1', reason: 'Approved reassignment', ...values }).forEach(([k,v]) => f.set(k,v)); return f; };
const rpcCount = () => calls.filter(c => c[0].startsWith('ops_') && typeof c[1] === 'object').length;
assert.match((await actions.savePerformanceReviewComment(form())).error, /COD pending 2\+ days/);
assert.match((await actions.bypassPerformanceReviewLevel(form())).error, /COD pending 2\+ days/);
assert.equal(rpcCount(), 0);
assert.match((await actions.savePerformanceCodRemark(form({ root_cause: ' ' }))).error, /short COD/);
assert.match((await actions.savePerformanceCodRemark(form({ root_cause: 'x'.repeat(241) }))).error, /240/);
assert.match((await actions.savePerformanceCodRemark(form({ metric_key: 'other' }))).error, /Select the COD/);
assert.match((await actions.savePerformanceCodRemark(form({ review_id: 'another' }))).error, /unavailable/);
assert.match((await actions.savePerformanceCodRemark(form({ source_date: '2026-09-08' }))).error, /unavailable/);
canComplete = false;
assert.match((await actions.savePerformanceCodRemark(form())).error, /current reviewer/);
canComplete = true; scope = false;
assert.match((await actions.savePerformanceCodRemark(form())).error, /location access/);
scope = true;
assert.equal((await actions.savePerformanceCodRemark(form())).notice, 'COD remark saved.');
assert.equal(saved[0].actual_value, 123.45); assert.equal(saved[0].metric_label, 'COD pending · 2+ days');
assert.equal(saved[0].corrective_action, ''); assert.equal(saved[0].status, 'done'); assert.equal(saved[0].expected_review_version, 'version1');
assert.ok(calls.some(c => c[0] === 'ops_performance_review_items' && c[1] === 'company_id' && c[2] === 'company1'));
assert.ok((await actions.savePerformanceReviewComment(form())).notice);
assert.ok((await actions.bypassPerformanceReviewLevel(form())).notice);
savedError = true;
assert.match((await actions.savePerformanceReviewComment(form())).error, /Unable to check saved/);
savedError = false; saved = []; current = { ...snapshot(), error: 'Incomplete' };
assert.match((await actions.savePerformanceReviewComment(form())).error, /Unable to verify COD/);
assert.equal((await actions.savePerformanceReviewComment(form({ intent: 'comment', feedback: 'Source check requested' }))).notice, 'Comment added.');
current = snapshot('0-1 Days');
assert.ok((await actions.savePerformanceReviewComment(form())).notice, '0–1 days does not need a remark');
assert.match((await actions.savePerformanceCodRemark(form())).error, /No COD balance/);
current = snapshot(); steps.push({ id: 'step2', step_order: 2, status: 'pending' });
assert.ok((await actions.bypassPerformanceReviewLevel(form())).notice, 'Non-final authorized bypass retains workflow');
canEdit = true;
assert.match((await actions.savePerformanceReviewItem(form())).error, /COD remark form/);

const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const ui = compile('src/components/performance-rca-actions.tsx', {
  '@/components/review-details': compile('src/components/review-details.tsx'), '@/lib/date-format': { formatDashboardDate: v => v },
  '@/app/ops-pulse/performance/actions': actions, '@/lib/ops-pulse/review-discipline-rca': { ...discipline, DISCIPLINE_REASON_MAX: 240 }, '@/lib/ops-pulse/review-cod-rca': logic,
  '@/components/review-attendance-history': { ReviewPersonHistoryLink: () => null },
  '@/components/review-action-form': { ReviewActionForm: ({ children }) => React.createElement('form', null, children) }
});
const props = { rows: logic.buildCodRca(snapshot()), date: review.source_date, itemsByMetric: new Map(), reviewId: review.id, reviewVersion: review.updated_at, stationCode: 'TEST', canEdit: false, canEditDiscipline: true, activeDisciplineKeys: [logic.COD_REMARK_KEY] };
const html = renderToStaticMarkup(React.createElement(ui.PerformanceRcaActions, props));
assert.ok(html.includes('₹123.45') && html.includes('COD pendency reason / remarks') && html.includes('Save COD remark') && html.includes('id="review-cod-remark"'));
assert.ok(html.includes('maxLength="240"') && !html.includes('name="corrective_action"') && !html.includes('min late') && !html.includes('12345.0%'));
const readonly = renderToStaticMarkup(React.createElement(ui.PerformanceRcaActions, { ...props, canEditDiscipline: false, itemsByMetric: new Map([[logic.COD_REMARK_KEY, { root_cause: 'Recorded bank delay' }]]) }));
assert.ok(readonly.includes('Recorded bank delay') && !readonly.includes('<form'));
console.log('PASS COD RCA: 0–1 excluded, 2+ required, trusted source amounts, company/station/role guards, short remarks, completion/final-bypass gates and compact currency UI.');
