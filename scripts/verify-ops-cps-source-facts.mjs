import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

const db = new PGlite({ extensions: { btree_gist } });
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table public.companies(id uuid primary key);
  create table public.stations(id uuid primary key,company_id uuid,station_code text,region text,state text,cluster text,cluster_name text,cluster_manager_email text,ops_manager_email text,is_active boolean default true,hide_from_location_list boolean default false);
  create table public.designations(id uuid primary key,company_id uuid,code text,name text,is_active boolean,is_field_operations boolean,provider_mapping_required boolean);
  create table public.workforce(id uuid primary key,company_id uuid,dropx_id text,full_name text,location_id uuid,date_of_join date,last_working_date date,is_active boolean,deleted_at timestamptz,source_profile_type text,source_profile_id uuid,designation_id uuid,designation text);
  create table public.workforce_payment_allocations(id uuid primary key,company_id uuid,workforce_id uuid,station_id uuid,designation_id uuid,payment_method_id uuid,payment_values jsonb,payment_components jsonb,effective_from date,effective_to date,status text);
  create table public.field_executive_provider_mappings(id uuid primary key,company_id uuid,workforce_id uuid,employee_id uuid,contractor_id uuid,field_executive_id uuid,provider_id uuid,provider_member_id text,station_id uuid,effective_from date,effective_to date,status text,pay_type text,payment_method_id uuid,payment_values jsonb,delivery_rate numeric,pickup_rate numeric,mfn_rate numeric,mfn_return_rate numeric,guarantee_amount numeric,guarantee_schedule text,fuel_rate numeric);
  create table public.cps_shipment_daily(id uuid primary key,company_id uuid,client text,work_date date,station_code text,provider_employee_id text,provider_employee_name text,amazon_delivery numeric,swa_delivery numeric,total_delivery numeric,total_activity numeric,c_return numeric,mfn numeric,mfn_return numeric);
  create table public.attendance_daily(company_id uuid,workforce_id uuid,punch_date date,status text,in_time timestamptz,out_time timestamptz,work_minutes numeric);
  create table public.payment_method_components(company_id uuid,payment_method_id uuid,component_code text,component_type text,label text,pay_schedule text,payment_field_id uuid,is_active boolean);
  create table public.payment_fields(id uuid,company_id uuid,label text,pay_schedule text,calculation_type text,calculation_source text,provider_calculation_sources jsonb);
  create table public.providers(id uuid primary key,company_id uuid,code text,name text);
  create table public.org_positions(id uuid primary key,company_id uuid,location_access_mode text,location_scope_ids uuid[]);
  create table public.employees(id uuid primary key,company_id uuid,employee_code text,full_name text,email text,location_id uuid,date_of_join date,last_working_date date,is_active boolean,deleted_at timestamptz,designation_id uuid,org_position_id uuid);
  create table public.hr_employee_salary_assignments(id uuid primary key,company_id uuid,employee_id uuid,effective_from date,effective_to date);
  create table public.hr_employee_salary_values(assignment_id uuid,company_id uuid,payroll_head_id uuid,amount numeric);
  create table public.hr_payroll_heads(id uuid primary key,company_id uuid,head_type text);
  create table public.finance_rent_master(company_id uuid,allocation_station_code text,effective_from date,effective_to date,deleted_at timestamptz);
  create table public.ops_cps_cost_inputs(company_id uuid,employee_id uuid,is_active boolean,effective_from date,effective_to date,station_codes text[]);
  create unique index workforce_company_id_id_uidx on public.workforce(company_id,id);
  create unique index stations_company_id_id_uidx on public.stations(company_id,id);
  create unique index designations_company_id_id_uidx on public.designations(company_id,id);
