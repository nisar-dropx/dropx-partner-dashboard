import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const companyId = "43866344-b550-4e8a-9a2d-9d23f3d8a997";
const actorId = "00000000-0000-4000-8000-000000000099";
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;
  create schema auth;
  create table auth.users (id uuid primary key);
  create table public.companies (id uuid primary key);
  create table public.workforce_payroll_runs (
    id uuid primary key,
    company_id uuid not null references public.companies(id),
    period_start date not null,
    period_end date not null,
    status text not null,
    calculated_at timestamptz,
    direct_allocation_snapshot_hash text
  );
  create or replace function public.lock_workforce_payment_allocation_company(p_company_id uuid)
  returns void language plpgsql as $$ begin perform p_company_id; end; $$;
  insert into public.companies(id) values ('${companyId}');
  insert into auth.users(id) values ('${actorId}');
`);

for (const migrationName of [
  "20260929150000_workforce_payment_settings.sql",
  "20260929180000_workforce_payment_policy_editability.sql",
  "20260930134308_workforce_attendance_capture_settings.sql"
]) {
  await db.exec(readFileSync(
    new URL(`../supabase/migrations/${migrationName}`, import.meta.url),
    "utf8"
  ));
}

const insertPolicy = ({
  method = "fixed_paid_offs",
  paidOffDays = 4,
  workUnits = 6,
  effectiveFrom,
  reason = "Configure workforce payment"
}) => db.exec(`
  insert into public.workforce_payment_settings(
    company_id,calculation_method,paid_off_days,work_units_per_paid_off,
    cap_at_monthly_amount,effective_from,change_reason
  ) values (
    '${companyId}','${method}',${paidOffDays},${workUnits},true,'${effectiveFrom}','${reason}'
  );
`);

await insertPolicy({ method: "calendar_days", effectiveFrom: "2025-01-01", reason: "Initial calendar policy" });
await insertPolicy({ effectiveFrom: "2025-04-01", reason: "Add fixed paid offs" });
await insertPolicy({ method: "calendar_days", effectiveFrom: "2035-01-01", reason: "Distant future policy" });

await assert.rejects(() => insertPolicy({ method: "unknown", effectiveFrom: "2025-02-01" }));
await assert.rejects(() => insertPolicy({ method: "earned_paid_offs", workUnits: 6.25, effectiveFrom: "2025-02-01" }));
await assert.rejects(() => insertPolicy({ method: "earned_paid_offs", effectiveFrom: "2025-02-02" }));
await assert.rejects(() => insertPolicy({ method: "earned_paid_offs", effectiveFrom: "2025-02-01", reason: "x" }));

// Past, current and distant future dates are all valid while no finalized
// payroll depends on the interval that the policy would control.
await insertPolicy({ method: "earned_paid_offs", effectiveFrom: "2024-01-01", reason: "Open historical month" });
await db.exec(`delete from public.workforce_payment_settings where company_id='${companyId}' and effective_from='2024-01-01'`);

await db.exec(`
  insert into public.workforce_payroll_runs(id,company_id,period_start,period_end,status,calculated_at)
  values
    ('00000000-0000-4000-8000-000000000001','${companyId}','2025-03-01','2025-03-31','approved',clock_timestamp()),
    ('00000000-0000-4000-8000-000000000002','${companyId}','2025-05-01','2025-05-31','paid',clock_timestamp());
`);

await assert.rejects(() => db.exec(`
  update public.workforce_payment_settings
  set paid_off_days=5,change_reason='Attempt finalized March change'
  where company_id='${companyId}' and effective_from='2025-01-01';
`), /finalized payroll/i);
await assert.rejects(() => db.exec(`
  update public.workforce_payment_settings
  set paid_off_days=5,change_reason='Attempt finalized May change'
  where company_id='${companyId}' and effective_from='2025-04-01';
`), /finalized payroll/i);
await assert.rejects(
  () => insertPolicy({ method: "earned_paid_offs", effectiveFrom: "2025-02-01", reason: "Would change finalized March" }),
  /finalized payroll/i
);

const { rows: [marchHashBefore] } = await db.query(`
  select public.workforce_payment_policy_snapshot_hash(
    '${companyId}','2025-03-01','2025-03-31'
  ) as hash
