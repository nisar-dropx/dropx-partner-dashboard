import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const ids = {
  company: "00000000-0000-0000-0000-000000000001",
  station: "00000000-0000-0000-0000-000000000002",
  role: "00000000-0000-0000-0000-000000000003",
  oldPerson: "00000000-0000-0000-0000-000000000004",
  newPerson: "00000000-0000-0000-0000-000000000005",
  oldUser: "00000000-0000-0000-0000-000000000006",
  newUser: "00000000-0000-0000-0000-000000000007",
  oldEngagement: "00000000-0000-0000-0000-000000000008",
  newEngagement: "00000000-0000-0000-0000-000000000009",
  oldAssignment: "00000000-0000-0000-0000-000000000010",
  newAssignment: "00000000-0000-0000-0000-000000000011",
  localEngagement: "00000000-0000-0000-0000-000000000012",
  localPerson: "00000000-0000-0000-0000-000000000013",
  localAssignment: "00000000-0000-0000-0000-000000000014",
  clmDesignation: "00000000-0000-0000-0000-000000000015",
  tlDesignation: "00000000-0000-0000-0000-000000000016",
  localUser: "00000000-0000-0000-0000-000000000017",
  areaPerson: "00000000-0000-0000-0000-000000000018",
  areaUser: "00000000-0000-0000-0000-000000000019",
  areaEngagement: "00000000-0000-0000-0000-000000000020",
  areaAssignment: "00000000-0000-0000-0000-000000000021",
  aomDesignation: "00000000-0000-0000-0000-000000000022",
  hlmDesignation: "00000000-0000-0000-0000-000000000023",
  hlmPerson: "00000000-0000-0000-0000-000000000024",
  hlmUser: "00000000-0000-0000-0000-000000000025",
  hlmEngagement: "00000000-0000-0000-0000-000000000026",
  hlmAssignment: "00000000-0000-0000-0000-000000000027",
  clmTwoPerson: "00000000-0000-0000-0000-000000000028",
  clmTwoUser: "00000000-0000-0000-0000-000000000029",
  clmTwoEngagement: "00000000-0000-0000-0000-000000000030",
  clmTwoAssignment: "00000000-0000-0000-0000-000000000031",
};

const products = ["operations", "finance", "recruit", "workforce"];

