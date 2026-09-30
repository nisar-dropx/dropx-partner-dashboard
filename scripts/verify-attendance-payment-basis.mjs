import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [form, actions, providerMappingActions, providerFirstPage, directAllocationActions, dashboardCalculator, dashboardPayout, connectCalculator, connectPaymentData, reportImportRoute, reportImportAttendance, migration, deployScript, providerMigration, providerDeployScript] = await Promise.all([
  read("src/components/payment-field-form.tsx"),
  read("src/app/master/payment-methods/actions.ts"),
  read("src/app/provider-mapping/actions.ts"),
  read("src/app/provider-mapping/provider-first/page.tsx"),
  read("src/app/provider-mapping/direct-pay/actions.ts"),
  read("src/lib/direct-workforce-pay.ts"),
  read("src/app/payments/workforce-payouts/page.tsx"),
  read("apps/connect/src/lib/direct-workforce-payment.ts"),
  read("apps/connect/src/lib/direct-workforce-payment-data.ts"),
  read("src/app/api/report-imports/route.ts"),
  read("src/app/api/report-imports/report-import-attendance.ts"),
  read("supabase/migrations/20260928170000_attendance_payment_basis_snapshot.sql"),
  read("scripts/payment_field_attendance_calculation_v1.sql"),
  read("supabase/migrations/20260928220000_provider_attendance_payment_basis.sql"),
  read("scripts/provider_attendance_payment_basis_v1.sql")
]);