`);
const { rows: [februaryHashBefore] } = await db.query(`
  select public.workforce_payment_policy_snapshot_hash(
    '${companyId}','2025-02-01','2025-02-28'
  ) as hash
`);

// February remains editable even though March is finalized. The save function
// creates a March boundary with the old values before applying February's new
// values, so the finalized March calculation is unchanged.
await db.exec(`
  select public.save_workforce_payment_setting(
    '${companyId}',
    'earned_paid_offs',
    4::smallint,
    5.5::numeric,
    true,
    '2025-02-01',
    'Change only the open February month',
    '${actorId}'
  );
`);
const { rows: preservedPolicies } = await db.query(`
  select calculation_method,work_units_per_paid_off::text as work_units,effective_from::text
  from public.workforce_payment_settings
  where company_id='${companyId}' and effective_from in ('2025-02-01','2025-03-01')
  order by effective_from
`);
assert.deepEqual(preservedPolicies, [
  { calculation_method: "earned_paid_offs", work_units: "5.50", effective_from: "2025-02-01" },
  { calculation_method: "calendar_days", work_units: "6.00", effective_from: "2025-03-01" }
]);
const { rows: [marchHashAfter] } = await db.query(`
  select public.workforce_payment_policy_snapshot_hash(
    '${companyId}','2025-03-01','2025-03-31'
  ) as hash
`);
assert.equal(marchHashAfter.hash, marchHashBefore.hash);
const { rows: [februaryHashAfter] } = await db.query(`
  select public.workforce_payment_policy_snapshot_hash(
    '${companyId}','2025-02-01','2025-02-28'
  ) as hash
`);
assert.notEqual(februaryHashAfter.hash, februaryHashBefore.hash);
await db.exec(`
  update public.workforce_payroll_runs set status='paid'
  where id='00000000-0000-4000-8000-000000000001';
`);
await assert.rejects(() => db.exec(`
  select public.save_workforce_payment_setting(
    '${companyId}','fixed_paid_offs',4::smallint,6::numeric,true,
    '2025-03-01','Attempt to edit finalized March','${actorId}'
  );
`), /this month is finalized/i);

// May is before this new boundary, so the later open interval remains editable.
await insertPolicy({ method: "earned_paid_offs", effectiveFrom: "2025-06-01", reason: "Start open June policy" });
await db.exec(`
  update public.workforce_payment_settings
  set work_units_per_paid_off=5.5,change_reason='Revise open June policy'
  where company_id='${companyId}' and effective_from='2025-06-01';
`);

// A calculated open payroll captures the policy version. A later policy edit is
// allowed, but confirmation must wait for recalculation.
await db.exec(`
  insert into public.workforce_payroll_runs(
    id,company_id,period_start,period_end,status,calculated_at,direct_allocation_snapshot_hash
  ) values (
    '00000000-0000-4000-8000-000000000003','${companyId}',
    '2025-08-01','2025-08-31','draft',clock_timestamp(),'direct-snapshot'
  );
`);
const { rows: [captured] } = await db.query(`
  select workforce_payment_policy_snapshot_hash as hash
  from public.workforce_payroll_runs
  where id='00000000-0000-4000-8000-000000000003'
`);
assert.ok(captured.hash);

await db.exec(`
  update public.workforce_payment_settings
  set work_units_per_paid_off=6,change_reason='Edit before finalization'
  where company_id='${companyId}' and effective_from='2025-06-01';
`);
await assert.rejects(() => db.exec(`
  update public.workforce_payroll_runs set status='review'
  where id='00000000-0000-4000-8000-000000000003';
`), /recalculate/i);

await db.exec(`
  update public.workforce_payroll_runs set calculated_at=clock_timestamp()
  where id='00000000-0000-4000-8000-000000000003';
  update public.workforce_payroll_runs set status='review'
  where id='00000000-0000-4000-8000-000000000003';
  update public.workforce_payroll_runs set status='approved'
  where id='00000000-0000-4000-8000-000000000003';
