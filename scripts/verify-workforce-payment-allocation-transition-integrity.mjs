import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

const db = new PGlite({ extensions: { btree_gist } });
const company = "00000000-0000-0000-0000-000000000001";
const stationA = "00000000-0000-0000-0000-000000000002";
const stationB = "00000000-0000-0000-0000-000000000003";
const stationInactive = "00000000-0000-0000-0000-000000000004";
const optionalA = "00000000-0000-0000-0000-000000000005";
const optionalB = "00000000-0000-0000-0000-000000000006";
const providerRequired = "00000000-0000-0000-0000-000000000007";
const nonField = "00000000-0000-0000-0000-000000000008";
const inactiveDesignation = "00000000-0000-0000-0000-000000000009";
const method = "00000000-0000-0000-0000-000000000010";
const field = "00000000-0000-0000-0000-000000000011";
const component = "00000000-0000-0000-0000-000000000012";

await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;
  create schema auth;
  create table auth.users(id uuid primary key);
  create table public.companies(id uuid primary key);
  create table public.stations(
    id uuid primary key,
    company_id uuid not null,
    station_code text not null,
    is_active boolean not null
  );
  create table public.designations(
    id uuid primary key,
    company_id uuid not null,
    code text not null,
    name text not null,
    is_active boolean not null,
    is_field_operations boolean not null,
    provider_mapping_required boolean not null
  );
  create table public.workforce(
    id uuid primary key,
    company_id uuid not null,
    location_id uuid,
    designation_id uuid,
    designation text,
    is_active boolean not null,
    deleted_at timestamptz,
    source_profile_type text,
    source_profile_id uuid,
    lifecycle_status text,
    deactivated_at timestamptz,
    last_working_date date
  );
  create table public.payment_methods(
    id uuid primary key,
    company_id uuid not null,
    is_active boolean not null
  );
  create table public.payment_fields(
    id uuid primary key,
    company_id uuid not null,
    label text not null,
    pay_schedule text,
    calculation_type text
  );
  create table public.payment_method_components(
    id uuid primary key,
    company_id uuid not null,
    payment_method_id uuid not null,
    payment_field_id uuid,
    component_code text not null,
    component_type text not null,
    label text not null,
    pay_schedule text,
    sort_order integer not null,
    is_active boolean not null
  );
  create table public.field_executive_provider_mappings(
    id uuid primary key,
    company_id uuid not null,
    workforce_id uuid,
    employee_id uuid,
    contractor_id uuid,
    field_executive_id uuid,
    effective_from date,
    effective_to date,
    status text not null
  );
  create table public.workforce_payroll_runs(
    id uuid primary key,
    company_id uuid not null,
    status text not null,
    period_start date not null,
    period_end date not null
  );
