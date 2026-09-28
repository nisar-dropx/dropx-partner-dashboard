import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [form, actions, providerMappingActions, directAllocationActions, dashboardCalculator, dashboardPayout, connectCalculator, migration, deployScript] = await Promise.all([
  read("src/components/payment-field-form.tsx"),
  read("src/app/master/payment-methods/actions.ts"),
  read("src/app/provider-mapping/actions.ts"),
  read("src/app/provider-mapping/direct-pay/actions.ts"),
  read("src/lib/direct-workforce-pay.ts"),
  read("src/app/payments/workforce-payouts/page.tsx"),
  read("apps/connect/src/lib/direct-workforce-payment.ts"),
  read("supabase/migrations/20260928170000_attendance_payment_basis_snapshot.sql"),
  read("scripts/payment_field_attendance_calculation_v1.sql")
]);

assert.match(form, /name="calculation_basis"/);
assert.match(form, /Attendance \/ worked time/);
assert.match(actions, /calculationBasis === "attendance"/);
assert.match(actions, /attendance_eligibility/);
assert.match(providerMappingActions, /Attendance-based payment methods must be assigned in Direct pay allocations/);
assert.match(actions, /Reassign those mappings before changing the calculation basis to Attendance/);
assert.match(actions, /Reassign those mappings before adding an Attendance field/);
assert.match(dashboardCalculator, /attendanceBased[\s\S]*attendanceUnit/);
assert.match(dashboardPayout, /calculation_source/);
assert.match(connectCalculator, /attendanceBased[\s\S]*units/);
assert.match(directAllocationActions, /save_workforce_payment_allocation_v2/);
assert.match(migration, /apply_workforce_payment_component_basis/);
assert.match(migration, /save_workforce_payment_allocation_v2/);
assert.match(migration, /revoke execute on function public\.save_workforce_payment_allocation\(uuid, uuid, uuid, jsonb, date, date, text, uuid\)[\s\S]*from service_role/);
assert.doesNotMatch(migration, /create trigger workforce_payment_allocations_calculation_snapshot/);
assert.match(migration, /payment_method_components_provider_basis/);
assert.match(migration, /create trigger field_executive_provider_mappings_00_payment_basis[\s\S]*before insert or update of company_id, payment_method_id, status/);
assert.equal((migration.match(/pg_advisory_xact_lock/g) ?? []).length, 4, "every payment-basis mutation and snapshot path must take the same transaction lock");
assert.equal(migration, deployScript, "the deploy script must exactly match the migration");

const db = new PGlite();
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;
  create table payment_fields (
    id uuid primary key,
    company_id uuid not null,
    calculation_source text,
    calculation_type text
  );
  create table payment_method_components (
    id uuid primary key,
    company_id uuid not null,
    payment_method_id uuid not null,
    payment_field_id uuid,
    component_code text not null,
    is_active boolean not null default true,
    sort_order integer not null default 0
  );
  create table workforce_payment_allocations (
    id uuid primary key,
    company_id uuid not null,
    payment_method_id uuid not null,
    payment_components jsonb not null,
    note text
  );
  create table field_executive_provider_mappings (
    id uuid primary key,
    company_id uuid not null,
    payment_method_id uuid,
    status text not null
  );
  create function save_workforce_payment_allocation(
    p_company_id uuid,
    p_workforce_id uuid,
    p_payment_method_id uuid,
    p_payment_values jsonb,
    p_effective_from date,
    p_effective_to date default null,
    p_change_reason text default null,
    p_actor_user_id uuid default null
  ) returns uuid language sql as $$ select null::uuid $$;
`);
await db.exec(migration);
const company = "00000000-0000-0000-0000-000000000001";
const method = "00000000-0000-0000-0000-000000000002";
const field = "00000000-0000-0000-0000-000000000003";
const component = "00000000-0000-0000-0000-000000000004";
const allocation = "00000000-0000-0000-0000-000000000005";
await db.query("insert into payment_fields values ($1,$2,'attendance_eligibility','fixed_monthly')", [field, company]);
await db.query("insert into payment_method_components values ($1,$2,$3,$4,'MONTHLY',true,1)", [component, company, method, field]);
await db.query("insert into workforce_payment_allocations values ($1,$2,$3,$4::jsonb,null)", [allocation, company, method, JSON.stringify([{ component_code: "MONTHLY", calculation_type: "fixed_monthly" }])]);
await db.query("select apply_workforce_payment_component_basis($1,$2)", [company, allocation]);
const inserted = await db.query("select payment_components from workforce_payment_allocations where id=$1", [allocation]);
assert.equal(inserted.rows[0].payment_components[0].calculation_source, "attendance_eligibility");
await assert.rejects(
  db.query("insert into field_executive_provider_mappings values ($1,$2,$3,'active')", ["00000000-0000-0000-0000-000000000007", company, method]),
  /Attendance-based payment methods must be assigned in Direct pay allocations/
);
await db.query("update payment_fields set calculation_source=null where id=$1", [field]);
const legacyAllocation = "00000000-0000-0000-0000-000000000006";
await db.query("insert into workforce_payment_allocations values ($1,$2,$3,$4::jsonb,null)", [legacyAllocation, company, method, JSON.stringify([{ component_code: "MONTHLY", calculation_type: "fixed_monthly" }])]);
await db.query("select apply_workforce_payment_component_basis($1,$2)", [company, legacyAllocation]);
const legacy = await db.query("select payment_components from workforce_payment_allocations where id=$1", [legacyAllocation]);
assert.equal(Object.hasOwn(legacy.rows[0].payment_components[0], "calculation_source"), true);
assert.equal(legacy.rows[0].payment_components[0].calculation_source, null, "legacy fixed-monthly snapshots must freeze an explicit legacy basis");
await db.query("update payment_fields set calculation_source='attendance_eligibility' where id=$1", [field]);
await db.query("update workforce_payment_allocations set payment_components=payment_components where id=$1", [legacyAllocation]);
const legacyAfterMasterChange = await db.query("select payment_components from workforce_payment_allocations where id=$1", [legacyAllocation]);
assert.equal(legacyAfterMasterChange.rows[0].payment_components[0].calculation_source, null, "master changes and automatic snapshot copies must not rewrite historical calculation basis");
await db.query("update payment_fields set calculation_source=null where id=$1", [field]);
await db.query("insert into field_executive_provider_mappings values ($1,$2,$3,'active')", ["00000000-0000-0000-0000-000000000008", company, method]);
await assert.rejects(
  db.query("update payment_fields set calculation_source='attendance_eligibility', calculation_type='fixed_monthly' where id=$1", [field]),
  /Reassign provider ID mappings before changing this payment field to attendance/
);
const attendanceField = "00000000-0000-0000-0000-000000000009";
await db.query("insert into payment_fields values ($1,$2,'attendance_eligibility','fixed_monthly')", [attendanceField, company]);
await assert.rejects(
  db.query("insert into payment_method_components values ($1,$2,$3,$4,'ATTENDANCE_MONTHLY',true,2)", ["00000000-0000-0000-0000-000000000010", company, method, attendanceField]),
  /Reassign provider ID mappings before adding an attendance field to this payment method/
);
await db.query("update workforce_payment_allocations set note='history stays frozen' where id=$1", [allocation]);
const preserved = await db.query("select payment_components from workforce_payment_allocations where id=$1", [allocation]);
assert.equal(preserved.rows[0].payment_components[0].calculation_source, "attendance_eligibility");
await db.close();

console.log("Attendance-based payment-field configuration and payout propagation verified.");