`);
await assert.rejects(() => db.exec(`
  update public.workforce_payment_settings
  set paid_off_days=5,change_reason='Attempt approved August change'
  where company_id='${companyId}' and effective_from='2025-06-01';
`), /finalized payroll/i);

// Materializing the implicit default as a preservation boundary is not a
// calculation change and therefore must retain the same payroll snapshot.
const defaultCompanyId = "43866344-b550-4e8a-9a2d-9d23f3d8a998";
await db.exec(`insert into public.companies(id) values ('${defaultCompanyId}')`);
const { rows: [implicitDefaultHash] } = await db.query(`
  select public.workforce_payment_policy_snapshot_hash(
    '${defaultCompanyId}','2025-03-01','2025-03-31'
  ) as hash
`);
await db.exec(`
  insert into public.workforce_payment_settings(
    company_id,calculation_method,paid_off_days,work_units_per_paid_off,
    cap_at_monthly_amount,effective_from,change_reason
  ) values (
    '${defaultCompanyId}','calendar_days',4,6,true,'2025-03-01','Materialize implicit default'
  )
`);
const { rows: [materializedDefaultHash] } = await db.query(`
  select public.workforce_payment_policy_snapshot_hash(
    '${defaultCompanyId}','2025-03-01','2025-03-31'
  ) as hash
`);
assert.equal(materializedDefaultHash.hash, implicitDefaultHash.hash);

// A policy after every finalized period is still allowed, with no 24-month cap.
await insertPolicy({ method: "earned_paid_offs", effectiveFrom: "2036-01-01", reason: "Open policy after finalized history" });
await assert.rejects(() => db.exec(`
  update public.workforce_payment_settings
  set effective_from='2025-07-01',change_reason='Attempt move across finalized August'
  where company_id='${companyId}' and effective_from='2036-01-01';
`), /finalized payroll/i);

const attendanceCompanyId = "43866344-b550-4e8a-9a2d-9d23f3d8a996";
await db.exec(`insert into public.companies(id) values ('${attendanceCompanyId}')`);
const { rows: [implicitBiometricHash] } = await db.query(`
  select public.workforce_payment_policy_snapshot_hash(
    '${attendanceCompanyId}','2025-01-01','2025-01-31'
  ) as hash
`);
await db.exec(`
  select public.save_workforce_attendance_capture_setting(
    '${attendanceCompanyId}','biometric',null,'2025-01-01',
    'Materialize default biometric capture','${actorId}'
  )
`);
const { rows: [explicitBiometricHash] } = await db.query(`
  select public.workforce_payment_policy_snapshot_hash(
    '${attendanceCompanyId}','2025-01-01','2025-01-31'
  ) as hash
`);
assert.equal(explicitBiometricHash.hash, implicitBiometricHash.hash);

await assert.rejects(() => db.exec(`
  select public.save_workforce_attendance_capture_setting(
    '${attendanceCompanyId}','biometric',1,'2025-02-01',
    'Biometric cannot keep a shipment threshold','${actorId}'
  )
`), /only to shipment-data/i);
await assert.rejects(() => db.exec(`
  select public.save_workforce_attendance_capture_setting(
    '${attendanceCompanyId}','shipment_data',0,'2025-02-01',
    'Reject a non-positive shipment threshold','${actorId}'
  )
`), /positive daily delivery threshold/i);

const { rows: [februaryBiometricHash] } = await db.query(`
  select public.workforce_payment_policy_snapshot_hash(
    '${attendanceCompanyId}','2025-02-01','2025-02-28'
  ) as hash
`);
await db.exec(`
  insert into public.workforce_payroll_runs(id,company_id,period_start,period_end,status,calculated_at)
  values (
    '00000000-0000-4000-8000-000000000011','${attendanceCompanyId}',
    '2025-03-01','2025-03-31','approved',clock_timestamp()
  )
`);
const { rows: [finalizedMarch] } = await db.query(`
  select workforce_payment_policy_snapshot_hash as hash
  from public.workforce_payroll_runs
  where id='00000000-0000-4000-8000-000000000011'
`);

await db.exec(`
  select public.save_workforce_attendance_capture_setting(
    '${attendanceCompanyId}','shipment_data',10,'2025-02-01',
    'Use an inclusive shipment attendance threshold','${actorId}'
  )
