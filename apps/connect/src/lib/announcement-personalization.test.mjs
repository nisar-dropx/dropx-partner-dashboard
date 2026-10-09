import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as policy from './announcement-personalization.ts';

const ground = ['ATL','TL','STM','SSA','PTSSA','HK_P','PC','PTPC','PE','QC','SI','SIC','SM','SRSM'];
const notice = { body: 'HR', read_at: 'read', data: { audienceCopy: { version: 1, fallbackBody: 'HR', rules: [
  { designationCodes: ground, locationModelCodes: ['EDSP','XPT','ODH','MDH'], businessLines: ['edsp','xpt','odh','mdh'], body: 'Cluster Manager' },
  { designationCodes: ground, locationModelCodes: ['NOW'], businessLines: ['amazon_now'], body: 'City Manager or assigned reporting manager' }
] } } };
const context = { workspace: 'people', designationCode: 'TL', locationModelCode: 'EDSP', businessLine: 'other' };
test('ground teams through station manager see cluster manager only for the configured models', () => {
  for (const model of ['EDSP','XPT','ODH','MDH']) for (const role of ['TL','STM','SSA','ATL']) {
    assert.equal(policy.personalizeNotice(notice, { ...context, designationCode: role, locationModelCode: model }).body, 'Cluster Manager');
  }
});
test('Amazon Now includes shift/store leads; managers and office staff see HR', () => {
  for (const role of ['PC','SIC','SI','SM','SRSM']) assert.match(policy.personalizeNotice(notice, { ...context, designationCode: role, locationModelCode: 'NOW' }).body, /City Manager/);
  for (const model of ['EDSP','NOW','DROPX_HO']) for (const role of ['CLM','CM','AOM','NH','MANAGING_PARTNER','HRE','TC']) {
    assert.equal(policy.personalizeNotice(notice, { ...context, designationCode: role, locationModelCode: model }).body, 'HR');
  }
});
test('station model wins over stale business line; business line is a fallback only', () => {
  assert.match(policy.personalizeNotice(notice, { ...context, locationModelCode: 'NOW', businessLine: 'edsp' }).body, /City/);
  assert.equal(policy.personalizeNotice(notice, { ...context, locationModelCode: null, businessLine: 'edsp' }).body, 'Cluster Manager');
  assert.equal(policy.personalizeNotice(notice, { ...context, locationModelCode: 'DROPX_HO', businessLine: 'edsp' }).body, 'HR');
  assert.equal(policy.personalizeNotice(notice, { ...context, locationModelCode: null }).body, 'HR');
});
test('non-People notices and malformed/absent configuration remain unchanged; no read-state mutation', () => {
  assert.equal(policy.personalizeNotice(notice, { ...context, workspace: 'workforce' }), notice);
  for (const data of [null, {}, { audienceCopy: { version: 2 } }, { audienceCopy: { version: 1, fallbackBody: '', rules: [] } }]) {
    const row = { ...notice, data }; assert.equal(policy.personalizeNotice(row, context), row);
  }
  const result = policy.personalizeNotice(notice, context);
  assert.equal(result.read_at, 'read'); assert.equal(notice.body, 'HR');
});
function fixture() {
  const queries = []; const state = { error: null, model: 'EDSP', company: 'company' };
  const db = { from(table) {
    const call = { table, filters: [] }; queries.push(call);
    const q = Object.fromEntries(['select','eq','lte','or','order','limit'].map(method => [method, (...args) => { call.filters.push([method, ...args]); return q; }]));
    q.maybeSingle = async () => ({ error: state.error, data: { business_line: 'other', location: { company_id: state.company, model: { company_id: state.company, code: state.model } } } });
    return q;
  } };
  const mod = { exports: {} };
  const source = fs.readFileSync(new URL('./announcement-personalization-data.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mocks = { './announcement-personalization': policy, './india-date': { todayInIndia: () => '2026-10-09' } };
  new Function('require','module','exports',js)(id => { assert.ok(id in mocks); return mocks[id]; },mod,mod.exports);
  const account = { id: 'person', companyId: 'company', profileType: 'employee', workspace: 'people', designationCode: 'TL' };
  return { queries, state, account, load: (rows = [notice], actor = account) => mod.exports.personalizeNotices(db, actor, rows) };
}
test('current assignment is company/person/type/date scoped; profile changes refresh guidance without writes', async () => {
  const f = fixture(); assert.equal((await f.load())[0].body, 'Cluster Manager');
  f.state.model = 'NOW'; assert.match((await f.load())[0].body, /City/);
  assert.equal((await f.load([notice], { ...f.account, designationCode: 'CLM' }))[0].body, 'HR');
  for (const call of f.queries) for (const filter of [
    ['eq','company_id','company'], ['eq','engagement.company_id','company'], ['eq','engagement.employee_id','person'],
    ['eq','engagement.worker_type','employee'], ['eq','engagement.status','active'], ['eq','is_primary',true],
    ['lte','effective_from','2026-10-09'], ['or','effective_to.is.null,effective_to.gte.2026-10-09']
  ]) assert.ok(call.filters.some(value => JSON.stringify(value) === JSON.stringify(filter)));
});
test('contractor uses its own ID; optional lookup never runs for ordinary or Workforce notifications', async () => {
  const f = fixture(); await f.load([notice], { ...f.account, profileType: 'contractor' });
  assert.ok(f.queries[0].filters.some(value => value[1] === 'engagement.contractor_id' && value[2] === 'person'));
  f.queries.length = 0;
  await f.load([{ body: 'ordinary' }]); await f.load([notice], { ...f.account, workspace: 'workforce' });
  assert.equal(f.queries.length, 0);
  f.state.company = 'another-company'; assert.equal((await f.load())[0].body, 'HR');
});
test('both bell/dashboard and receipt-gated Updates use the same personalization', () => {
  const inbox = fs.readFileSync(new URL('../../app/api/connect/notifications/route.ts', import.meta.url), 'utf8');
  const updates = fs.readFileSync(new URL('../../app/api/connect/communication-center/route.ts', import.meta.url), 'utf8');
  assert.match(inbox, /personalizeNotices\(supabaseAdmin, account/);
  assert.match(updates, /personalizeNotices\(supabaseAdmin!, account/);
  for (const filter of ['company_id','recipient_profile_type','recipient_account_id','event_code']) assert.ok(updates.includes(`.eq("${filter}"`));
  assert.match(updates, /if \(!receipts.length\) return \[\]/);
});
