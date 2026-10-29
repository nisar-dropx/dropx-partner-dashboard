import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const lockMigration = readFileSync(
  new URL("../supabase/migrations/20261029200000_loss_recovery_service_role_serialization.sql", import.meta.url),
  "utf8"
);
const peopleMigration = readFileSync(
  new URL("../supabase/migrations/20261029201000_repair_qlda1118_people_lifecycle.sql", import.meta.url),
  "utf8"
);

const company = "11111111-1111-1111-1111-111111111111";
const station = "22222222-2222-2222-2222-222222222222";
const employee = "33333333-3333-3333-3333-333333333333";
const person = "44444444-4444-4444-4444-444444444444";
const engagement = "55555555-5555-5555-5555-555555555555";

await db.exec(`
  create role service_role;
  create table hr_payroll_runs(id integer);
  create table hr_payroll_bank_lines(id integer);
  create table workforce_payroll_runs(id integer);
  create table workforce_payout_payment_items(id integer);
  create function save_nl_recovery(
    p_company uuid,p_month text,p_case text,p_version int,p_outcome text,p_mode text,
    p_allocations jsonb,p_remarks text,p_actor uuid,p_name text,
    p_details jsonb default '{}',p_plan jsonb default '{}'
  ) returns jsonb language plpgsql security invoker set search_path=public as $$
  begin
    -- Unpaid open payroll: protect bank instructions and run closure during validation.
    lock table hr_payroll_runs,hr_payroll_bank_lines,workforce_payroll_runs,workforce_payout_payment_items in share mode;
    return '{}'::jsonb;
  end $$;
  revoke all on function save_nl_recovery(uuid,text,text,int,text,text,jsonb,text,uuid,text,jsonb,jsonb) from public;
  grant execute on function save_nl_recovery(uuid,text,text,int,text,text,jsonb,text,uuid,text,jsonb,jsonb) to service_role;
`);

await db.exec("set role service_role");
await assert.rejects(
  db.query(`select save_nl_recovery('${company}','','',0,'','','[]','','${employee}','','{}','{}')`),
  /permission denied/i,
  "the production table lock must reproduce the service-role failure"
);
await db.exec("reset role");

await db.exec(lockMigration);
await db.exec(lockMigration);
await db.exec("set role service_role");
await db.query(`select save_nl_recovery('${company}','','',0,'','','[]','','${employee}','','{}','{}')`);
await db.exec("reset role");
const functionBody = String((await db.query("select pg_get_functiondef('save_nl_recovery(uuid,text,text,int,text,text,jsonb,text,uuid,text,jsonb,jsonb)'::regprocedure) body")).rows[0].body);
assert.match(functionBody, /Service-role-safe recovery writer serialization/);
assert.doesNotMatch(functionBody, /lock table hr_payroll_runs/i);

await db.exec(`
  create table companies(id uuid primary key, code text not null);
  create table stations(id uuid primary key, company_id uuid not null, station_code text not null);
  create table employees(
    id uuid primary key, company_id uuid not null, employee_code text, full_name text,
    location_id uuid, is_active boolean, people_lifecycle_status text,
    deleted_at timestamptz, last_working_date date, suspension_reason text,
    suspended_at timestamptz, suspended_by uuid, reactivated_at timestamptz,
    deactivated_at timestamptz, deactivated_by uuid, updated_at timestamptz
  );
  create table hr_people(
    id uuid primary key, company_id uuid not null, legacy_source_type text,
    legacy_source_id uuid, status text, updated_at timestamptz
  );
  create table hr_engagements(
    id uuid primary key, company_id uuid not null, person_id uuid, worker_type text,
    employee_id uuid, status text, end_date date, updated_at timestamptz
  );
  create table hr_work_assignments(
    id uuid primary key default gen_random_uuid(), company_id uuid not null,
    engagement_id uuid, location_id uuid, is_primary boolean, effective_to date
  );
  create table hr_exit_cases(
    id uuid primary key default gen_random_uuid(), company_id uuid not null,
    employee_id uuid, status text
  );
  create table hr_worker_lifecycle_events(
    id uuid primary key default gen_random_uuid(), company_id uuid not null,
    worker_type text, worker_id uuid, event_type text, from_status text,
    to_status text, reason text, metadata jsonb default '{}', created_at timestamptz default now()
  );
  insert into companies values ('${company}','DROPX_LOGISTICS');
  insert into stations values ('${station}','${company}','QLDA');
  insert into employees values (
    '${employee}','${company}','QLDA1118','MUZAMMIL MK','${station}',false,'suspended',
    null,null,null,null,null,null,null,null,now()
  );
  insert into hr_people values ('${person}','${company}','contractor','${employee}','inactive',now());
  insert into hr_engagements values ('${engagement}','${company}','${person}','employee','${employee}','inactive',null,now());
  insert into hr_work_assignments(company_id,engagement_id,location_id,is_primary,effective_to)
    values ('${company}','${engagement}','${station}',true,null);
  insert into hr_worker_lifecycle_events(company_id,worker_type,worker_id,event_type,from_status,to_status,reason,metadata,created_at)
    values ('${company}','employee','${employee}','access_reconciled','suspended','active','Prior repair',
      '{"source":"history_verified_production_repair"}','2026-08-31 14:31:00+00');
`);

await db.exec(peopleMigration);
await db.exec(peopleMigration);

assert.deepEqual(
  (await db.query(`
    select e.is_active,e.people_lifecycle_status,p.legacy_source_type,p.status person_status,g.status engagement_status,g.end_date
    from employees e
    join hr_people p on p.legacy_source_id=e.id
    join hr_engagements g on g.employee_id=e.id
    where e.id='${employee}'
  `)).rows[0],
  { is_active: true, people_lifecycle_status: "active", legacy_source_type: "employee", person_status: "active", engagement_status: "active", end_date: null }
);
assert.equal(
  Number((await db.query(`select count(*) n from hr_worker_lifecycle_events where metadata->>'source'='qlda1118_canonical_lifecycle_repair'`)).rows[0].n),
  1,
  "the auditable lifecycle repair must stay idempotent"
);

await db.close();
console.log("QLDA recovery serialization and QLDA1118 lifecycle checks passed.");