`);

const baseMigration = readFileSync(
  new URL("../supabase/migrations/20260928100000_workforce_payment_allocations.sql", import.meta.url),
  "utf8"
).replace("create extension if not exists pgcrypto;", "");
await db.exec(baseMigration);
await db.exec(readFileSync(
  new URL("../supabase/migrations/20260928120000_workforce_payment_allocation_finalized_guard.sql", import.meta.url),
  "utf8"
));
await db.exec(readFileSync(
  new URL("../supabase/migrations/20260928130000_workforce_payment_allocation_transition_integrity.sql", import.meta.url),
  "utf8"
));

await db.query("insert into companies values ($1)", [company]);
await db.query(`insert into stations values
  ($1,$4,'A',true),($2,$4,'B',true),($3,$4,'INACTIVE',false)`,
  [stationA, stationB, stationInactive, company]);
await db.query(`insert into designations values
  ($1,$6,'DIRECT_A','Direct A',true,true,false),
  ($2,$6,'DIRECT_B','Direct B',true,true,false),
  ($3,$6,'PROVIDER','Provider role',true,true,true),
  ($4,$6,'OFFICE','Office role',true,false,false),
  ($5,$6,'INACTIVE','Inactive direct',false,true,false)`,
  [optionalA, optionalB, providerRequired, nonField, inactiveDesignation, company]);
await db.query("insert into payment_methods values ($1,$2,true)", [method, company]);
await db.query("insert into payment_fields values ($1,$2,'Daily pay','per_day','fixed_daily')", [field, company]);
await db.query("insert into payment_method_components values ($1,$2,$3,$4,'DAILY','amount','Daily','per_day',1,true)",
  [component, company, method, field]);

const clock = await db.query(`select
  ((now() at time zone 'Asia/Kolkata')::date)::text today,
  (((now() at time zone 'Asia/Kolkata')::date)-1)::text yesterday,
  (((now() at time zone 'Asia/Kolkata')::date)+1)::text tomorrow,
  (((now() at time zone 'Asia/Kolkata')::date)-10)::text past`);
const { today, yesterday, tomorrow, past } = clock.rows[0];

let workerIndex = 100;
function nextWorker() {
  workerIndex += 1;
  return `00000000-0000-0000-0000-${String(workerIndex).padStart(12, "0")}`;
}
async function addWorker({ station = stationA, designation = optionalA } = {}) {
  const id = nextWorker();
  const designationRow = await db.query("select code from designations where id=$1", [designation]);
  await db.query(`insert into workforce (
    id,company_id,location_id,designation_id,designation,is_active,lifecycle_status
  ) values ($1,$2,$3,$4,$5,true,'active')`,
  [id, company, station, designation, designationRow.rows[0].code]);
  return id;
}
async function saveAllocation(workforceId, effectiveFrom) {
  const result = await db.query(`select public.save_workforce_payment_allocation(
    $1,$2,$3,$4::jsonb,$5::date,null,'test allocation',null
  ) id`, [company, workforceId, method, JSON.stringify({ DAILY: 800 }), effectiveFrom]);
  return result.rows[0].id;
}
async function allocations(workforceId) {
  const result = await db.query(`select
    id,station_id,station_code_snapshot,designation_id,designation_code_snapshot,
    payment_values,payment_components,effective_from::text,effective_to::text,status
  from workforce_payment_allocations
  where workforce_id=$1
  order by effective_from,id`, [workforceId]);
  return result.rows;
}

// An allocation that starts today is aligned in place; its frozen terms remain untouched.
const startsToday = await addWorker();
const startsTodayAllocation = await saveAllocation(startsToday, today);
const startsTodayBefore = (await allocations(startsToday))[0];
await db.query("update workforce set location_id=$1 where id=$2", [stationB, startsToday]);
const startsTodayAfter = await allocations(startsToday);
assert.equal(startsTodayAfter.length, 1);
assert.equal(startsTodayAfter[0].id, startsTodayAllocation);
assert.equal(startsTodayAfter[0].station_id, stationB);
assert.equal(startsTodayAfter[0].station_code_snapshot, "B");
assert.deepEqual(startsTodayAfter[0].payment_values, startsTodayBefore.payment_values);
assert.deepEqual(startsTodayAfter[0].payment_components, startsTodayBefore.payment_components);

// A past-start allocation is closed yesterday and cloned from today at the new station.
const pastTransfer = await addWorker();
await saveAllocation(pastTransfer, past);
const pastTransferBefore = (await allocations(pastTransfer))[0];
await db.query("update workforce set location_id=$1 where id=$2", [stationB, pastTransfer]);
const pastTransferRows = await allocations(pastTransfer);
assert.equal(pastTransferRows.length, 2);
assert.equal(pastTransferRows[0].effective_to, yesterday);
assert.equal(pastTransferRows[0].status, "closed");
assert.equal(pastTransferRows[1].effective_from, today);
assert.equal(pastTransferRows[1].station_id, stationB);
assert.equal(pastTransferRows[1].status, "active");
assert.deepEqual(pastTransferRows[1].payment_values, pastTransferBefore.payment_values);
assert.deepEqual(pastTransferRows[1].payment_components, pastTransferBefore.payment_components);

// Optional-to-optional designation changes create a new effective-dated snapshot.
const optionalSwitch = await addWorker();
await saveAllocation(optionalSwitch, past);
await db.query("update workforce set designation_id=$1,designation='DIRECT_B' where id=$2", [optionalB, optionalSwitch]);
const optionalSwitchRows = await allocations(optionalSwitch);
assert.equal(optionalSwitchRows.length, 2);
assert.equal(optionalSwitchRows[1].designation_id, optionalB);
assert.equal(optionalSwitchRows[1].designation_code_snapshot, "DIRECT_B");

// A future version makes station/designation ownership ambiguous and blocks the worker update.
const futureWorker = await addWorker();
await saveAllocation(futureWorker, tomorrow);
await assert.rejects(
  () => db.query("update workforce set location_id=$1 where id=$2", [stationB, futureWorker]),
  /future direct payment allocation already exists/i
);
assert.equal((await db.query("select location_id from workforce where id=$1", [futureWorker])).rows[0].location_id, stationA);
assert.equal((await allocations(futureWorker))[0].status, "active");

// Switching to a provider-required designation closes past terms before today.
const policySwitch = await addWorker();
await saveAllocation(policySwitch, past);
await db.query("update workforce set designation_id=$1,designation='PROVIDER' where id=$2", [providerRequired, policySwitch]);
const policySwitchRows = await allocations(policySwitch);
assert.equal(policySwitchRows.length, 1);
assert.equal(policySwitchRows[0].effective_to, yesterday);
assert.equal(policySwitchRows[0].status, "closed");
await db.query(`insert into field_executive_provider_mappings (
  id,company_id,workforce_id,effective_from,status
) values (gen_random_uuid(),$1,$2,$3,'active')`, [company, policySwitch, today]);

// A same-day direct allocation is cancelled when a non-field designation takes effect.
const sameDayPolicySwitch = await addWorker();
await saveAllocation(sameDayPolicySwitch, today);
await db.query("update workforce set designation_id=$1,designation='OFFICE' where id=$2", [nonField, sameDayPolicySwitch]);
assert.equal((await allocations(sameDayPolicySwitch))[0].status, "cancelled");

// Offboarding includes the last working date and cancels allocations after it.
const offboarded = await addWorker();
await saveAllocation(offboarded, past);
await db.query(`update workforce set
  is_active=false,lifecycle_status='exited',last_working_date=$1,deactivated_at=now()
  where id=$2`, [today, offboarded]);
const offboardedRows = await allocations(offboarded);
assert.equal(offboardedRows[0].effective_to, today);
assert.equal(offboardedRows[0].status, "closed");

const offboardedFuture = await addWorker();
await saveAllocation(offboardedFuture, tomorrow);
await db.query("update workforce set is_active=false,lifecycle_status='exited' where id=$1", [offboardedFuture]);
assert.equal((await allocations(offboardedFuture))[0].status, "cancelled");

const deletedWorker = await addWorker();
await saveAllocation(deletedWorker, past);
await db.query("update workforce set deleted_at=now() where id=$1", [deletedWorker]);
assert.equal((await allocations(deletedWorker))[0].effective_to, today);

// New allocation ownership must point to active station/designation masters.
const invalidStationWorker = await addWorker();
await saveAllocation(invalidStationWorker, past);
await assert.rejects(
  () => db.query("update workforce set location_id=$1 where id=$2", [stationInactive, invalidStationWorker]),
  /active company location/i
);
assert.equal((await db.query("select location_id from workforce where id=$1", [invalidStationWorker])).rows[0].location_id, stationA);

const invalidDesignationWorker = await addWorker();
await saveAllocation(invalidDesignationWorker, past);
await assert.rejects(
  () => db.query("update workforce set designation_id=$1,designation='INACTIVE' where id=$2", [inactiveDesignation, invalidDesignationWorker]),
  /active designation/i
);
assert.equal((await db.query("select designation_id from workforce where id=$1", [invalidDesignationWorker])).rows[0].designation_id, optionalA);

// Existing provider mappings continue to prevent direct allocation overlap.
const providerMappedWorker = await addWorker();
await db.query(`insert into field_executive_provider_mappings (
  id,company_id,workforce_id,effective_from,status
) values (gen_random_uuid(),$1,$2,$3,'active')`, [company, providerMappedWorker, today]);
await assert.rejects(
  () => saveAllocation(providerMappedWorker, today),
  /overlaps an existing provider payment mapping/i
);

// The finalized-payroll guard aborts both allocation and workforce mutations atomically.
const finalizedWorker = await addWorker();
await saveAllocation(finalizedWorker, past);
await db.query(`insert into workforce_payroll_runs values (
  gen_random_uuid(),$1,'approved',$2::date,$3::date
)`, [company, past, today]);
await assert.rejects(
  () => db.query("update workforce set location_id=$1 where id=$2", [stationB, finalizedWorker]),
  /Finalized Workforce payroll/i
);
assert.equal((await db.query("select location_id from workforce where id=$1", [finalizedWorker])).rows[0].location_id, stationA);
const finalizedRows = await allocations(finalizedWorker);
assert.equal(finalizedRows.length, 1);
assert.equal(finalizedRows[0].effective_to, null);
assert.equal(finalizedRows[0].status, "active");

await db.close();
console.log("PASS Workforce direct-payment transition integrity: same-day and historical versioning, future ambiguity, policy changes, offboarding, master validation, overlap and finalized rollback.");