assert.match(form, /name="calculation_basis"/);
assert.match(form, /Attendance \/ worked time/);
assert.match(actions, /calculationBasis === "attendance"/);
assert.match(actions, /attendance_eligibility/);
assert.doesNotMatch(providerMappingActions, /Attendance-based payment methods must be assigned in Direct pay allocations/);
assert.doesNotMatch(actions, /Reassign those mappings before changing the calculation basis to Attendance/);
assert.doesNotMatch(actions, /Reassign those mappings before adding an Attendance field/);
assert.doesNotMatch(providerFirstPage, /\.filter\(\(method\)[\s\S]*attendance_eligibility/);
assert.match(dashboardCalculator, /attendanceBased[\s\S]*attendanceUnit/);
assert.match(dashboardPayout, /attendanceComponents[\s\S]*directPayForDay/);
assert.match(dashboardPayout, /const allMappings = mappingsResult\.data \?\? \[\][\s\S]*const mappings = allMappings\.filter/,
  "the payout worksheet must retain tenant-wide mappings while rendering only allowed locations");
assert.match(dashboardPayout, /const attendanceOwnerOn[\s\S]*const candidates = allMappings\.filter/,
  "provider attendance ownership must not change with the viewer's location scope");
assert.match(connectCalculator, /attendanceBased[\s\S]*units/);
assert.match(connectPaymentData, /and\(workforce_id\.is\.null,\$\{sourceColumn\}\.eq\.\$\{worker\.source_profile_id\}\)/);
assert.match(reportImportRoute, /const amazonMappingSelect = "[^"]*workforce_id,employee_id,contractor_id,field_executive_id"/);
assert.match(reportImportRoute, /field_executive_provider_mappings[\s\S]*\.select\(amazonMappingSelect\)/);
assert.match(reportImportRoute, /attendance_daily[\s\S]*workforce_id,employee_id,contractor_id,field_executive_id,punch_date,status,in_time,out_time,work_minutes/);
assert.match(reportImportRoute, /productionComponent[\s\S]*productionForSource[\s\S]*attendanceComponent[\s\S]*directPayForDay/);
assert.match(directAllocationActions, /save_workforce_payment_allocation_v2/);
assert.match(migration, /apply_workforce_payment_component_basis/);
assert.match(migration, /save_workforce_payment_allocation_v2/);
assert.match(migration, /revoke execute on function public\.save_workforce_payment_allocation\(uuid, uuid, uuid, jsonb, date, date, text, uuid\)[\s\S]*from service_role/);
assert.doesNotMatch(migration, /create trigger workforce_payment_allocations_calculation_snapshot/);
assert.match(migration, /payment_method_components_provider_basis/);
assert.match(migration, /create trigger field_executive_provider_mappings_00_payment_basis[\s\S]*before insert or update of company_id, payment_method_id, status/);
assert.equal((migration.match(/pg_advisory_xact_lock/g) ?? []).length, 4, "every payment-basis mutation and snapshot path must take the same transaction lock");
assert.equal(migration, deployScript, "the deploy script must exactly match the migration");
assert.match(providerMigration, /DROPX_LOGISTICS/);
assert.match(providerMigration, /FIXED_PAY_PER_DAY/);
assert.match(providerMigration, /VAN_RENT_PER_MONTH/);
assert.match(providerMigration, /worker\.id = new\.field_executive_id/);
assert.match(providerMigration, /worker\.biometric_id/);
assert.match(providerMigration, /resolved\.match_count = 1/);
assert.doesNotMatch(providerMigration, /drop trigger if exists payment_fields_attendance_direct_only/);
assert.match(providerMigration, /create or replace function public\.enforce_attendance_payment_field_direct_only\(\)[\s\S]*pg_advisory_xact_lock/);
assert.match(providerMigration, /create or replace function public\.enforce_provider_mapping_payment_basis\(\)[\s\S]*pg_advisory_xact_lock/);
assert.match(providerMigration, /create or replace function public\.enforce_payment_component_provider_basis\(\)[\s\S]*pg_advisory_xact_lock/);
assert.equal((providerMigration.match(/pg_advisory_xact_lock/g) ?? []).length, 4, "provider attendance must preserve every shared payment-basis lock");
assert.equal(providerMigration, providerDeployScript, "the provider-attendance deploy script must exactly match the migration");

const attendanceModule = { exports: {} };
new Function("exports", "module", ts.transpileModule(reportImportAttendance, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText)(attendanceModule.exports, attendanceModule);
const {
  buildReportImportAttendanceByWorkforceDate,
  canonicalWorkforceForMapping,
  createReportImportWorkforceIndex
} = attendanceModule.exports;
const workforceIndex = createReportImportWorkforceIndex([
  { id: "workforce-employee", source_profile_type: "employee", source_profile_id: "employee-1" },
  { id: "workforce-contractor", source_profile_type: "contractor", source_profile_id: "contractor-1" },
  { id: "workforce-executive", source_profile_type: "field_executive", source_profile_id: "executive-1" },
  { id: "workforce-canonical", source_profile_type: "canonical", source_profile_id: "workforce-canonical" }
]);
assert.equal(canonicalWorkforceForMapping({ employee_id: "employee-1" }, workforceIndex)?.id, "workforce-employee");
assert.equal(canonicalWorkforceForMapping({ contractor_id: "contractor-1" }, workforceIndex)?.id, "workforce-contractor");
assert.equal(canonicalWorkforceForMapping({ field_executive_id: "executive-1" }, workforceIndex)?.id, "workforce-executive");
assert.equal(canonicalWorkforceForMapping({ workforce_id: "workforce-canonical" }, workforceIndex)?.id, "workforce-canonical");
const indexedAttendance = buildReportImportAttendanceByWorkforceDate([
  { id: "absent", employee_id: "employee-1", punch_date: "2026-09-01", status: "A", work_minutes: 0 },
  { id: "half", field_executive_id: "workforce-employee", punch_date: "2026-09-01", status: "HD", in_time: "2026-09-01T03:00:00Z", work_minutes: 240 },
  { id: "contractor", contractor_id: "contractor-1", punch_date: "2026-09-01", status: "P", work_minutes: 480 },
  { id: "canonical", field_executive_id: "workforce-canonical", punch_date: "2026-09-01", status: "P", work_minutes: 480 }
], workforceIndex);
assert.equal(indexedAttendance.get("workforce-employee|2026-09-01")?.id, "half", "canonical app attendance in field_executive_id must win over a weaker legacy row");
assert.equal(indexedAttendance.get("workforce-contractor|2026-09-01")?.id, "contractor");
assert.equal(indexedAttendance.get("workforce-canonical|2026-09-01")?.id, "canonical", "unpopulated attendance_daily.workforce_id must not hide canonical Workforce attendance");

const db = new PGlite();
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;
  create table companies (
    id uuid primary key,
    code text not null,
    name text not null
  );
  create table workforce (
    id uuid primary key,
    company_id uuid not null,
    source_profile_type text,
    source_profile_id uuid,
    biometric_id text,
    deleted_at timestamptz,
    migration_state text,
    created_at timestamptz not null default now()
  );
  create table attendance_daily (
    id uuid primary key,
    company_id uuid not null,
    workforce_id uuid,
    employee_id uuid,
    contractor_id uuid,
    field_executive_id uuid,
    enrolment_id text
  );
  create table payment_fields (
    id uuid primary key,
    company_id uuid not null,
    code text,
    field_type text,
    pay_schedule text,
    calculation_source text,
    calculation_type text,
    provider_calculation_sources jsonb,
    updated_at timestamptz
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
const worker = "00000000-0000-0000-0000-000000000017";
const employee = "00000000-0000-0000-0000-000000000018";
const historicalAttendance = "00000000-0000-0000-0000-000000000019";
const canonicalExecutiveWorker = "00000000-0000-0000-0000-000000000021";
const canonicalExecutiveAttendance = "00000000-0000-0000-0000-000000000022";
const biometricWorker = "00000000-0000-0000-0000-000000000023";
const biometricAttendance = "00000000-0000-0000-0000-000000000024";
const duplicateBiometricWorker = "00000000-0000-0000-0000-000000000027";
await db.query("insert into companies values ($1,'DROPX_LOGISTICS','DROPX LOGISTICS')", [company]);
await db.query("insert into workforce (id,company_id,source_profile_type,source_profile_id) values ($1,$2,'employee',$3)", [worker, company, employee]);
await db.query("insert into workforce (id,company_id,source_profile_type,source_profile_id,biometric_id) values ($1,$2,'field_executive',$3,'00088')", [canonicalExecutiveWorker, company, "00000000-0000-0000-0000-000000000025"]);
await db.query("insert into workforce (id,company_id,source_profile_type,source_profile_id,biometric_id) values ($1,$2,'contractor',$3,'00077')", [biometricWorker, company, "00000000-0000-0000-0000-000000000026"]);
await db.query("insert into workforce (id,company_id,source_profile_type,source_profile_id,biometric_id) values ($1,$2,'contractor',$3,'88')", [duplicateBiometricWorker, company, "00000000-0000-0000-0000-000000000028"]);
await db.query("insert into attendance_daily (id,company_id,employee_id) values ($1,$2,$3)", [historicalAttendance, company, employee]);
await db.query("insert into attendance_daily (id,company_id,field_executive_id,enrolment_id) values ($1,$2,$3,'88')", [canonicalExecutiveAttendance, company, canonicalExecutiveWorker]);
await db.query("insert into attendance_daily (id,company_id,enrolment_id) values ($1,$2,'77')", [biometricAttendance, company]);
await db.query("insert into payment_fields (id,company_id,calculation_source,calculation_type) values ($1,$2,'attendance_eligibility','fixed_monthly')", [field, company]);
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
await db.query("insert into payment_fields (id,company_id,calculation_source,calculation_type) values ($1,$2,'attendance_eligibility','fixed_monthly')", [attendanceField, company]);
await assert.rejects(
  db.query("insert into payment_method_components values ($1,$2,$3,$4,'ATTENDANCE_MONTHLY',true,2)", ["00000000-0000-0000-0000-000000000010", company, method, attendanceField]),
  /Reassign provider ID mappings before adding an attendance field to this payment method/
);
await db.query("update workforce_payment_allocations set note='history stays frozen' where id=$1", [allocation]);
const preserved = await db.query("select payment_components from workforce_payment_allocations where id=$1", [allocation]);
assert.equal(preserved.rows[0].payment_components[0].calculation_source, "attendance_eligibility");

await db.query("update payment_fields set code='FIXED_PAY_PER_MONTH',field_type='amount',pay_schedule='per_month' where id=$1", [field]);
const targetFields = [
  ["00000000-0000-0000-0000-000000000011", "FIXED_PAY_PER_DAY", "per_day"],
  ["00000000-0000-0000-0000-000000000012", "MG_PER_DAY", "per_day"],
  ["00000000-0000-0000-0000-000000000013", "MG_PER_MONTH", "per_month"],
  ["00000000-0000-0000-0000-000000000014", "VAN_RENT_PER_DAY", "per_day"],
  ["00000000-0000-0000-0000-000000000015", "VAN_RENT_PER_MONTH", "per_month"]
];
for (const [id, code, schedule] of targetFields) {
  await db.query("insert into payment_fields (id,company_id,code,field_type,pay_schedule) values ($1,$2,$3,'amount',$4)", [id, company, code, schedule]);
}
await db.query("update payment_fields set provider_calculation_sources='{\"legacy\":\"production\"}'::jsonb where id=$1", [field]);
await db.exec(providerMigration);
const converted = await db.query("select code,calculation_source,calculation_type,provider_calculation_sources from payment_fields where company_id=$1 and code is not null order by code", [company]);
assert.equal(converted.rows.length, 6);
for (const row of converted.rows) {
  assert.equal(row.calculation_source, "attendance_eligibility");
  assert.equal(row.calculation_type, String(row.code).endsWith("_MONTH") ? "fixed_monthly" : "fixed_daily");
  assert.deepEqual(row.provider_calculation_sources, {});
}
const linkedHistoricalAttendance = await db.query("select workforce_id from attendance_daily where id=$1", [historicalAttendance]);
assert.equal(linkedHistoricalAttendance.rows[0].workforce_id, worker, "the migration must link existing source-profile attendance to canonical workforce");
const linkedCanonicalExecutiveAttendance = await db.query("select workforce_id from attendance_daily where id=$1", [canonicalExecutiveAttendance]);
assert.equal(linkedCanonicalExecutiveAttendance.rows[0].workforce_id, canonicalExecutiveWorker, "canonical field_executive_id must outrank an ambiguous biometric fallback");
const linkedBiometricAttendance = await db.query("select workforce_id from attendance_daily where id=$1", [biometricAttendance]);
assert.equal(linkedBiometricAttendance.rows[0].workforce_id, biometricWorker, "biometric-only attendance must resolve leading-zero ID variants");
const futureAttendance = "00000000-0000-0000-0000-000000000020";
await db.query("insert into attendance_daily (id,company_id,employee_id) values ($1,$2,$3)", [futureAttendance, company, employee]);
const linkedFutureAttendance = await db.query("select workforce_id from attendance_daily where id=$1", [futureAttendance]);
assert.equal(linkedFutureAttendance.rows[0].workforce_id, worker, "the trigger must link future source-profile attendance to canonical workforce");
await db.exec(providerMigration);
const rerun = await db.query("select count(*)::int as count from payment_fields where company_id=$1 and code is not null and calculation_source='attendance_eligibility'", [company]);
assert.equal(rerun.rows[0].count, 6, "the production migration must be safe to rerun");
await db.query("insert into field_executive_provider_mappings values ($1,$2,$3,'active')", ["00000000-0000-0000-0000-000000000016", company, method]);
await db.close();

console.log("Direct and provider-linked attendance payment configuration and payout propagation verified.");
