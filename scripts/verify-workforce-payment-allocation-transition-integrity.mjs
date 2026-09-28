import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

const db = new PGlite({ extensions: { btree_gist } });
const company = "00000000-0000-0000-0000-000000000001";
const secondCompany = "00000000-0000-0000-0000-000000000020";
const stationA = "00000000-0000-0000-0000-000000000002";
const stationB = "00000000-0000-0000-0000-000000000003";
const stationInactive = "00000000-0000-0000-0000-000000000004";
const secondStation = "00000000-0000-0000-0000-000000000021";
const optionalA = "00000000-0000-0000-0000-000000000005";
const optionalB = "00000000-0000-0000-0000-000000000006";
const providerRequired = "00000000-0000-0000-0000-000000000007";
const nonField = "00000000-0000-0000-0000-000000000008";
const inactiveDesignation = "00000000-0000-0000-0000-000000000009";
const secondDesignation = "00000000-0000-0000-0000-000000000022";
const method = "00000000-0000-0000-0000-000000000010";
const secondMethod = "00000000-0000-0000-0000-000000000023";
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
    period_end date not null,
    calculated_at timestamptz
  );
`);

const baseMigration = readFileSync(
  new URL("../supabase/migrations/20260928100000_workforce_payment_allocations.sql", import.meta.url),
  "utf8"
);
const matchingScript = readFileSync(
  new URL("./workforce_payment_allocations_v1.sql", import.meta.url),
  "utf8"
);
assert.equal(baseMigration, matchingScript, "deploy script must exactly match the migration");
const saveFunctionSql = baseMigration.slice(
  baseMigration.indexOf("create or replace function public.save_workforce_payment_allocation("),
  baseMigration.indexOf("alter table public.workforce_payment_allocations enable row level security;")
);
const saveLockPosition = saveFunctionSql.indexOf("perform pg_advisory_xact_lock(hashtextextended(");
const workforceRowLockPosition = saveFunctionSql.indexOf("for update;");
const workforceReadPosition = saveFunctionSql.indexOf("select\n    workforce.location_id");
assert.ok(saveLockPosition >= 0, "save RPC must take the canonical worker advisory lock");
assert.ok(
  workforceRowLockPosition >= 0 && workforceRowLockPosition < saveLockPosition,
  "save RPC must lock the Workforce row before the advisory lock"
);
assert.ok(
  saveLockPosition < workforceReadPosition,
  "save RPC must re-read Workforce ownership after both locks"
);
for (const tenantConstraint of [
  "workforce_payment_allocations_workforce_company_fk",
  "workforce_payment_allocations_station_company_fk",
  "workforce_payment_allocations_designation_company_fk",
  "workforce_payment_allocations_method_company_fk",
]) {
  assert.ok(baseMigration.includes(tenantConstraint), `${tenantConstraint} must exist`);
}
assert.match(
  baseMigration,
  /revoke all on table public\.workforce_payment_allocations from public, anon, authenticated, service_role;/i,
  "service_role must lose direct allocation-table writes"
);
assert.match(
  baseMigration,
  /grant select on table public\.workforce_payment_allocations to service_role;/i,
  "service_role must retain read access"
);
assert.doesNotMatch(
  baseMigration,
  /grant[^;]*(insert|update|delete)[^;]*workforce_payment_allocations[^;]*service_role/i,
  "service_role writes must go through save_workforce_payment_allocation"
);

const executableBaseMigration = baseMigration.replace("create extension if not exists pgcrypto;", "");
await db.exec(executableBaseMigration);
await db.exec(readFileSync(
  new URL("../supabase/migrations/20260928120000_workforce_payment_allocation_finalized_guard.sql", import.meta.url),
  "utf8"
));
await db.exec(readFileSync(
  new URL("../supabase/migrations/20260928130000_workforce_payment_allocation_transition_integrity.sql", import.meta.url),
  "utf8"
));

await db.query("insert into companies values ($1)", [company]);
await db.query("insert into companies values ($1)", [secondCompany]);
await db.query(`insert into stations values
  ($1,$4,'A',true),($2,$4,'B',true),($3,$4,'INACTIVE',false)`,
  [stationA, stationB, stationInactive, company]);
await db.query("insert into stations values ($1,$2,'SECOND',true)", [secondStation, secondCompany]);
await db.query(`insert into designations values
  ($1,$6,'DIRECT_A','Direct A',true,true,false),
  ($2,$6,'DIRECT_B','Direct B',true,true,false),
  ($3,$6,'PROVIDER','Provider role',true,true,true),
  ($4,$6,'OFFICE','Office role',true,false,false),
  ($5,$6,'INACTIVE','Inactive direct',false,true,false)`,
  [optionalA, optionalB, providerRequired, nonField, inactiveDesignation, company]);
await db.query(
  "insert into designations values ($1,$2,'SECOND','Second tenant direct',true,true,false)",
  [secondDesignation, secondCompany]
);
await db.query("insert into payment_methods values ($1,$2,true)", [method, company]);
await db.query("insert into payment_methods values ($1,$2,true)", [secondMethod, secondCompany]);
await db.query("insert into payment_fields values ($1,$2,'Daily pay','per_day','fixed_daily')", [field, company]);
await db.query("insert into payment_method_components values ($1,$2,$3,$4,'DAILY','amount','Daily','per_day',1,true)",
  [component, company, method, field]);

const clock = await db.query(`select
  ((now() at time zone 'Asia/Kolkata')::date)::text today,
  (((now() at time zone 'Asia/Kolkata')::date)-1)::text yesterday,
  (((now() at time zone 'Asia/Kolkata')::date)+1)::text tomorrow,
  (((now() at time zone 'Asia/Kolkata')::date)+2)::text day_after_tomorrow,
  (((now() at time zone 'Asia/Kolkata')::date)-10)::text past`);
const { today, yesterday, tomorrow, day_after_tomorrow: dayAfterTomorrow, past } = clock.rows[0];

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
    payment_values,payment_components,effective_from::text,effective_to::text,status,
    change_reason,transition_restore_state
  from workforce_payment_allocations
  where workforce_id=$1
  order by effective_from,id`, [workforceId]);
  return result.rows;
}