`);
const { rows: captureBoundaries } = await db.query(`
  select capture_method,minimum_daily_deliveries,effective_from::text
  from public.workforce_attendance_capture_settings
  where company_id='${attendanceCompanyId}'
    and effective_from in ('2025-02-01','2025-03-01')
  order by effective_from
`);
assert.deepEqual(captureBoundaries, [
  { capture_method: "shipment_data", minimum_daily_deliveries: 10, effective_from: "2025-02-01" },
  { capture_method: "biometric", minimum_daily_deliveries: null, effective_from: "2025-03-01" }
]);
const { rows: [preservedMarch] } = await db.query(`
  select public.workforce_payment_policy_snapshot_hash(
    '${attendanceCompanyId}','2025-03-01','2025-03-31'
  ) as hash
`);
assert.equal(preservedMarch.hash, finalizedMarch.hash);
const { rows: [shipmentFebruaryHash] } = await db.query(`
  select public.workforce_payment_policy_snapshot_hash(
    '${attendanceCompanyId}','2025-02-01','2025-02-28'
  ) as hash
`);
assert.notEqual(shipmentFebruaryHash.hash, februaryBiometricHash.hash);
await assert.rejects(() => db.exec(`
  select public.save_workforce_attendance_capture_setting(
    '${attendanceCompanyId}','shipment_data',12,'2025-03-01',
    'Attempt to change finalized attendance capture','${actorId}'
  )
`), /this month is finalized/i);

await db.exec(`
  select public.save_workforce_attendance_capture_setting(
    '${attendanceCompanyId}','shipment_data',8,'2025-04-01',
    'Configure April shipment attendance','${actorId}'
  );
  insert into public.workforce_payroll_runs(id,company_id,period_start,period_end,status,calculated_at)
  values (
    '00000000-0000-4000-8000-000000000012','${attendanceCompanyId}',
    '2025-04-01','2025-04-30','draft',clock_timestamp()
  );
  select public.save_workforce_attendance_capture_setting(
    '${attendanceCompanyId}','shipment_data',9,'2025-04-01',
    'Revise April before payroll finalization','${actorId}'
  );
`);
await assert.rejects(() => db.exec(`
  update public.workforce_payroll_runs set status='review'
  where id='00000000-0000-4000-8000-000000000012'
`), /recalculate/i);
await db.exec(`
  update public.workforce_payroll_runs set calculated_at=clock_timestamp()
  where id='00000000-0000-4000-8000-000000000012';
  update public.workforce_payroll_runs set status='review'
  where id='00000000-0000-4000-8000-000000000012';
`);

const { rows: captureAudit } = await db.query(`
  select operation,count(*)::int as count
  from public.workforce_attendance_capture_setting_history
  where company_id='${attendanceCompanyId}'
  group by operation
  order by operation
`);
assert.deepEqual(captureAudit, [
  { operation: "insert", count: 4 },
  { operation: "update", count: 1 }
]);

const { rows: security } = await db.query(`
  select
    (select relrowsecurity from pg_class where oid='public.workforce_payment_settings'::regclass) as rls_enabled,
    has_table_privilege('anon','public.workforce_payment_settings','select') as anon_select,
    has_table_privilege('authenticated','public.workforce_payment_settings','select') as authenticated_select,
    has_table_privilege('service_role','public.workforce_payment_settings','select') as service_select,
    has_table_privilege('service_role','public.workforce_payment_settings','insert') as service_insert,
    has_table_privilege('service_role','public.workforce_payment_settings','update') as service_update,
    has_function_privilege(
      'public',
      'public.save_workforce_payment_setting(uuid,text,smallint,numeric,boolean,date,text,uuid)',
      'execute'
    ) as public_save_execute,
    has_function_privilege(
      'anon',
      'public.save_workforce_payment_setting(uuid,text,smallint,numeric,boolean,date,text,uuid)',
      'execute'
    ) as anon_save_execute,
    has_function_privilege(
      'authenticated',
      'public.save_workforce_payment_setting(uuid,text,smallint,numeric,boolean,date,text,uuid)',
      'execute'
    ) as authenticated_save_execute,
    has_function_privilege(
      'service_role',
      'public.save_workforce_payment_setting(uuid,text,smallint,numeric,boolean,date,text,uuid)',
      'execute'
    ) as service_save_execute;
