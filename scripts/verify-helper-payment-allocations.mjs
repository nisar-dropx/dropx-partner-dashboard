import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationPath = resolve(
  root,
  "supabase/migrations/20261001091545_helper_payment_allocations.sql"
);
const sql = readFileSync(migrationPath, "utf8");
const includes = (pattern, message) => assert.match(sql, pattern, message);

includes(
  /create table public\.helper_payment_allocations\s*\(/i,
  "migration creates an isolated Helper allocation table"
);
includes(
  /foreign key \(company_id, helper_id\)[\s\S]*references public\.helpers \(company_id, id\)/i,
  "Helper ownership is protected by a tenant-safe composite foreign key"
);
for (const [column, target] of [
  ["station_id", "stations"],
  ["designation_id", "designations"],
  ["payment_method_id", "payment_methods"]
]) {
  includes(
    new RegExp(`foreign key \\(company_id, ${column}\\)\\s*references public\\.${target} \\(company_id, id\\)`, "i"),
    `${target} ownership is protected by the correct tenant-safe composite foreign key`
  );
}
includes(
  /constraint helper_payment_allocations_no_overlap[\s\S]*exclude using gist[\s\S]*daterange\([\s\S]*with &&/i,
  "effective-dated Helper history cannot overlap"
);
includes(
  /workforce-payment-basis:[\s\S]*p_company_id/i,
  "Helper snapshots participate in the shared payment-basis mutex"
);
includes(
  /allocation\.effective_from > p_effective_from[\s\S]*v_next_from - 1/i,
  "the save RPC derives an omitted end date from the next scheduled version"
);
includes(
  /create trigger helper_payment_allocation_transition_integrity[\s\S]*before update of location_id, designation, is_active, onboarding_status/i,
  "Helper lifecycle and assignment changes reconcile allocation history"
);
for (const trigger of [
  "designations_helper_payment_allocation_guard",
  "stations_helper_payment_allocation_guard",
  "payment_methods_helper_payment_allocation_guard"
]) {
  includes(new RegExp(`create trigger ${trigger}`, "i"), `${trigger} remains installed`);
}
includes(
  /revoke all on table public\.helper_payment_allocations[\s\S]*from public, anon, authenticated, service_role;[\s\S]*grant select on table public\.helper_payment_allocations to service_role;/i,
  "table access is restricted to service-role reads"
);
includes(
  /revoke all on function public\.save_helper_payment_allocation\([\s\S]*from public, anon, authenticated, service_role;[\s\S]*grant execute on function public\.save_helper_payment_allocation\([\s\S]*to service_role;/i,
  "only the service role can execute the write RPC"
);
assert.doesNotMatch(sql, /field_executive_provider_mappings/i, "Helper allocation must never depend on provider mapping");
assert.doesNotMatch(sql, /references public\.workforce\b/i, "Helper allocation must not use the Workforce master");

const db = new PGlite({ extensions: { btree_gist } });
const id = (value) => `00000000-0000-0000-0000-${value.toString(16).padStart(12, "0")}`;
const companyA = id(1);
const companyB = id(2);
const helperA = id(11);
const helperB = id(12);
const stationA = id(21);
const stationA2 = id(22);
const stationB = id(23);
const designationA = id(31);
const designationA2 = id(32);
const designationB = id(33);
const methodA = id(41);
const methodB = id(42);
const fieldA = id(51);
const fieldB = id(52);

const shiftDate = (date, days) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

const saveAllocation = (helperId, methodId, effectiveFrom, effectiveTo = null, amount = 100) => db.query(`
  select public.save_helper_payment_allocation(
    $1::uuid,
    $2::uuid,
    $3::uuid,
    $4::jsonb,
    $5::date,
    $6::date,
    'verification',
    null
  ) as id
`, [companyA, helperId, methodId, JSON.stringify({ DAILY: amount }), effectiveFrom, effectiveTo]);

try {
  await db.exec(`
    create schema auth;
    create role anon;
    create role authenticated;
    create role service_role;

    create table public.companies (id uuid primary key);
    create table auth.users (id uuid primary key);
    create table public.helpers (
      id uuid primary key,
      company_id uuid not null,
      location_id uuid,
      designation text,
      is_active boolean not null default true,
      onboarding_status text not null default 'active'
    );
    create table public.stations (
      id uuid primary key,
      company_id uuid not null,
      station_code text not null,
      is_active boolean not null default true
    );
    create table public.designations (
      id uuid primary key,
      company_id uuid not null,
      code text not null,
      name text not null,
      is_active boolean not null default true
    );
    create table public.payment_methods (
      id uuid primary key,
      company_id uuid not null,
      code text not null,
      name text not null,
      is_active boolean not null default true
    );
    create table public.payment_fields (
      id uuid primary key,
      company_id uuid not null,
      label text,
      pay_schedule text,
      calculation_type text,
      calculation_source text
    );
    create table public.payment_method_components (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null,
      payment_method_id uuid not null,
      payment_field_id uuid,
      component_code text not null,
      component_type text not null,
      label text,
      pay_schedule text,
      sort_order integer not null default 0,
      is_active boolean not null default true
    );
  `);

  await db.exec(sql);

  await db.exec(`
    insert into public.companies(id) values ('${companyA}'), ('${companyB}');
    insert into public.stations(id,company_id,station_code,is_active) values
      ('${stationA}','${companyA}','STA',true),
      ('${stationA2}','${companyA}','STB',true),
      ('${stationB}','${companyB}','OTHER',true);
    insert into public.designations(id,company_id,code,name,is_active) values
      ('${designationA}','${companyA}','DESIG_A','Designation A',true),
      ('${designationA2}','${companyA}','DESIG_B','Designation B',true),
      ('${designationB}','${companyB}','OTHER','Other',true);
    insert into public.payment_methods(id,company_id,code,name,is_active) values
      ('${methodA}','${companyA}','DAILY','Daily pay',true),
      ('${methodB}','${companyB}','OTHER','Other pay',true);
    insert into public.payment_fields(id,company_id,label,pay_schedule,calculation_type,calculation_source) values
      ('${fieldA}','${companyA}','Daily amount','per_day','fixed','attendance_eligibility'),
      ('${fieldB}','${companyB}','Other amount','per_day','fixed',null);
    insert into public.payment_method_components(
      company_id,payment_method_id,payment_field_id,component_code,component_type,label,pay_schedule,sort_order,is_active
    ) values
      ('${companyA}','${methodA}','${fieldA}','DAILY','amount','Daily amount','per_day',1,true),
      ('${companyB}','${methodB}','${fieldB}','OTHER','amount','Other amount','per_day',1,true);
    insert into public.helpers(id,company_id,location_id,designation,is_active,onboarding_status) values
      ('${helperA}','${companyA}','${stationA}','DESIG_A',true,'active'),
      ('${helperB}','${companyA}','${stationA}','DESIG_A',true,'active');
  `);

  // A version inserted before a scheduled future version is bounded by that
  // next start date rather than failing the open-row/overlap constraints.
  await saveAllocation(helperA, methodA, "2025-01-01", null, 100);
  await saveAllocation(helperA, methodA, "2025-03-01", null, 300);
  await saveAllocation(helperA, methodA, "2025-02-01", null, 200);
  await saveAllocation(helperA, methodA, "2025-02-01", null, 250);

  const dated = (await db.query(`
    select effective_from::text, effective_to::text, status, payment_values ->> 'DAILY' as amount
    from public.helper_payment_allocations
    where helper_id=$1
    order by effective_from
  `, [helperA])).rows;
  assert.deepEqual(dated, [
    { effective_from: "2025-01-01", effective_to: "2025-01-31", status: "closed", amount: "100" },
    { effective_from: "2025-02-01", effective_to: "2025-02-28", status: "closed", amount: "250" },
    { effective_from: "2025-03-01", effective_to: null, status: "active", amount: "300" }
  ]);
  await assert.rejects(
    () => saveAllocation(helperA, methodA, "2025-02-01", "2025-03-01", 999),
    /must be before the next Helper payment allocation/i
  );

  // The composite reference rejects a valid station UUID from another tenant.
  await assert.rejects(() => db.query(`
    insert into public.helper_payment_allocations(
      company_id,helper_id,station_id,station_code_snapshot,
      designation_id,designation_code_snapshot,designation_name_snapshot,
      payment_method_id,payment_values,payment_components,
      effective_from,effective_to,status
    ) values ($1,$2,$3,'OTHER',$4,'DESIG_A','Designation A',$5,'{}','[]','1999-01-01','1999-01-01','cancelled')
  `, [companyA, helperA, stationB, designationA, methodA]), /helper_payment_allocations_station_company_fk/i);

  await db.query("delete from public.helper_payment_allocations where helper_id=$1", [helperA]);
  const today = (await db.query(`select ((now() at time zone 'Asia/Kolkata')::date)::text as value`)).rows[0].value;
  const past = shiftDate(today, -10);
  const yesterday = shiftDate(today, -1);
  const future = shiftDate(today, 10);
  const beforeFuture = shiftDate(today, 9);

  await saveAllocation(helperA, methodA, past, null, 100);
  await saveAllocation(helperA, methodA, future, null, 300);
  await db.query(`update public.helpers set location_id=$1, designation='DESIG_B' where id=$2`, [stationA2, helperA]);

  const transitioned = (await db.query(`
    select effective_from::text, effective_to::text, status,
      station_id::text, designation_id::text, payment_values ->> 'DAILY' as amount
    from public.helper_payment_allocations
    where helper_id=$1
    order by effective_from
  `, [helperA])).rows;
  assert.deepEqual(transitioned, [
    { effective_from: past, effective_to: yesterday, status: "closed", station_id: stationA, designation_id: designationA, amount: "100" },
    { effective_from: today, effective_to: beforeFuture, status: "closed", station_id: stationA2, designation_id: designationA2, amount: "100" },
    { effective_from: future, effective_to: null, status: "active", station_id: stationA2, designation_id: designationA2, amount: "300" }
  ]);

  // Leaving active onboarding alone is enough to close current terms and
  // cancel scheduled terms, even while the Helper master remains enabled.
  await db.query(`update public.helpers set onboarding_status='returned' where id=$1`, [helperA]);
  const closed = (await db.query(`
    select effective_from::text, effective_to::text, status
    from public.helper_payment_allocations
    where helper_id=$1 and effective_from >= $2::date
    order by effective_from
  `, [helperA, today])).rows;
  assert.deepEqual(closed, [
    { effective_from: today, effective_to: today, status: "closed" },
    { effective_from: future, effective_to: null, status: "cancelled" }
  ]);
  await assert.rejects(
    () => saveAllocation(helperA, methodA, shiftDate(today, 1), null, 400),
    /must be active and fully onboarded/i
  );

  // Live allocations prevent master changes that would make the only write RPC
  // unable to resolve its station, designation or payment method.
  await saveAllocation(helperB, methodA, today, null, 125);
  await assert.rejects(
    () => db.query("update public.designations set code='RENAMED', name='Renamed' where id=$1", [designationA]),
    /active Helper payment allocations/i
  );
  await assert.rejects(
    () => db.query("update public.designations set is_active=false where id=$1", [designationA]),
    /active Helper payment allocations/i
  );
  await assert.rejects(
    () => db.query("update public.stations set is_active=false where id=$1", [stationA]),
    /active Helper payment allocations/i
  );
  await assert.rejects(
    () => db.query("update public.payment_methods set is_active=false where id=$1", [methodA]),
    /active Helper payment allocations/i
  );

  // is_active=false independently closes the live row. Once every affected
  // Helper is closed, masters may be deactivated without rewriting history.
  await db.query(`update public.helpers set is_active=false where id=$1`, [helperB]);
  await db.query("update public.stations set is_active=false where id=$1", [stationA]);
  await db.query("update public.designations set is_active=false where id=$1", [designationA]);
  await db.query("update public.payment_methods set is_active=false where id=$1", [methodA]);

  await db.exec("set role service_role");
  try {
    await db.query("select id from public.helper_payment_allocations limit 1");
    await assert.rejects(
      () => db.query("delete from public.helper_payment_allocations"),
      /permission denied/i
    );
  } finally {
    await db.exec("reset role");
  }

  await db.exec("set role authenticated");
  try {
    await assert.rejects(
      () => db.query("select id from public.helper_payment_allocations limit 1"),
      /permission denied/i
    );
  } finally {
    await db.exec("reset role");
  }

  console.log("Helper payment allocation migration checks passed.");
} finally {
  await db.close();
}