// The application service role can read and execute the security-definer save
// RPC, but cannot issue allocation INSERT/UPDATE/DELETE statements directly.
const permissionWorker = await addWorker();
let permissionAllocationId;
await db.exec("set role service_role");
try {
  await db.query("select count(*) from workforce_payment_allocations");
  await assert.rejects(
    () => db.query(`insert into workforce_payment_allocations (
      company_id,workforce_id,station_id,designation_id,payment_method_id,
      payment_values,payment_components,effective_from,status
    ) values ($1,$2,$3,$4,$5,'{}'::jsonb,'[]'::jsonb,$6,'active')`,
    [company, permissionWorker, stationA, optionalA, method, today]),
    /permission denied/i
  );
  permissionAllocationId = (await db.query(`select public.save_workforce_payment_allocation(
    $1,$2,$3,$4::jsonb,$5::date,null,'permission test',null
  ) id`, [company, permissionWorker, method, JSON.stringify({ DAILY: 800 }), today])).rows[0].id;
  await assert.rejects(
    () => db.query("update workforce_payment_allocations set change_reason='raw update' where id=$1", [permissionAllocationId]),
    /permission denied/i
  );
  await assert.rejects(
    () => db.query("delete from workforce_payment_allocations where id=$1", [permissionAllocationId]),
    /permission denied/i
  );
} finally {
  await db.exec("reset role");
}
await db.query("update workforce_payment_allocations set status='cancelled' where id=$1", [permissionAllocationId]);

// Composite foreign keys reject cross-company references even for raw
// owner/superuser repair DML. The service role itself is read/RPC-only above.
const secondWorker = "00000000-0000-0000-0000-000000000024";
await db.query(`insert into workforce (
  id,company_id,location_id,designation_id,designation,is_active,lifecycle_status
) values ($1,$2,$3,$4,'SECOND',true,'active')`,
[secondWorker, secondCompany, secondStation, secondDesignation]);
const tenantWorker = await addWorker();
async function rawAllocation({ workforceId, stationId, designationId, methodId }) {
  return db.query(`insert into workforce_payment_allocations (
    company_id,workforce_id,station_id,designation_id,payment_method_id,
    payment_values,payment_components,effective_from,status
  ) values ($1,$2,$3,$4,$5,'{}'::jsonb,'[]'::jsonb,$6,'active')`,
  [company, workforceId, stationId, designationId, methodId, today]);
}
await assert.rejects(
  () => rawAllocation({ workforceId: secondWorker, stationId: stationA, designationId: optionalA, methodId: method }),
  /workforce_payment_allocations_workforce_company_fk|foreign key/i
);
await assert.rejects(
  () => rawAllocation({ workforceId: tenantWorker, stationId: secondStation, designationId: optionalA, methodId: method }),
  /workforce_payment_allocations_station_company_fk|foreign key/i
);
await assert.rejects(
  () => rawAllocation({ workforceId: tenantWorker, stationId: stationA, designationId: secondDesignation, methodId: method }),
  /workforce_payment_allocations_designation_company_fk|foreign key/i
);
await assert.rejects(
  () => rawAllocation({ workforceId: tenantWorker, stationId: stationA, designationId: optionalA, methodId: secondMethod }),
  /workforce_payment_allocations_method_company_fk|foreign key/i
);
await rawAllocation({ workforceId: tenantWorker, stationId: stationA, designationId: optionalA, methodId: method });
await db.query("update workforce_payment_allocations set status='cancelled' where workforce_id=$1", [tenantWorker]);