`);

const policyMigration = (await readFile(new URL("../supabase/migrations/20260928105000_workforce_payment_policy_history.sql", import.meta.url), "utf8"))
  .replace("create extension if not exists pgcrypto;", "");
await db.exec(policyMigration);
const migration = await readFile(new URL("../supabase/migrations/20260928110000_ops_cps_direct_workforce_pay.sql", import.meta.url), "utf8");
await db.exec(migration);

const id = {
  company: "00000000-0000-0000-0000-000000000001",
  a: "00000000-0000-0000-0000-00000000000a",
  b: "00000000-0000-0000-0000-00000000000b",
  c: "00000000-0000-0000-0000-00000000000c",
  direct: "00000000-0000-0000-0000-000000000101",
  mapped: "00000000-0000-0000-0000-000000000102",
  other: "00000000-0000-0000-0000-000000000103",
  transferred: "00000000-0000-0000-0000-000000000104",
  missingTransferred: "00000000-0000-0000-0000-000000000105",
  employee: "00000000-0000-0000-0000-000000000106",
  designation: "00000000-0000-0000-0000-000000000201",
  method: "00000000-0000-0000-0000-000000000301",
  provider: "00000000-0000-0000-0000-000000000401",
};
await db.exec(`
  insert into public.companies values ('${id.company}');
  insert into public.stations(id,company_id,station_code,state) values
    ('${id.a}','${id.company}','A','KL'),('${id.b}','${id.company}','B','KL'),('${id.c}','${id.company}','C','TN');
  insert into public.designations values ('${id.designation}','${id.company}','VAN','Van driver',true,true,false);
  insert into public.employees(id,company_id,employee_code,full_name,location_id,is_active,designation_id)
    values ('${id.employee}','${id.company}','E1','Employee-backed direct','${id.b}',true,'${id.designation}');
  insert into public.workforce(id,company_id,dropx_id,full_name,location_id,is_active,designation_id,source_profile_type,source_profile_id) values
    ('${id.direct}','${id.company}','D1','Historical direct','${id.a}',true,'${id.designation}','employee','${id.employee}'),
    ('${id.mapped}','${id.company}','D2','Mapped across stations','${id.c}',true,'${id.designation}',null,null),
    ('${id.other}','${id.company}','D3','Unrelated','${id.c}',true,'${id.designation}',null,null),
    ('${id.transferred}','${id.company}','D4','Transferred into A','${id.a}',true,'${id.designation}',null,null),
    ('${id.missingTransferred}','${id.company}','D5','Missing allocation before transfer','${id.b}',true,'${id.designation}',null,null);
  insert into public.workforce_payment_allocations values
    ('10000000-0000-0000-0000-000000000001','${id.company}','${id.direct}','${id.a}','${id.designation}','${id.method}','{"DAILY":700}','[]','2026-01-01','2026-09-01','closed'),
    ('10000000-0000-0000-0000-000000000002','${id.company}','${id.other}','${id.c}','${id.designation}','${id.method}','{"DAILY":700}','[]','2026-01-01',null,'active'),
    ('10000000-0000-0000-0000-000000000003','${id.company}','${id.transferred}','${id.b}','${id.designation}','${id.method}','{"DAILY":800}','[]','2026-01-01','2026-09-01','closed');
  insert into public.attendance_daily values
    ('${id.company}','${id.direct}','2026-09-01','P',null,null,480),
    ('${id.company}','${id.other}','2026-09-01','P',null,null,480),
    ('${id.company}','${id.transferred}','2026-09-01','P',null,null,480);
  insert into public.providers values ('${id.provider}','${id.company}','AMAZON','Amazon');
  insert into public.field_executive_provider_mappings(id,company_id,workforce_id,provider_id,provider_member_id,station_id,effective_from,status,payment_method_id,payment_values) values
    ('20000000-0000-0000-0000-000000000001','${id.company}','${id.mapped}','${id.provider}','AM2','${id.a}','2026-01-01','active','${id.method}','{"DELIVERY":10}'),
    ('20000000-0000-0000-0000-000000000002','${id.company}','${id.mapped}','${id.provider}','AM2','${id.b}','2026-01-01','active','${id.method}','{"DELIVERY":10}');
  insert into public.cps_shipment_daily(id,company_id,client,work_date,station_code,provider_employee_id,total_delivery,total_activity) values
    ('30000000-0000-0000-0000-000000000001','${id.company}','Amazon','2026-09-01','A','AM2',100,100),
    ('30000000-0000-0000-0000-000000000002','${id.company}','Amazon','2026-09-01','B','AM2',300,300),
    ('30000000-0000-0000-0000-000000000003','${id.company}','Amazon','2026-09-01','C','OTHER',900,900);
`);

// Record the truthful historical B assignment, then move the worker to A today.
// An old-station rebuild must still discover the worker from policy history, and
// an A rebuild must receive the B snapshot rather than inventing an A gap.
await db.query(`select public.capture_workforce_payment_policy('${id.missingTransferred}','2026-09-01','${id.designation}','test_historical_station')`);
await db.exec(`update public.workforce set location_id='${id.a}' where id='${id.missingTransferred}'`);
await db.query(`select public.capture_workforce_payment_policy('${id.direct}','2026-09-01','${id.designation}','test_employee_historical_station')`);
await db.exec(`update public.workforce set location_id='${id.b}' where id='${id.direct}'`);

const { rows } = await db.query(`select public.ops_cps_source_facts('${id.company}','2026-09-01','2026-09-01',array['A']) facts`);
const facts = rows[0].facts;
assert.deepEqual(new Set(facts.allocations.map((row) => row.workforce_id)), new Set([id.direct, id.transferred]), "all effective allocations for scoped workforce must load regardless of allocation station");
assert.deepEqual(new Set(facts.attendance.map((row) => row.workforce_id)), new Set([id.direct, id.transferred]), "all attendance for scoped workforce must load regardless of allocation station");
assert.deepEqual(new Set(facts.workforce.map((row) => row.id)), new Set([id.direct, id.mapped, id.transferred]), "current location must not override an effective historical station, and unrelated workforce must not materialize");
assert.deepEqual(new Set(facts.shipments.map((row) => row.station_code)), new Set(["A", "B"]), "only selected rows plus the relevant worker's cross-station denominator should load");
assert.ok(!facts.shipments.some((row) => row.station_code === "C"), "unrelated company-wide shipment rows must not load");
assert.deepEqual(new Set(facts.stations.map((row) => row.station_code)), new Set(["A", "B"]));
assert.deepEqual(new Set(facts.policy_history.map((row) => row.workforce_id)), new Set([id.direct]), "A scope must use dated ownership and exclude the historical B owner");
assert.ok(facts.employees.some((row) => row.id === id.employee), "old-station scope must include the employee whose CTC replaces direct salary");

const oldStationResult = await db.query(`select public.ops_cps_source_facts('${id.company}','2026-09-01','2026-09-01',array['B']) facts`);
const oldStationFacts = oldStationResult.rows[0].facts;
assert.ok(oldStationFacts.workforce.some((row) => row.id === id.missingTransferred), "historical station ownership must pull a transferred worker into the old-station scope");
const historicalPolicy = oldStationFacts.policy_history.find((row) => row.workforce_id === id.missingTransferred);
assert.equal(historicalPolicy?.station_id, id.b);
assert.equal(historicalPolicy?.station_code_snapshot, "B");
assert.equal(historicalPolicy?.designation_is_active, true);
assert.ok(!oldStationFacts.workforce.some((row) => row.id === id.direct), "current Workforce location B must not override the dated A assignment");
assert.ok(!oldStationFacts.employees.some((row) => row.id === id.employee), "current employee home B must not reintroduce CTC after dated Workforce ownership moved it to A");
console.log("ops_cps_source_facts station scope: PASS");

await db.close();
