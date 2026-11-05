import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
import { reportBotWorkspace, reportBotPage, reportBotHref, reportBotChatHref, reportBotSetupHref } from './workspace.ts';
import { canAccessLastMileReportBot } from '../ops-pulse/last-mile-report-bot-access.ts';

const require = createRequire(import.meta.url);
const workspaceModule = { reportBotWorkspace, reportBotPage, reportBotHref, reportBotChatHref, reportBotSetupHref };
const accessModule = { exports: {} };
let currentAuth;
const hasPermission = (auth, code, action) => Boolean(auth.permissions[code]?.[action === 'edit' ? 'canEdit' : 'canView']);
new Function('require', 'module', 'exports', ts.transpileModule(readFileSync(new URL('./access.ts', import.meta.url),'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(name => {
  if (name === 'server-only') return {};
  if (name === './workspace') return workspaceModule;
  if (name === '@/lib/authorization') return { hasPermission, getAuthorization: async () => currentAuth };
  if (name === '@/lib/ops-pulse/last-mile-report-bot-access') return { canAccessLastMileReportBot };
  return require(name);
}, accessModule, accessModule.exports);
const { canSeeGroup, reportBotApiAuthorization } = accessModule.exports;
const auth = (page, all = true, email = 'tech@dropxlogistics.com') => ({ companyId:'company', email, permissions: { [page]: {canView:true,canEdit:true} }, hasAllLocationAccess:all, locationScopeIds:['station-a'] });

test('workspace routes default old links to Dark Store, preserve Last Mile links and reject unknown scopes', () => {
  assert.equal(reportBotWorkspace(undefined), 'dark_store');
  assert.equal(reportBotWorkspace('last_mile'), 'last_mile');
  assert.throws(() => reportBotWorkspace('all'), /Invalid/);
  assert.equal(reportBotPage('last_mile'), 'ops_lm_report_bot');
  assert.equal(reportBotSetupHref('last_mile'), '/report-bot/setup?workspace=last_mile');
  assert.match(reportBotHref('last_mile','groups'), /workspace=last_mile&tab=groups/);
  assert.match(reportBotChatHref('last_mile','a'), /workspace=last_mile&group=a/);
});

test('all-location access alone never grants bot access; scope, page grants and LM allowlist are all required', async () => {
  const lm = {location_id:'station-a',workspace:'last_mile'};
  const ds = {location_id:'station-a',workspace:'dark_store'};
  assert.equal(canSeeGroup(auth('ops_report_bot'), lm), false);
  assert.equal(canSeeGroup(auth('ops_lm_report_bot'), ds), false);
  assert.equal(canSeeGroup(auth('ops_pulse'), lm), false);
  assert.equal(canSeeGroup(auth('ops_lm_report_bot',false), lm), true);
  assert.equal(canSeeGroup(auth('ops_lm_report_bot',false,'other@dropxlogistics.com'), lm), false,'Last Mile stays Joseph-only even with page permission');
  assert.equal(canSeeGroup(auth('ops_lm_report_bot',false), {...lm,location_id:'station-b'}), false);
  assert.equal(canSeeGroup(auth('ops_lm_report_bot',false), {...lm,location_id:null}), false);
  const both = {...auth('ops_lm_report_bot'),permissions:{...auth('ops_lm_report_bot').permissions,...auth('ops_report_bot').permissions},reportBotWorkspace:'last_mile'};
  assert.equal(canSeeGroup(both, ds),false,'a DS resource cannot be mutated through the LM form, even by a dual-workspace editor');
  currentAuth=auth('ops_lm_report_bot');
  assert.equal(await reportBotApiAuthorization('access'),null);
  assert.equal(await reportBotApiAuthorization('edit','last_mile'),currentAuth);
  currentAuth=auth('ops_report_bot');
  assert.equal(await reportBotApiAuthorization('edit','last_mile'),null,'Dark Store access cannot authorize Last Mile session requests');
  currentAuth=auth('ops_lm_report_bot',true,'other@dropxlogistics.com');
  assert.equal(await reportBotApiAuthorization('edit','last_mile'),null,'allowlist blocks Last Mile session requests without Joseph access');
  currentAuth=auth('ops_lm_report_bot');
  currentAuth.permissions.ops_lm_report_bot.canEdit=false;
  assert.equal(await reportBotApiAuthorization('edit','last_mile'),null,'permission changes apply without a hardcoded role bypass');
});

const migration = readFileSync(new URL('../../../supabase/migrations/20261103123655_report_bot_last_mile_workspace.sql', import.meta.url),'utf8');
const company='43866344-b550-4e8a-9a2d-9d23f3d8a997';
test('migration preserves DS, enforces company/workspace schedule isolation, shares session and seeds only specified roles', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create table stations(id uuid primary key,company_id uuid);
      create table app_pages(id uuid primary key default gen_random_uuid(),company_id uuid,code text,name text,sort_order int,is_active boolean,unique(company_id,code));
      create table user_roles(id uuid primary key default gen_random_uuid(),company_id uuid,code text);
      create table role_page_permissions(company_id uuid,role_id uuid,page_id uuid,can_view boolean,can_add boolean,can_edit boolean,unique(company_id,role_id,page_id));`);
    await db.exec(readFileSync(new URL('../../../supabase/migrations/20261015190000_report_bot.sql',import.meta.url),'utf8'));
    await db.exec(readFileSync(new URL('../../../supabase/migrations/20261021150000_report_bot_tcc3_pilot.sql',import.meta.url),'utf8'));
    await db.query('insert into report_bot_settings(company_id) values ($1)',[company]);
    const dsGroup=(await db.query("insert into report_bot_groups(company_id,wa_group_id) values ($1,'123@g.us') returning id",[company])).rows[0].id;
    const dsType=(await db.query("insert into report_bot_report_types(company_id,name,slug,rules) values ($1,'Daily','daily','{a}') returning id",[company])).rows[0].id;
    const allowed=['OPERATIONS_FSD','OPERATIONS_FINMGR','OPERATIONS_NH','OPERATIONS_MANAGING_PARTNER','OPERATIONS_HLM'];
    for (const code of [...allowed,'OPERATIONS_CM','OPERATIONS_SLPM','OPERATIONS_HRM']) await db.query('insert into user_roles(company_id,code) values ($1,$2)',[company,code]);
    await db.exec(migration);
    assert.equal((await db.query('select workspace from report_bot_groups where id=$1',[dsGroup])).rows[0].workspace,'dark_store');
    const lmGroup=(await db.query("insert into report_bot_groups(company_id,wa_group_id,workspace) values ($1,'456@g.us','last_mile') returning id,mode",[company])).rows[0];
    assert.equal(lmGroup.mode,'observe');
    const lmType=(await db.query("insert into report_bot_report_types(company_id,name,slug,rules,workspace) values ($1,'Daily','daily','{b}','last_mile') returning id",[company])).rows[0].id;
    await db.query("insert into report_bot_schedules(company_id,group_id,report_type_id,due_time) values ($1,$2,$3,'10:00')",[company,lmGroup.id,lmType]);
    await assert.rejects(db.query("insert into report_bot_schedules(company_id,group_id,report_type_id,due_time) values ($1,$2,$3,'10:00')",[company,lmGroup.id,dsType]),/same company and workspace/);
    await assert.rejects(db.query("insert into report_bot_schedules(company_id,group_id,report_type_id,due_time) values ('aaaaaaaa-0000-0000-0000-000000000001',$1,$2,'10:00')",[lmGroup.id,lmType]),/same company and workspace/);
    await assert.rejects(db.query("update report_bot_groups set workspace='last_mile' where id=$1",[dsGroup]),/ownership cannot/);
    await assert.rejects(db.query("insert into report_bot_groups(company_id,wa_group_id,workspace) values ($1,'123@g.us','last_mile') on conflict(company_id,wa_group_id) do update set workspace=excluded.workspace",[company]),/ownership cannot/);
    assert.equal((await db.query('select count(*)::int n from report_bot_settings')).rows[0].n,1,'one existing shared WhatsApp connection');
    const granted=(await db.query('select r.code from role_page_permissions p join user_roles r on r.id=p.role_id where can_view')).rows.map(r=>r.code).sort();
    assert.deepEqual(granted,allowed.sort());
    await db.exec('update role_page_permissions set can_view=false,can_add=false,can_edit=false');
    await db.exec(migration);
    assert.equal((await db.query('select count(*)::int n from role_page_permissions where can_view')).rows[0].n,0,'rerunning migration must preserve configured revocations');
    await db.exec('set role authenticated');
    await assert.rejects(db.query('select * from report_bot_groups'),/permission denied/);
  } finally { await db.close(); }
});