await db.exec(`
create table stations(id uuid primary key,company_id uuid not null,station_code text,is_active boolean not null default true);
create table station_responsibility_roles(id uuid primary key,company_id uuid not null,code text,owning_product_code text,is_active boolean,escalation_order int);
create table hr_people(id uuid primary key,company_id uuid not null,display_name text,status text);
create table hr_engagements(id uuid primary key,company_id uuid not null,person_id uuid,status text,start_date date,end_date date);
create table designations(id uuid primary key,company_id uuid not null,code text,name text,is_active boolean not null default true);
create table hr_work_assignments(id uuid primary key,company_id uuid not null,engagement_id uuid,designation_id uuid,location_id uuid,is_primary boolean,effective_from date,effective_to date);
create table hr_user_person_links(id uuid primary key default gen_random_uuid(),company_id uuid not null,person_id uuid,user_id uuid,status text);
create table profiles(id uuid primary key,company_id uuid not null,email text,is_active boolean,location_scope_ids uuid[] not null default '{}',reports_to_user_id uuid,updated_at timestamptz default now());
create table company_product_memberships(id uuid primary key default gen_random_uuid(),company_id uuid not null,user_id uuid not null,product_code text not null,source_system text,is_active boolean not null default true,location_scope_ids uuid[] not null default '{}',has_all_location_access boolean not null default false,updated_at timestamptz default now());
create table people_person_access_scopes(id uuid primary key default gen_random_uuid(),company_id uuid not null,person_id uuid,location_scope_ids uuid[],has_all_location_access boolean);
create table station_responsibility_assignments(id uuid primary key default gen_random_uuid(),company_id uuid not null,station_id uuid,responsibility_role_id uuid,responsibility_code text,assignee_user_id uuid,assignee_email text,assignment_id uuid,business_line text,is_primary boolean,effective_from timestamptz,effective_to timestamptz,created_at timestamptz default now(),updated_at timestamptz default now());
create table hr_reporting_relationships(id uuid primary key default gen_random_uuid(),company_id uuid not null,subject_assignment_id uuid,manager_assignment_id uuid,relationship_type text,is_primary boolean,effective_from date,effective_to date,created_at timestamptz default now(),updated_at timestamptz default now());

insert into stations values ('${ids.station}','${ids.company}','KGQE',true);
insert into station_responsibility_roles values ('${ids.role}','${ids.company}','station_manager','operations',true,400);
insert into designations values
 ('${ids.clmDesignation}','${ids.company}','CLM','Cluster Manager',true),
 ('${ids.aomDesignation}','${ids.company}','AOM','Area Operations Manager',true),
 ('${ids.tlDesignation}','${ids.company}','TL','Team Lead',true),
 ('${ids.hlmDesignation}','${ids.company}','HLM','Head Operations- Last Mile',true);
insert into hr_people values
 ('${ids.oldPerson}','${ids.company}','FORMER CLM','active'),
 ('${ids.newPerson}','${ids.company}','CURRENT CLM','active'),
 ('${ids.areaPerson}','${ids.company}','AREA MANAGER','active'),
 ('${ids.localPerson}','${ids.company}','LOCAL TL','active'),
 ('${ids.hlmPerson}','${ids.company}','HEAD OPS','active'),
 ('${ids.clmTwoPerson}','${ids.company}','SECOND CLM','active');
insert into hr_engagements values
 ('${ids.oldEngagement}','${ids.company}','${ids.oldPerson}','active','2020-01-01',null),
 ('${ids.newEngagement}','${ids.company}','${ids.newPerson}','active','2020-01-01',null),
 ('${ids.areaEngagement}','${ids.company}','${ids.areaPerson}','active','2020-01-01',null),
 ('${ids.localEngagement}','${ids.company}','${ids.localPerson}','active','2020-01-01',null),
 ('${ids.hlmEngagement}','${ids.company}','${ids.hlmPerson}','active','2020-01-01',null),
 ('${ids.clmTwoEngagement}','${ids.company}','${ids.clmTwoPerson}','active','2020-01-01',null);
insert into hr_work_assignments values
 ('${ids.oldAssignment}','${ids.company}','${ids.oldEngagement}','${ids.clmDesignation}',null,true,'2020-01-01',null),
 ('${ids.newAssignment}','${ids.company}','${ids.newEngagement}','${ids.clmDesignation}',null,true,'2020-01-01',null),
 ('${ids.areaAssignment}','${ids.company}','${ids.areaEngagement}','${ids.aomDesignation}',null,true,'2020-01-01',null),
 ('${ids.localAssignment}','${ids.company}','${ids.localEngagement}','${ids.tlDesignation}','${ids.station}',true,'2020-01-01',null),
 ('${ids.hlmAssignment}','${ids.company}','${ids.hlmEngagement}','${ids.hlmDesignation}',null,true,'2020-01-01',null),
 ('${ids.clmTwoAssignment}','${ids.company}','${ids.clmTwoEngagement}','${ids.clmDesignation}',null,true,'2020-01-01',null);
insert into profiles(id,company_id,email,is_active,location_scope_ids,reports_to_user_id) values
 ('${ids.oldUser}','${ids.company}','former@example.com',true,array['${ids.station}'::uuid],null),
 ('${ids.newUser}','${ids.company}','current@example.com',true,'{}',null),
 ('${ids.areaUser}','${ids.company}','area@example.com',true,'{}',null),
 ('${ids.localUser}','${ids.company}','kgqe@example.com',true,array['${ids.station}'::uuid],'${ids.oldUser}'),
 ('${ids.hlmUser}','${ids.company}','headops@example.com',true,array['${ids.station}'::uuid],null),
 ('${ids.clmTwoUser}','${ids.company}','second@example.com',true,'{}',null);
insert into hr_user_person_links(company_id,person_id,user_id,status) values
 ('${ids.company}','${ids.oldPerson}','${ids.oldUser}','active'),
 ('${ids.company}','${ids.newPerson}','${ids.newUser}','active'),
 ('${ids.company}','${ids.areaPerson}','${ids.areaUser}','active'),
 ('${ids.company}','${ids.localPerson}','${ids.localUser}','active'),
 ('${ids.company}','${ids.hlmPerson}','${ids.hlmUser}','active'),
 ('${ids.company}','${ids.clmTwoPerson}','${ids.clmTwoUser}','active');
insert into people_person_access_scopes(company_id,person_id,location_scope_ids,has_all_location_access) values
 ('${ids.company}','${ids.oldPerson}','{}',false),
 ('${ids.company}','${ids.newPerson}',array['${ids.station}'::uuid],false),
 ('${ids.company}','${ids.areaPerson}',array['${ids.station}'::uuid],false),
 ('${ids.company}','${ids.hlmPerson}',array['${ids.station}'::uuid],false);
insert into company_product_memberships(company_id,user_id,product_code,source_system,is_active,location_scope_ids,has_all_location_access)
select '${ids.company}', '${ids.oldUser}', product, 'designation_policy', true, array['${ids.station}'::uuid], false
from unnest(array['operations','finance','recruit','workforce']) product;
insert into company_product_memberships(company_id,user_id,product_code,source_system,is_active,location_scope_ids,has_all_location_access)
select '${ids.company}', '${ids.newUser}', product, 'designation_policy', true, '{}', false
from unnest(array['operations','finance','recruit','workforce']) product;
insert into company_product_memberships(company_id,user_id,product_code,source_system,is_active,location_scope_ids,has_all_location_access)
select '${ids.company}', '${ids.areaUser}', product, 'designation_policy', true, '{}', false
from unnest(array['operations','finance','recruit','workforce']) product;
insert into company_product_memberships(company_id,user_id,product_code,source_system,is_active,location_scope_ids,has_all_location_access)
values ('${ids.company}','${ids.newUser}','special','manual',true,'{}',false);
insert into station_responsibility_assignments(company_id,station_id,responsibility_role_id,responsibility_code,assignee_user_id,assignee_email,assignment_id,business_line,is_primary,effective_from)
 values ('${ids.company}','${ids.station}','${ids.role}','station_manager','${ids.oldUser}','former@example.com','${ids.oldAssignment}','other',true,now()-interval '1 day');
insert into hr_reporting_relationships(company_id,subject_assignment_id,manager_assignment_id,relationship_type,is_primary,effective_from)
 values ('${ids.company}','${ids.localAssignment}','${ids.oldAssignment}','solid_line',true,current_date-1);
`);