`);
assert.deepEqual(security[0], {
  rls_enabled: true,
  anon_select: false,
  authenticated_select: false,
  service_select: true,
  service_insert: true,
  service_update: true,
  public_save_execute: false,
  anon_save_execute: false,
  authenticated_save_execute: false,
  service_save_execute: true
});

const { rows: [captureSecurity] } = await db.query(`
  select
    (select relrowsecurity from pg_class where oid='public.workforce_attendance_capture_settings'::regclass) as settings_rls,
    (select relrowsecurity from pg_class where oid='public.workforce_attendance_capture_setting_history'::regclass) as history_rls,
    has_table_privilege('anon','public.workforce_attendance_capture_settings','select') as anon_select,
    has_table_privilege('authenticated','public.workforce_attendance_capture_settings','select') as authenticated_select,
    has_table_privilege('service_role','public.workforce_attendance_capture_settings','select') as service_select,
    has_table_privilege('service_role','public.workforce_attendance_capture_settings','insert') as service_insert,
    has_table_privilege('service_role','public.workforce_attendance_capture_settings','update') as service_update,
    has_function_privilege(
      'public',
      'public.save_workforce_attendance_capture_setting(uuid,text,integer,date,text,uuid)',
      'execute'
    ) as public_save_execute,
    has_function_privilege(
      'service_role',
      'public.save_workforce_attendance_capture_setting(uuid,text,integer,date,text,uuid)',
      'execute'
    ) as service_save_execute