// Future employment cutoffs cap open-ended allocations and reject starts
// after the Workforce member's last working date.
const cutoffWorker = await addWorker();
await db.query("update workforce set last_working_date=$1 where id=$2", [tomorrow, cutoffWorker]);
await saveAllocation(cutoffWorker, today);
const cutoffRows = await allocations(cutoffWorker);
assert.equal(cutoffRows[0].effective_to, tomorrow);
assert.equal(cutoffRows[0].status, "closed");
assert.deepEqual(cutoffRows[0].transition_restore_state, {
  kind: "employment_cutoff",
  effective_to: null,
  status: "active",
  change_reason: "test allocation",
});
await assert.rejects(
  () => saveAllocation(cutoffWorker, dayAfterTomorrow),
  /cannot start after the Workforce last working date/i
);
await db.query("update workforce set last_working_date=$1 where id=$2", [dayAfterTomorrow, cutoffWorker]);
const extendedCutoffRows = await allocations(cutoffWorker);
assert.equal(extendedCutoffRows[0].effective_to, dayAfterTomorrow);
assert.equal(extendedCutoffRows[0].status, "closed");
assert.deepEqual(extendedCutoffRows[0].transition_restore_state, {
  kind: "employment_cutoff",
  effective_to: null,
  status: "active",
  change_reason: "test allocation",
});
await db.query("update workforce set last_working_date=null where id=$1", [cutoffWorker]);
const clearedCutoffRows = await allocations(cutoffWorker);
assert.equal(clearedCutoffRows[0].effective_to, null);
assert.equal(clearedCutoffRows[0].status, "active");
assert.equal(clearedCutoffRows[0].change_reason, "test allocation");
assert.equal(clearedCutoffRows[0].transition_restore_state, null);

// Rerunning the install script must not repopulate an intentionally empty
// immutable snapshot from subsequently changed payment-method master data.
await db.query("update workforce_payment_allocations set payment_components='[]'::jsonb where workforce_id=$1", [cutoffWorker]);
await db.query("update payment_method_components set label='Changed after freeze' where id=$1", [component]);
await db.exec(executableBaseMigration);
assert.deepEqual(
  (await db.query("select payment_components from workforce_payment_allocations where workforce_id=$1", [cutoffWorker])).rows[0].payment_components,
  []
);

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
assert.equal(offboardedRows[0].transition_restore_state.kind, "employment_cutoff");

// Correcting all offboarding fields restores the exact pre-cutoff allocation state.
await db.query(`update workforce set
  is_active=true,lifecycle_status='active',last_working_date=null,deactivated_at=null
  where id=$1`, [offboarded]);
const reactivatedRows = await allocations(offboarded);
assert.equal(reactivatedRows[0].effective_to, null);
assert.equal(reactivatedRows[0].status, "active");
assert.equal(reactivatedRows[0].transition_restore_state, null);

const offboardedFuture = await addWorker();
await saveAllocation(offboardedFuture, tomorrow);
await db.query("update workforce set is_active=false,lifecycle_status='exited' where id=$1", [offboardedFuture]);
assert.equal((await allocations(offboardedFuture))[0].status, "cancelled");

// Extending and then clearing an LWD is reversible for both current and future terms.
const correctedLwd = await addWorker();
await saveAllocation(correctedLwd, past);
await db.query("update workforce set last_working_date=$1 where id=$2", [today, correctedLwd]);
assert.equal((await allocations(correctedLwd))[0].effective_to, today);
await db.query("update workforce set last_working_date=$1 where id=$2", [tomorrow, correctedLwd]);
const extendedLwdRows = await allocations(correctedLwd);
assert.equal(extendedLwdRows[0].effective_to, tomorrow);
assert.equal(extendedLwdRows[0].status, "closed");
await db.query("update workforce set last_working_date=null where id=$1", [correctedLwd]);
const clearedLwdRows = await allocations(correctedLwd);
assert.equal(clearedLwdRows[0].effective_to, null);
assert.equal(clearedLwdRows[0].status, "active");
assert.equal(clearedLwdRows[0].transition_restore_state, null);

const correctedFutureLwd = await addWorker();
await saveAllocation(correctedFutureLwd, tomorrow);
await db.query("update workforce set last_working_date=$1 where id=$2", [today, correctedFutureLwd]);
assert.equal((await allocations(correctedFutureLwd))[0].status, "cancelled");
await db.query("update workforce set last_working_date=$1 where id=$2", [tomorrow, correctedFutureLwd]);
const extendedFutureRows = await allocations(correctedFutureLwd);
assert.equal(extendedFutureRows[0].effective_to, tomorrow);
assert.equal(extendedFutureRows[0].status, "closed");
await db.query("update workforce set last_working_date=null where id=$1", [correctedFutureLwd]);
const clearedFutureRows = await allocations(correctedFutureLwd);
assert.equal(clearedFutureRows[0].effective_to, null);
assert.equal(clearedFutureRows[0].status, "active");
assert.equal(clearedFutureRows[0].transition_restore_state, null);

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
console.log("PASS Workforce direct-payment transition integrity: versioning, reversible employment cutoffs, policy changes, master validation, overlap and finalized rollback.");