const readMigration = (name) =>
  readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8").replace(/^\uFEFF/, "");
await db.exec(readMigration("20261024170000_sync_people_station_routing.sql"));
await db.exec(readMigration("20261028180000_fix_cm_city_vs_clm_cluster.sql"));
await db.exec(readMigration("20261028193000_ops_reconcile_preserve_company_reporting.sql"));
const preserveManualPoc = readMigration("20261029191000_preserve_manual_station_poc_when_no_clm.sql");
await db.exec(preserveManualPoc);
await db.exec(preserveManualPoc);

async function currentOwner() {
  const result = await db.query(`select assignment_id from station_responsibility_assignments where is_primary=true order by created_at desc,id desc`);
  return result.rows.map((row) => row.assignment_id);
}

async function currentManager() {
  const result = await db.query(`select manager_assignment_id from hr_reporting_relationships where is_primary=true order by created_at desc,id desc`);
  return result.rows.map((row) => row.manager_assignment_id);
}

async function profile(userId) {
  const result = await db.query(`select location_scope_ids,reports_to_user_id from profiles where id=$1`, [userId]);
  return result.rows[0];
}

async function generatedMemberships(userId) {
  const result = await db.query(`select product_code,location_scope_ids,has_all_location_access from company_product_memberships where user_id=$1 and source_system='designation_policy' order by product_code`, [userId]);
  return result.rows;
}

assert.deepEqual(await currentOwner(), [ids.newAssignment]);
assert.deepEqual(await currentManager(), [ids.newAssignment]);
assert.deepEqual((await profile(ids.oldUser)).location_scope_ids, []);
assert.deepEqual((await profile(ids.newUser)).location_scope_ids, [ids.station]);
assert.equal((await profile(ids.localUser)).reports_to_user_id, ids.newUser);
for (const userId of [ids.oldUser, ids.newUser, ids.areaUser]) {
  const expectedScope = userId === ids.oldUser ? [] : [ids.station];
  const memberships = await generatedMemberships(userId);
  assert.deepEqual(memberships.map((row) => row.product_code), [...products].sort());
  for (const membership of memberships) {
    assert.deepEqual(membership.location_scope_ids, expectedScope);
    assert.equal(membership.has_all_location_access, false);
  }
}
const manualBefore = await db.query(`select location_scope_ids from company_product_memberships where user_id=$1 and source_system='manual'`, [ids.newUser]);
assert.deepEqual(manualBefore.rows[0].location_scope_ids, []);

// A normal People transfer must immediately move every generated portal scope,
// operational owner, current approval route and legacy reporting mirror.
await db.exec(`
update people_person_access_scopes set location_scope_ids=array['${ids.station}'::uuid] where person_id='${ids.oldPerson}';
update people_person_access_scopes set location_scope_ids='{}' where person_id='${ids.newPerson}';
`);
assert.deepEqual(await currentOwner(), [ids.oldAssignment]);
assert.deepEqual(await currentManager(), [ids.oldAssignment]);
assert.equal((await profile(ids.localUser)).reports_to_user_id, ids.oldUser);
for (const membership of await generatedMemberships(ids.oldUser)) assert.deepEqual(membership.location_scope_ids, [ids.station]);
for (const membership of await generatedMemberships(ids.newUser)) assert.deepEqual(membership.location_scope_ids, []);

