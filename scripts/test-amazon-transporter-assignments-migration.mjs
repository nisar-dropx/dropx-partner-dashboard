import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import assert from "node:assert/strict";

const db = new PGlite();
await db.exec(`create role anon;create role authenticated;create role service_role;
create or replace function gen_random_uuid() returns uuid language sql as $$ select 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid $$;
create table companies(id uuid primary key);
create table stations(id uuid primary key,company_id uuid,station_code text,amazon_service_area_id text,latitude double precision,longitude double precision);
create table workforce(id uuid primary key,company_id uuid,date_of_join date,last_working_date date);
create table field_executive_provider_mappings(id uuid primary key,company_id uuid,workforce_id uuid,station_id uuid,payment_method_id uuid,status text,effective_from date,effective_to date,payment_values jsonb,provider_member_id text);
create table payment_fields(id uuid primary key,code text);
create table payment_method_components(payment_method_id uuid,payment_field_id uuid,is_active boolean,component_code text);
create table workforce_amazon_portal_links(company_id uuid,workforce_id uuid,transporter_id text);
create table workforce_payout_publications(company_id uuid,workforce_id uuid,period_start date,period_end date);
create table revisions(company_id uuid,work_date date);
create table amazon_portal_credentials(account_key text,default_station_code text);
create function lock_workforce_payment_allocation_company(uuid) returns void language sql as 'select';
create function workforce_bump_payout_period_dependency_revision(uuid,date) returns void language sql as 'insert into public.revisions values($1,$2)';
insert into companies values('43866344-b550-4e8a-9a2d-9d23f3d8a997');`);

await db.exec(fs.readFileSync("supabase/migrations/20261013210000_workforce_route_distance.sql", "utf8"));
await db.exec(fs.readFileSync("supabase/migrations/20261014001500_route_scc_identity.sql", "utf8"));
await db.exec(fs.readFileSync("supabase/migrations/20261014034000_route_scc_company_fallback.sql", "utf8"));
await db.exec(fs.readFileSync("supabase/migrations/20261103120000_amazon_transporter_assignments.sql", "utf8"));

const c = "43866344-b550-4e8a-9a2d-9d23f3d8a997";
const w1 = "11111111-1111-4111-8111-111111111111";
const w2 = "55555555-5555-4555-8555-555555555555";
const s = "22222222-2222-4222-8222-222222222222";
const m1 = "33333333-3333-4333-8333-333333333333";
const m2 = "66666666-6666-4666-8666-666666666666";
const f = "44444444-4444-4444-8444-444444444444";

await db.exec(`
insert into stations values('${s}','${c}','TEST','area',12,77);
insert into workforce values('${w1}','${c}','2026-10-01',null),('${w2}','${c}','2026-10-01',null);
insert into field_executive_provider_mappings values
 ('${m1}','${c}','${w1}','${s}','${f}','active','2026-10-01',null,'{"KM_RUN":3}','200001'),
 ('${m2}','${c}','${w2}','${s}','${f}','active','2026-10-01',null,'{"KM_RUN":3}','200002');
insert into payment_fields values('${f}','KM_RUN');
insert into payment_method_components values('${f}','${f}',true,'KM_RUN');
update workforce_route_distance_settings set enabled=true;
insert into workforce_route_distance_stations values('${c}','${s}',12,77);
`);

const target = async (date, workforce = null) => {
  const rows = (
    await db.query("select * from workforce_route_distance_targets_v2($1,$2,$3)", [c, date, s])
  ).rows;
  return workforce ? rows.find((r) => r.workforce_id === workforce) : rows;
};

assert.equal((await target("2026-10-05", w1)).identity_reason, "amazon_identity_missing");

await db.exec(`
insert into workforce_amazon_transporter_assignments
 (company_id,station_id,workforce_id,transporter_id,effective_from,effective_to)
 values
 ('${c}','${s}','${w1}','A111111','2026-10-01','2026-10-10'),
 ('${c}','${s}','${w2}','A111111','2026-10-11','2026-10-20');
`);

const aOct5 = await target("2026-10-05", w1);
assert.equal(aOct5.transporter_id, "A111111");
assert.equal(aOct5.identity_source, "manual_assignment");
assert.equal((await target("2026-10-05", w2)).identity_reason, "amazon_identity_missing");

const bOct15 = await target("2026-10-15", w2);
assert.equal(bOct15.transporter_id, "A111111");
assert.equal(bOct15.identity_source, "manual_assignment");
assert.equal((await target("2026-10-15", w1)).identity_reason, "amazon_identity_missing");

// Same ID overlapping same day → driver_count conflict
await db.exec(`
insert into workforce_amazon_transporter_assignments
 (company_id,station_id,workforce_id,transporter_id,effective_from,effective_to)
 values ('${c}','${s}','${w1}','A111111','2026-10-15','2026-10-15');
`);
assert.equal((await target("2026-10-15", w1)).identity_reason, "amazon_identity_conflict");
assert.equal((await target("2026-10-15", w2)).identity_reason, "amazon_identity_conflict");

console.log("test-amazon-transporter-assignments-migration.mjs: ok");