`);
assert.deepEqual(captureSecurity, {
  settings_rls: true,
  history_rls: true,
  anon_select: false,
  authenticated_select: false,
  service_select: true,
  service_insert: true,
  service_update: true,
  public_save_execute: false,
  service_save_execute: true
});

const pageSource = readFileSync(
  new URL("../src/app/settings/workforce-payment/payout-method/page.tsx", import.meta.url),
  "utf8"
);
const formSource = readFileSync(
  new URL("../src/app/settings/workforce-payment/payout-method/policy-form.tsx", import.meta.url),
  "utf8"
);
const formStyles = readFileSync(
  new URL("../src/app/settings/workforce-payment/payout-method/policy-form.module.css", import.meta.url),
  "utf8"
);
assert.doesNotMatch(pageSource, /₹18,000 example|30-day month/i);
assert.doesNotMatch(formSource, /24 months|Next month through/i);
assert.match(formSource, /Applies from the selected month until another policy takes effect/);
assert.match(formSource, /disabled=\{formDisabled \|\| !fields\.workUnitsPerPaidOff\}/);
assert.match(formSource, /disabled=\{formDisabled \|\| !fields\.paidOffDays\}/);
assert.match(formSource, /className=\{`\$\{styles\.form\} form-grid two`\}/);
assert.match(formSource, /\[isEditing, setIsEditing\] = useState\(false\)/);
assert.match(formSource, /const formDisabled = !canEdit \|\| !isEditing \|\| isSubmitting \|\| locked/);
assert.match(formSource, /disabled=\{!canEdit \|\| !isEditing \|\| isSubmitting\}/);
assert.match(formSource, /setEffectiveMonth\(currentMonth\)[\s\S]*formRef\.current\?\.reset\(\)[\s\S]*setIsEditing\(false\)/);
assert.match(formSource, /isEditing \? \([\s\S]*Cancel editing[\s\S]*\) : \([\s\S]*>Edit<\/button>/);
assert.match(formSource, /\{isEditing \? \([\s\S]*Save workforce payment policy[\s\S]*\) : null\}/);
assert.match(formSource, /useFormStatus\(\)/);
assert.match(formSource, /disabled=\{isSubmitting\} onClick=\{cancelEditing\}/);
assert.match(pageSource, /key=\{formRevision\}/);
assert.match(formStyles, /\.form input:disabled,/);
assert.match(formStyles, /\.form select:disabled/);
assert.match(formStyles, /background: #eef1f5/);
assert.match(formStyles, /cursor: not-allowed/);
assert.match(formStyles, /opacity: 1/);
const actionSource = readFileSync(
  new URL("../src/app/settings/workforce-payment/payout-method/actions.ts", import.meta.url),
  "utf8"
);
assert.match(actionSource, /rpc\("save_workforce_payment_setting"/);
assert.match(actionSource, /redirect\("\/settings\/workforce-payment\/payout-method"\)/);

const hubSource = readFileSync(
  new URL("../src/app/settings/workforce-payment/page.tsx", import.meta.url),
  "utf8"
);
assert.match(hubSource, /requirePagePermission\("payment_settings", "access"\)/);
assert.match(hubSource, /href="\/settings\/workforce-payment\/payout-method"/);
assert.match(hubSource, /href="\/settings\/workforce-payment\/attendance-capture"/);
const settingsPageSource = readFileSync(
  new URL("../src/app/settings/page.tsx", import.meta.url),
  "utf8"
);
assert.match(settingsPageSource, /Configure attendance capture and attendance-based monthly payout rules/);

const attendancePageSource = readFileSync(
  new URL("../src/app/settings/workforce-payment/attendance-capture/page.tsx", import.meta.url),
  "utf8"
);
const attendanceFormSource = readFileSync(
  new URL("../src/app/settings/workforce-payment/attendance-capture/attendance-capture-form.tsx", import.meta.url),
  "utf8"
);
const attendanceFormStyles = readFileSync(
  new URL("../src/app/settings/workforce-payment/attendance-capture/attendance-capture-form.module.css", import.meta.url),
  "utf8"
);
const attendanceActionSource = readFileSync(
  new URL("../src/app/settings/workforce-payment/attendance-capture/actions.ts", import.meta.url),
  "utf8"
);
assert.match(attendancePageSource, /from\("workforce_attendance_capture_settings"\)/);
assert.match(attendancePageSource, /requirePagePermission\("payment_settings", "access"\)/);
assert.match(attendanceFormSource, /disabled=\{formDisabled \|\| !usesShipmentData\}/);
assert.match(attendanceFormSource, /workforcePaymentMonthIsFinalized/);
assert.match(attendanceFormSource, /disabledText=\{!canEdit \? "View only" : "Month locked"\}/);
assert.match(attendanceFormSource, /\[isEditing, setIsEditing\] = useState\(false\)/);
assert.match(attendanceFormSource, /const formDisabled = !canEdit \|\| !isEditing \|\| isSubmitting \|\| locked/);
assert.match(attendanceFormSource, /disabled=\{!canEdit \|\| !isEditing \|\| isSubmitting\}/);
assert.match(attendanceFormSource, /setEffectiveMonth\(currentMonth\)[\s\S]*formRef\.current\?\.reset\(\)[\s\S]*setIsEditing\(false\)/);
assert.match(attendanceFormSource, /isEditing \? \([\s\S]*Cancel editing[\s\S]*\) : \([\s\S]*>Edit<\/button>/);
assert.match(attendanceFormSource, /\{isEditing \? \([\s\S]*Save attendance capture policy[\s\S]*\) : null\}/);
assert.match(attendanceFormSource, /useFormStatus\(\)/);
assert.match(attendanceFormSource, /disabled=\{isSubmitting\} onClick=\{cancelEditing\}/);
assert.match(attendancePageSource, /key=\{formRevision\}/);
assert.match(attendanceFormSource, /name="minimum_daily_deliveries"/);
assert.match(attendanceFormSource, /type="month"/);
assert.match(attendanceFormStyles, /\.threshold:disabled[\s\S]*background: #e4e7ec/);
assert.match(attendanceActionSource, /rpc\("save_workforce_attendance_capture_setting_v2"/);
assert.match(attendanceActionSource, /p_capture_method: captureMethod/);
assert.match(attendanceActionSource, /p_minimum_daily_deliveries: minimumDailyDeliveries/);
assert.match(attendanceActionSource, /p_effective_from: `\$\{effectiveMonth\}-01`/);

console.log("Workforce payment routing, attendance capture scaffold, month editability, finalized-boundary preservation, recalculation snapshot and conditional forms verified.");