// Removing the People scope must revoke the former manager everywhere and use
// the configured AOM fallback instead of leaving the former CLM assigned.
await db.exec(`delete from people_person_access_scopes where person_id='${ids.oldPerson}'`);
assert.deepEqual(await currentOwner(), [ids.areaAssignment]);
assert.deepEqual(await currentManager(), [ids.areaAssignment]);
assert.equal((await profile(ids.localUser)).reports_to_user_id, ids.areaUser);
assert.deepEqual((await profile(ids.oldUser)).location_scope_ids, []);
for (const membership of await generatedMemberships(ids.oldUser)) assert.deepEqual(membership.location_scope_ids, []);

// All-location access is also People-owned and must reach every generated
// membership while the legacy profile intentionally uses an empty scope array.
await db.exec(`update people_person_access_scopes set has_all_location_access=true,location_scope_ids='{}' where person_id='${ids.newPerson}'`);
assert.deepEqual(await currentOwner(), [ids.newAssignment]);
assert.deepEqual(await currentManager(), [ids.newAssignment]);
for (const membership of await generatedMemberships(ids.newUser)) {
  assert.deepEqual(membership.location_scope_ids, []);
  assert.equal(membership.has_all_location_access, true);
}

// Offboarding or deactivating the mapped CLM must fall back to the current AOM
// without needing a second manual edit in Finance, OpsPulse or Recruit.
await db.exec(`update hr_engagements set status='inactive',end_date=current_date where id='${ids.newEngagement}'`);
assert.deepEqual(await currentOwner(), [ids.areaAssignment]);
assert.deepEqual(await currentManager(), [ids.areaAssignment]);
assert.equal((await profile(ids.localUser)).reports_to_user_id, ids.areaUser);

// When no current CLM or AOM remains, stale synced CLM/AOM Ops POCs are cleared.
// Company reporting lines stay owned by People Tree (not wiped by Ops reconcile).
await db.exec(`delete from people_person_access_scopes where person_id='${ids.areaPerson}'`);
assert.deepEqual(await currentOwner(), []);
assert.deepEqual(await currentManager(), [ids.areaAssignment]);

const manualAfter = await db.query(`select location_scope_ids,has_all_location_access from company_product_memberships where user_id=$1 and source_system='manual'`, [ids.newUser]);
assert.deepEqual(manualAfter.rows, [{ location_scope_ids: [], has_all_location_access: false }]);

// Manual Head Ops (HLM) POC must survive empty preferred CLM/AOM, including a
// double-applied reconcile — HO stations are intentionally outside CLM sync.
await db.exec(`
insert into station_responsibility_assignments(company_id,station_id,responsibility_role_id,responsibility_code,assignee_user_id,assignee_email,assignment_id,business_line,is_primary,effective_from)
 values ('${ids.company}','${ids.station}','${ids.role}','station_manager','${ids.hlmUser}','headops@example.com','${ids.hlmAssignment}','other',true,now());
select public.reconcile_people_operational_routing('${ids.company}'::uuid, array['${ids.station}'::uuid]);
`);
assert.deepEqual(await currentOwner(), [ids.hlmAssignment]);

// Ambiguous CLM ownership still clears the Ops POC (including a manual HLM).
await db.exec(`
insert into people_person_access_scopes(company_id,person_id,location_scope_ids,has_all_location_access) values
 ('${ids.company}','${ids.oldPerson}',array['${ids.station}'::uuid],false),
 ('${ids.company}','${ids.clmTwoPerson}',array['${ids.station}'::uuid],false);
update hr_engagements set status='active',end_date=null where id='${ids.oldEngagement}';
insert into hr_user_person_links(company_id,person_id,user_id,status)
select '${ids.company}','${ids.clmTwoPerson}','${ids.clmTwoUser}','active'
where not exists (
  select 1 from hr_user_person_links where person_id='${ids.clmTwoPerson}' and user_id='${ids.clmTwoUser}'
);
insert into company_product_memberships(company_id,user_id,product_code,source_system,is_active,location_scope_ids,has_all_location_access)
select '${ids.company}', '${ids.clmTwoUser}', product, 'designation_policy', true, array['${ids.station}'::uuid], false
from unnest(array['operations','finance','recruit','workforce']) product
where not exists (
  select 1 from company_product_memberships
  where user_id='${ids.clmTwoUser}' and product_code=product and source_system='designation_policy'
);
`);
assert.deepEqual(await currentOwner(), []);

// Unique CLM still replaces / owns the station after ambiguity is resolved.
await db.exec(`delete from people_person_access_scopes where person_id='${ids.clmTwoPerson}'`);
assert.deepEqual(await currentOwner(), [ids.oldAssignment]);

console.log("PASS People station routing synchronizes scopes, ownership, reporting, removals, offboarding, manual HLM preserve and ambiguous clear");
await db.close();
