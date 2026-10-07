import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const migrationsUrl = new URL("../supabase/migrations/", import.meta.url);
const advanceMigrationFiles = readdirSync(migrationsUrl)
  .filter((name) => /^202610071\d+_workforce_advance.*\.sql$/i.test(name))
  .sort();
const migration = advanceMigrationFiles
  .map((name) => readFileSync(new URL(name, migrationsUrl), "utf8"))
  .join("\n")
  .replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");
const hardeningMigration = readFileSync(
  new URL("20261007110000_workforce_advance_recovery_hardening.sql", migrationsUrl),
  "utf8"
);
const finalSafetyMigration = readFileSync(
  new URL("20261007112000_workforce_advance_recovery_overlap_lock_order.sql", migrationsUrl),
  "utf8"
);
const pendingIdentityMigration = readFileSync(
  new URL("20261007160000_workforce_advance_pending_identity_link.sql", migrationsUrl),
  "utf8"
);

assert.match(migration, /create table public\.workforce_advance_import_batches/i);
assert.match(migration, /create table public\.workforce_advances/i);
assert.match(migration, /create table public\.workforce_advance_recoveries/i);
assert.match(migration, /create or replace function public\.workforce_apply_advance_import/i);
assert.match(migration, /create or replace function public\.workforce_apply_advance_recoveries/i);
assert.match(migration, /create or replace function public\.workforce_advance_recovery_snapshot_hash/i);
assert.match(migration, /p_allowed_location_ids uuid\[\] default null/i);
assert.match(migration, /perform public\.lock_workforce_payment_allocation_company\(p_company_id\)/i);
assert.match(migration, /'payout_inputs',\s*public\.workforce_payout_input_snapshot_hash\(/i);
assert.match(migration, /'direct_allocations',\s*public\.workforce_payment_allocation_snapshot_hash\(/i);
assert.match(migration, /'payment_policy',\s*public\.workforce_payment_policy_snapshot_hash\(/i);
assert.match(migration, /'provider_mappings',\s*\([\s\S]*?from public\.field_executive_provider_mappings/i);
assert.match(migration, /item->>'snapshot_hash'/i);
assert.match(migration, /v_current_snapshot_hash := public\.workforce_advance_recovery_snapshot_hash\(/i);
assert.match(migration, /v_legacy_code := 'LEGACY_ADVANCE_'/i);
assert.match(migration, /set code = v_legacy_code,[\s\S]*?name = 'Legacy Advance',[\s\S]*?is_system = false/i);
assert.ok(
  (migration.match(/workforce\.migration_state is distinct from 'reclassified'/gi) ?? []).length >= 3,
  "manual inserts, imports, and recoveries must all reject reclassified Workforce rows"
);
assert.match(
  migration,
  /create or replace function public\.prepare_workforce_advance\(\)[\s\S]*?where workforce\.company_id = new\.company_id[\s\S]*?workforce\.id = new\.workforce_id[\s\S]*?workforce\.location_id = new\.station_id[\s\S]*?workforce\.deleted_at is null[\s\S]*?workforce\.migration_state is distinct from 'reclassified'[\s\S]*?for update;[\s\S]*?Advance location must be the canonical Workforce member''s current location[\s\S]*?create trigger workforce_advances_00_prepare[\s\S]*?before insert or update on public\.workforce_advances[\s\S]*?execute function public\.prepare_workforce_advance\(\)/i
);
assert.match(
  migration,
  /create or replace function public\.workforce_apply_advance_import[\s\S]*?workforce\.location_id = v_station_id[\s\S]*?workforce\.migration_state is distinct from 'reclassified'[\s\S]*?for update;[\s\S]*?canonical Workforce member at its current location/i
);
assert.match(migration, /advance\.advance_date, advance\.created_at, advance\.id/i);
assert.match(migration, /source_type = 'bulk_import'.*upper\(btrim\(v_head\.code\)\) = 'ADVANCE'/is);
assert.match(migration, /create or replace function public\.guard_workforce_advance_payout_import_row/i);
assert.match(migration, /cannot be bulk uploaded or cleared as a manual deduction/i);
assert.match(migration, /alter table public\.workforce_advance_import_batches enable row level security/i);
assert.match(migration, /alter table public\.workforce_advances enable row level security/i);
assert.match(migration, /alter table public\.workforce_advance_recoveries enable row level security/i);
assert.match(migration, /'workforce_advances', 'Workforce Advance Register'/i);
assert.match(migration, /'ops_workforce_advances', 'Workforce Advance Register'/i);
assert.match(migration, /v_deducted_amount\s*:=\s*coalesce/i);
assert.match(migration, /v_business_key\s*:=\s*'WAI1-'\s*\|\|\s*md5/i);
assert.match(migration, /insert into public\.workforce_advance_recoveries\([\s\S]*?'opening_balance'/i);
assert.match(migration, /duplicates an advance already in the register/i);
assert.match(hardeningMigration, /create table public\.workforce_payout_dependency_revisions/i);
assert.match(hardeningMigration, /if v_plan_is_identical then[\s\S]*?continue;/i);
assert.match(hardeningMigration, /Later ADVANCE deductions already exist/i);
assert.ok(
  (hardeningMigration.match(/v_current_snapshot_hash := public\.workforce_advance_recovery_snapshot_hash\(/gi) ?? []).length >= 2,
  "recovery must recheck the dependency revision before mutation and before return"
);
assert.match(
  finalSafetyMigration,
  /create or replace function public\.workforce_apply_advance_import[\s\S]*?order by workforce\.id[\s\S]*?for update;[\s\S]*?perform public\.lock_workforce_payment_allocation_company\(p_company_id\)/i,
  "imports must lock canonical Workforce rows deterministically before taking the company mutex"
);
assert.match(
  finalSafetyMigration,
  /daterange\(recovery\.period_start, recovery\.period_end, '\[\]'\)[\s\S]*?&& daterange\(p_period_start, p_period_end, '\[\]'\)[\s\S]*?<> \(p_period_start, p_period_end\)/i,
  "non-exact overlapping payout periods must be rejected"
);
assert.match(
  finalSafetyMigration,
  /recovery\.recovery_type = 'opening_balance'[\s\S]*?recovery\.recovery_type = 'payout'[\s\S]*?recovery\.period_end < p_period_start/i,
  "opening balances must always reduce pending while payout recoveries remain period-aware"
);
assert.match(
  finalSafetyMigration,
  /if v_plan_is_identical then[\s\S]*?continue;[\s\S]*?recovery\.period_start > p_period_end/i,
  "an identical exact-period retry must no-op before the later-period guard"
);
assert.match(pendingIdentityMigration, /add column imported_dropx_id text/i);
assert.match(pendingIdentityMigration, /add column link_status text not null default 'linked'/i);
assert.match(pendingIdentityMigration, /add column opening_deducted_amount numeric\(18,2\)/i);
assert.match(pendingIdentityMigration, /alter column workforce_id drop not null/i);
assert.match(pendingIdentityMigration, /alter column station_id drop not null/i);
assert.match(pendingIdentityMigration, /link_status = 'pending'[\s\S]*?workforce_id is null[\s\S]*?station_id is null/i);
assert.match(pendingIdentityMigration, /public\.normalize_people_dropx_id\(requested\.item->>'dropx_id'\)/i);
assert.match(
  pendingIdentityMigration,
  /pg_advisory_xact_lock\([\s\S]*?hashtextextended\(v_lock_key, 0\)[\s\S]*?perform public\.lock_workforce_payment_allocation_company\(p_company_id\)/i,
  "imports must take sorted global DropX identity locks before the company allocation lock"
);
assert.match(pendingIdentityMigration, /is unregistered and cannot be imported without all-location access/i);
assert.match(pendingIdentityMigration, /create trigger workforce_advance_pending_identity_link/i);
assert.match(pendingIdentityMigration, /create trigger workforce_advances_10_materialize_opening_recovery/i);
assert.match(pendingIdentityMigration, /'opening-balance:' \|\| new\.id::text/i);
assert.match(pendingIdentityMigration, /'WAI2-' \|\| pg_catalog\.md5/i);
assert.match(pendingIdentityMigration, /WAI1 and WAI2 references are reserved/i);

const db = new PGlite();
const id = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const company = id(1);
const actor = id(2);
const station = id(3);
const otherStation = id(4);
const worker = id(5);
const loanHead = id(6);
const legacyBatch = id(7);
const legacyRow = id(8);
const payrollRun = id(9);
const legacyAdvanceHead = id(10);
const reclassifiedWorker = id(11);
const providerMapping = id(12);
const openingBalanceWorker = id(21);
const laterAdvance = id(22);
const pendingWorker = id(23);

await db.exec(`
  create schema if not exists auth;
  create role anon;
  create role authenticated;
  create role service_role;

  create table auth.users (id uuid primary key);
  create table public.companies (
    id uuid primary key
  );
  create table public.stations (
    id uuid primary key,
    company_id uuid not null references public.companies(id),
    station_code text,
    unique (company_id, id)
  );
  create table public.workforce (
    id uuid primary key,
    company_id uuid not null references public.companies(id),
    dropx_id text,
    full_name text,
    location_id uuid,
    source_profile_type text,
    source_profile_id uuid,
    deleted_at timestamptz,
    migration_state text,
    unique (company_id, id)
  );
  create table public.field_executive_provider_mappings (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null,
    provider_member_id text,
    provider_id uuid,
    workforce_id uuid,
    employee_id uuid,
    contractor_id uuid,
    field_executive_id uuid,
    station_id uuid,
    payment_method_id uuid,
    payment_values jsonb,
    production_threshold_config jsonb,
    effective_from date not null,
    effective_to date,
    status text not null default 'active'
  );
  create table public.workforce_payment_allocations (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null,
    workforce_id uuid not null,
    station_id uuid,
    effective_from date not null,
    effective_to date,
    status text not null default 'active'
  );
  create table public.workforce_deduction_heads (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null references public.companies(id),
    code text not null,
    name text not null,
    description text,
    calculation_type text not null default 'fixed',
    default_value numeric(14,2) not null default 0,
    percentage_without_pan numeric(5,2) not null default 0,
    workforce_category_codes text[] not null default '{}'::text[],
    applies_to_all boolean not null default false,
    is_system boolean not null default false,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (company_id, code),
    unique (company_id, id)
  );
  create table public.workforce_payout_import_batches (
    id uuid primary key,
    company_id uuid not null references public.companies(id)
  );
  create table public.workforce_payout_import_rows (
    id uuid primary key,
    company_id uuid not null references public.companies(id),
    batch_id uuid not null references public.workforce_payout_import_batches(id),
    input_type text,
    deduction_head_id uuid
  );
  create table public.workforce_payroll_runs (
    id uuid primary key,
    company_id uuid not null references public.companies(id),
    period_start date not null,
    period_end date not null,
    status text
  );
  create table public.app_pages (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null references public.companies(id),
    code text not null,
    name text not null,
    sort_order integer not null default 0,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (company_id, code)
  );

  -- Minimal payout-loader dependencies used to verify the hardening migration's
  -- exhaustive company-revision triggers. The production tables have richer
  -- schemas; only company identity is needed by these statement triggers.
  create table public.location_models (id uuid primary key, company_id uuid not null);
  create table public.payment_field_provider_metrics (id uuid primary key, company_id uuid not null);
  create table public.provider_production_metrics (id uuid primary key, company_id uuid not null);
  create table public.workforce_payment_settings (id uuid primary key, company_id uuid not null);
  create table public.workforce_attendance_capture_settings (id uuid primary key, company_id uuid not null);
  create table public.cps_shipment_daily (id uuid primary key, company_id uuid not null);
  create table public.contractors (
    id uuid primary key, company_id uuid not null, full_name text, dropx_id text
  );
  create table public.employees (
    id uuid primary key, company_id uuid not null, full_name text, employee_code text
  );
  create table public.helpers (
    id uuid primary key, company_id uuid not null, full_name text, dropx_id text
  );
  create table public.vendors (
    id uuid primary key, company_id uuid not null, full_name text, dropx_id text
  );
  create table public.workforce_helpers (
    id uuid primary key, company_id uuid not null, full_name text, dropx_id text
  );
  create table public.workforce_pickers (
    id uuid primary key, company_id uuid not null, full_name text, dropx_id text
  );
  create table public.connect_profile_verifications (id uuid primary key, company_id uuid not null);
  create table public.payment_method_components (id uuid primary key, company_id uuid not null);
  create table public.payment_methods (id uuid primary key, company_id uuid not null);
  create table public.payment_fields (id uuid primary key, company_id uuid not null);
  create table public.workforce_payout_attendance_overrides (id uuid primary key, company_id uuid not null);
  create table public.workforce_payout_attendance_values (id uuid primary key, company_id uuid not null);
  create table public.workforce_payment_field_overrides (id uuid primary key, company_id uuid not null);
  create table public.workforce_custom_production_inputs (id uuid primary key, company_id uuid not null);
  create table public.attendance_daily (id uuid primary key, company_id uuid not null);
  create table public.workforce_additional_payment_fields (id uuid primary key, company_id uuid not null);
  create table public.workforce_additional_payment_values (id uuid primary key, company_id uuid not null);
  create table public.providers (id uuid primary key, company_id uuid not null);
  create table public.designations (id uuid primary key, company_id uuid not null);

  create or replace function public.normalize_people_dropx_id(p_value text)
  returns text language sql immutable parallel safe returns null on null input
  set search_path = '' as $$
    select nullif(
      regexp_replace(upper(btrim(p_value)), '[[:space:]]+', '', 'g'),
      ''
    )
  $$;

  create table public.verifier_workforce_snapshot_state (
    company_id uuid primary key references public.companies(id),
    payout_inputs text not null,
    direct_allocations text not null,
    payment_policy text not null
  );

  create table public.workforce_payout_deduction_values (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null references public.companies(id),
    deduction_head_id uuid not null,
    workforce_id uuid not null,
    station_id uuid not null,
    head_code_snapshot text not null,
    head_name_snapshot text not null,
    effective_from date not null,
    effective_to date not null,
    amount numeric(18,2) not null check (amount >= 0),
    source_type text not null default 'bulk_import',
    source_batch_id uuid not null references public.workforce_payout_import_batches(id),
    source_row_id uuid not null references public.workforce_payout_import_rows(id),
    import_metadata jsonb not null default '{}'::jsonb,
    created_by uuid references auth.users(id),
    updated_by uuid references auth.users(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint workforce_payout_deduction_values_head_company_fk
      foreign key (company_id, deduction_head_id)
      references public.workforce_deduction_heads(company_id, id),
    constraint workforce_payout_deduction_values_workforce_company_fk
      foreign key (company_id, workforce_id)
      references public.workforce(company_id, id),
    constraint workforce_payout_deduction_values_station_company_fk
      foreign key (company_id, station_id)
      references public.stations(company_id, id),
    constraint workforce_payout_deduction_values_exact_period_unique
      unique (company_id, deduction_head_id, workforce_id, effective_from, effective_to),
    constraint workforce_payout_deduction_values_source_check
      check (source_type = 'bulk_import')
  );

  create or replace function public.workforce_additional_payment_location_is_authorized(
    p_company_id uuid,
    p_workforce_id uuid,
    p_station_id uuid,
    p_effective_from date,
    p_effective_to date
  ) returns boolean
  language sql stable security definer set search_path = ''
  as $$
    select exists (
      select 1
      from public.workforce workforce
      where workforce.company_id = p_company_id
        and workforce.id = p_workforce_id
        and p_station_id is not null
        and p_effective_from is not null
        and p_effective_to >= p_effective_from
        and (
          workforce.location_id = p_station_id
          or exists (
            select 1
            from public.field_executive_provider_mappings mapping
            where mapping.company_id = p_company_id
              and mapping.workforce_id = workforce.id
              and mapping.station_id = p_station_id
              and mapping.status <> 'cancelled'
              and mapping.effective_from <= p_effective_to
              and (mapping.effective_to is null or mapping.effective_to >= p_effective_from)
          )
        )
    )
  $$;

  create or replace function public.prepare_workforce_payout_deduction_value()
  returns trigger language plpgsql security definer set search_path = '' as $$
  begin
    new.updated_at := clock_timestamp();
    return new;
  end
  $$;

  create or replace function public.guard_finalized_workforce_payout_input()
  returns trigger language plpgsql security definer set search_path = '' as $$
  declare
    v_company_id uuid := case when tg_op = 'DELETE' then old.company_id else new.company_id end;
    v_from date := case when tg_op = 'DELETE' then old.effective_from else new.effective_from end;
    v_to date := case when tg_op = 'DELETE' then old.effective_to else new.effective_to end;
  begin
    if exists (
      select 1
      from public.workforce_payroll_runs payroll_run
      where payroll_run.company_id = v_company_id
        and lower(coalesce(payroll_run.status, '')) in ('approved', 'paid')
        and daterange(payroll_run.period_start, payroll_run.period_end, '[]')
          && daterange(v_from, v_to, '[]')
    ) then
      raise exception 'Workforce payout input cannot change because the affected period is approved or paid.';
    end if;
    if tg_op = 'DELETE' then return old; end if;
    new.updated_at := clock_timestamp();
    return new;
  end
  $$;

  create or replace function public.lock_workforce_payment_allocation_company(
    p_company_id uuid
  ) returns void language plpgsql security definer set search_path = '' as $$
  begin
    return;
  end
  $$;

  create or replace function public.workforce_payout_input_snapshot_hash(
    p_company_id uuid,
    p_period_start date,
    p_period_end date
  ) returns text language sql stable security definer set search_path = '' as $$
    select state.payout_inputs
    from public.verifier_workforce_snapshot_state state
    where state.company_id = p_company_id
  $$;

  create or replace function public.workforce_payment_allocation_snapshot_hash(
    p_company_id uuid,
    p_period_start date,
    p_period_end date
  ) returns text language sql stable security definer set search_path = '' as $$
    select state.direct_allocations
    from public.verifier_workforce_snapshot_state state
    where state.company_id = p_company_id
  $$;

  create or replace function public.workforce_payment_policy_snapshot_hash(
    p_company_id uuid,
    p_period_start date,
    p_period_end date
  ) returns text language sql stable security definer set search_path = '' as $$
    select state.payment_policy
    from public.verifier_workforce_snapshot_state state
    where state.company_id = p_company_id
  $$;

  create trigger workforce_payout_deduction_values_00_prepare
  before insert or update on public.workforce_payout_deduction_values
  for each row execute function public.prepare_workforce_payout_deduction_value();
  create trigger workforce_payout_deduction_values_01_finalized_guard
  before insert or update or delete on public.workforce_payout_deduction_values
  for each row execute function public.guard_finalized_workforce_payout_input();

  insert into auth.users(id) values ('${actor}');
  insert into public.companies(id) values ('${company}');
  insert into public.verifier_workforce_snapshot_state(
    company_id, payout_inputs, direct_allocations, payment_policy
  ) values ('${company}', 'inputs-v1', 'allocations-v1', 'policy-v1');
  insert into public.stations(id, company_id, station_code) values
    ('${station}', '${company}', 'ST1'),
    ('${otherStation}', '${company}', 'ST2');
  insert into public.workforce(id, company_id, dropx_id, full_name, location_id, migration_state)
  values
    ('${worker}', '${company}', 'DX1001', 'Advance Worker', '${station}', null),
    ('${reclassifiedWorker}', '${company}', 'DX-OLD', 'Reclassified Worker', '${station}', 'reclassified'),
    ('${openingBalanceWorker}', '${company}', 'DX-OPENING', 'Opening Balance Worker', '${station}', null);
  insert into public.workforce_deduction_heads(
    id, company_id, code, name, calculation_type, is_system, is_active
  ) values
    ('${loanHead}', '${company}', 'LOAN', 'Loan', 'manual', false, true),
    ('${legacyAdvanceHead}', '${company}', 'ADVANCE', 'Advance', 'manual', false, true);
  insert into public.workforce_payout_import_batches(id, company_id)
  values ('${legacyBatch}', '${company}');
  insert into public.workforce_payout_import_rows(id, company_id, batch_id)
  values ('${legacyRow}', '${company}', '${legacyBatch}');
  insert into public.workforce_payout_deduction_values(
    company_id, deduction_head_id, workforce_id, station_id,
    head_code_snapshot, head_name_snapshot, effective_from, effective_to,
    amount, source_type, source_batch_id, source_row_id, created_by, updated_by
  ) values (
    '${company}', '${legacyAdvanceHead}', '${worker}', '${station}',
    'ADVANCE', 'Advance', '2025-12-01', '2025-12-31',
    25, 'bulk_import', '${legacyBatch}', '${legacyRow}', '${actor}', '${actor}'
  );
`);

await db.exec(migration);

const pageCodes = await db.query(`
  select code from public.app_pages where company_id=$1 order by code
`, [company]);
assert.deepEqual(pageCodes.rows.map((row) => row.code), ["ops_workforce_advances", "workforce_advances"]);

const head = await db.query(`
  select id, calculation_type, is_system, is_active
  from public.workforce_deduction_heads
  where company_id=$1 and code='ADVANCE'
`, [company]);
assert.equal(head.rows.length, 1);
assert.deepEqual(
  {
    calculation_type: head.rows[0].calculation_type,
    is_system: head.rows[0].is_system,
    is_active: head.rows[0].is_active
  },
  { calculation_type: "manual", is_system: true, is_active: true }
);
const advanceHead = head.rows[0].id;

const legacyAdvance = await db.query(`
  select head.code, head.name, head.is_system, value.amount::numeric amount
  from public.workforce_deduction_heads head
  join public.workforce_payout_deduction_values value
    on value.company_id=head.company_id and value.deduction_head_id=head.id
  where head.id=$1
`, [legacyAdvanceHead]);
assert.equal(legacyAdvance.rows.length, 1);
assert.match(legacyAdvance.rows[0].code, /^LEGACY_ADVANCE_[0-9A-F]{8}$/);
assert.deepEqual(
  {
    name: legacyAdvance.rows[0].name,
    is_system: legacyAdvance.rows[0].is_system,
    amount: legacyAdvance.rows[0].amount
  },
  { name: "Legacy Advance", is_system: false, amount: "25.00" },
  "a previously used manual ADVANCE head must be preserved under a non-system legacy code"
);
await db.query(`
  update public.workforce_payout_deduction_values
  set amount=30
  where deduction_head_id=$1
`, [legacyAdvanceHead]);
const editedLegacyAdvance = await db.query(`
  select amount::numeric amount
  from public.workforce_payout_deduction_values
  where deduction_head_id=$1
`, [legacyAdvanceHead]);
assert.equal(editedLegacyAdvance.rows[0].amount, "30.00",
  "renamed legacy deductions must remain editable as ordinary manual deductions");

await assert.rejects(
  db.query(`
    update public.workforce_deduction_heads
    set is_active=false
    where id=$1
  `, [advanceHead]),
  /managed by the Workforce Advance Register/i,
  "the system-managed ADVANCE head must remain active and immutable"
);

const recoverySnapshot = async (from = "2026-01-01", to = "2026-01-31") => {
  const result = await db.query(`
    select public.workforce_advance_recovery_snapshot_hash($1::uuid,$2::date,$3::date) snapshot_hash
  `, [company, from, to]);
  return result.rows[0].snapshot_hash;
};

const baseRecoverySnapshot = await recoverySnapshot();
await db.query(`
  insert into public.payment_fields(id, company_id) values ($1,$2)
`, [id(29), company]);
const insertedDependencySnapshot = await recoverySnapshot();
assert.notEqual(insertedDependencySnapshot, baseRecoverySnapshot,
  "inserting a payout-loader dependency must advance the recovery revision");

await db.query(`update public.payment_fields set id=id where id=$1`, [id(29)]);
const updatedDependencySnapshot = await recoverySnapshot();
assert.notEqual(updatedDependencySnapshot, insertedDependencySnapshot,
  "updating a payout-loader dependency must advance the recovery revision");

await db.query(`delete from public.payment_fields where id=$1`, [id(29)]);
const deletedDependencySnapshot = await recoverySnapshot();
assert.notEqual(deletedDependencySnapshot, updatedDependencySnapshot,
  "deleting a payout-loader dependency must advance the recovery revision");

await db.query(`
  insert into public.field_executive_provider_mappings(
    id, company_id, provider_member_id, provider_id, workforce_id, station_id,
    payment_method_id, payment_values, production_threshold_config,
    effective_from, effective_to, status
  ) values (
    $1,$2,'PROVIDER-1001',$3,$4,$5,$6,'{"rate":100}'::jsonb,
    '{"enabled":true}'::jsonb,'2026-01-01',null,'active'
  )
`, [providerMapping, company, id(30), worker, station, id(31)]);
const recoverySnapshotHash = await recoverySnapshot();
assert.notEqual(recoverySnapshotHash, deletedDependencySnapshot,
  "provider mapping changes must invalidate the advance recovery snapshot");

const importRows = [
  {
    row_number: 2,
    workforce_id: worker,
    station_id: station,
    advance_date: "2026-01-05",
    amount: 100,
    payment_mode: "bank_transfer",
    payment_reference: "BANK-001",
    external_reference: "OPEN-001",
    remark: "Opening advance 1"
  },
  {
    row_number: 3,
    workforce_id: worker,
    station_id: station,
    advance_date: "2026-01-10",
    amount: 80,
    payment_mode: "cash",
    payment_reference: null,
    external_reference: "OPEN-002",
    remark: "Opening advance 2"
  }
];

const applyImport = (hash, rows = importRows, allowed = [station]) => db.query(`
  select public.workforce_apply_advance_import(
    $1::uuid, 'opening-advances.xlsx', $2, $3::jsonb, $4::uuid, $5::uuid[]
  ) as batch_id
`, [company, hash, JSON.stringify(rows), actor, allowed]);

const imported = await applyImport("a".repeat(64));
assert.equal(imported.rows.length, 1);
const importedBatch = imported.rows[0].batch_id;
const importCounts = await db.query(`
  select
    (select count(*)::int from public.workforce_advance_import_batches) batches,
    (select count(*)::int from public.workforce_advances) advances,
    (select coalesce(sum(amount),0)::numeric from public.workforce_advances) total
`);
assert.deepEqual(importCounts.rows[0], { batches: 1, advances: 2, total: "180.00" });
const importedBusinessKey = await db.query(`
  select external_reference
  from public.workforce_advances
  where payment_reference='BANK-001'
`);
assert.equal(
  importedBusinessKey.rows[0].external_reference,
  `WAI2-${createHash("md5").update("v2|DX1001|reference|bank-001").digest("hex")}`,
  "the database and upload preview must derive the same stable reference key"
);

const repeated = await applyImport("a".repeat(64), [{ ...importRows[0], amount: 999 }]);
assert.equal(repeated.rows[0].batch_id, importedBatch, "the same workbook fingerprint must return its first batch");
const repeatedCounts = await db.query(`
  select count(*)::int advances, sum(amount)::numeric total from public.workforce_advances
`);
assert.deepEqual(repeatedCounts.rows[0], { advances: 2, total: "180.00" },
  "an idempotent retry must not import rows twice or replace the first batch");

await assert.rejects(
  applyImport("c".repeat(64), [{
    ...importRows[0],
    row_number: 5,
    workforce_id: reclassifiedWorker,
    external_reference: "RECLASSIFIED-001"
  }], null),
  /canonical Workforce member at its current location/i,
  "reclassified Workforce rows must never become advance register entries"
);

await assert.rejects(
  applyImport("d".repeat(64), [{
    ...importRows[0],
    row_number: 6,
    station_id: otherStation,
    external_reference: "WRONG-LOCATION-001"
  }], [otherStation]),
  /canonical Workforce member at its current location/i,
  "the import must re-lock and recheck the Workforce current location"
);

await assert.rejects(
  db.query(`
    insert into public.workforce_advances(
      id, company_id, workforce_id, station_id, advance_number, advance_date,
      amount, payment_mode, source_type, created_by, updated_by
    ) values ($1,$2,$3,$4,'WA-WRONG-LOCATION','2026-01-15',10,'cash','manual',$5,$5)
  `, [id(13), company, worker, otherStation, actor]),
  /canonical Workforce member's current location/i,
  "the table trigger must reject a stale location even when the caller bypasses the API"
);

await assert.rejects(
  db.query(`
    insert into public.workforce_advances(
      id, company_id, workforce_id, station_id, advance_number, advance_date,
      amount, payment_mode, source_type, created_by, updated_by
    ) values ($1,$2,$3,$4,'WA-RECLASSIFIED','2026-01-15',10,'cash','manual',$5,$5)
  `, [id(14), company, reclassifiedWorker, station, actor]),
  /canonical Workforce member's current location/i,
  "the table trigger must reject reclassified Workforce rows"
);

await assert.rejects(
  applyImport("b".repeat(64), [{ ...importRows[0], row_number: 4, station_id: otherStation }], [station]),
  /outside the importing user's location scope/i
);
const afterRejectedImport = await db.query(`
  select count(*)::int batches from public.workforce_advance_import_batches
`);
assert.equal(afterRejectedImport.rows[0].batches, 1, "a rejected import must roll back its batch header");

await assert.rejects(
  db.query(`
    insert into public.workforce_payout_deduction_values(
      company_id, deduction_head_id, workforce_id, station_id,
      head_code_snapshot, head_name_snapshot, effective_from, effective_to,
      amount, source_type, source_batch_id, source_row_id, created_by, updated_by
    ) values ($1,$2,$3,$4,'ADVANCE','Advance','2026-04-01','2026-04-30',25,
      'bulk_import',$5,$6,$7,$7)
  `, [company, advanceHead, worker, station, legacyBatch, legacyRow, actor]),
  /not system-managed|ADVANCE is controlled by the Workforce Advance Register/i
);

await assert.rejects(
  db.query(`
    insert into public.workforce_payout_import_rows(
      id, company_id, batch_id, input_type, deduction_head_id
    ) values ($1,$2,$3,'DEDUCTION',$4)
  `, [id(18), company, legacyBatch, advanceHead]),
  /cannot be bulk uploaded or cleared as a manual deduction/i,
  "the audit-row guard must reject CLEAR as well as UPSERT before either can mutate register-controlled data"
);

await db.query(`
  insert into public.workforce_payout_deduction_values(
    company_id, deduction_head_id, workforce_id, station_id,
    head_code_snapshot, head_name_snapshot, effective_from, effective_to,
    amount, source_type, source_batch_id, source_row_id, created_by, updated_by
  ) values ($1,$2,$3,$4,'LOAN','Loan','2026-04-01','2026-04-30',25,
    'bulk_import',$5,$6,$7,$7)
`, [company, loanHead, worker, station, legacyBatch, legacyRow, actor]);

const applyRecovery = async (
  from,
  to,
  cap,
  allowed = [station],
  payoutStation = station,
  snapshotHash,
  targetWorker = worker
) => {
  const effectiveSnapshotHash = snapshotHash === undefined
    ? await recoverySnapshot(from, to)
    : snapshotHash;
  return db.query(`
    select public.workforce_apply_advance_recoveries(
      $1::uuid, $2::uuid, $3::date, $4::date,
      jsonb_build_array(jsonb_build_object(
        'workforce_id', $5::text,
        'station_id', $6::text,
        'max_amount', $7::numeric,
        'snapshot_hash', $8::text
      )),
      $9::uuid[]
    ) as result
  `, [company, actor, from, to, targetWorker, payoutStation, cap, effectiveSnapshotHash, allowed]);
};

await assert.rejects(
  applyRecovery("2026-01-01", "2026-01-31", 120, [station], station, null),
  /snapshot is missing or inconsistent/i,
  "every recovery item must carry the payout snapshot used to calculate its cap"
);

await assert.rejects(
  applyRecovery("2026-01-01", "2026-01-31", 120, [station], station, "stale-snapshot"),
  /Payout inputs changed while advances were being prepared/i,
  "the database must reject a recovery calculated from a stale payout snapshot"
);

await assert.rejects(
  applyRecovery(
    "2026-01-01",
    "2026-01-31",
    10,
    [station],
    station,
    await recoverySnapshot(),
    reclassifiedWorker
  ),
  /selected Workforce member no longer exists/i,
  "recovery must fail closed for reclassified Workforce rows"
);

const january = await applyRecovery("2026-01-01", "2026-01-31", 120);
assert.deepEqual(january.rows[0].result, [{ workforce_id: worker, station_id: station, deducted: 120 }]);
const januaryRecoveries = await db.query(`
  select advance.advance_date::text advance_date, recovery.amount::numeric amount
  from public.workforce_advance_recoveries recovery
  join public.workforce_advances advance on advance.id=recovery.advance_id
  where recovery.period_start='2026-01-01' and recovery.period_end='2026-01-31'
  order by advance.advance_date, advance.id
`);
assert.deepEqual(januaryRecoveries.rows, [
  { advance_date: "2026-01-05", amount: "100.00" },
  { advance_date: "2026-01-10", amount: "20.00" }
], "the recovery must consume the oldest advance first and stop at the supplied net-pay cap");
const januaryDeduction = await db.query(`
  select amount::numeric, source_type, source_batch_id, source_row_id
  from public.workforce_payout_deduction_values
  where deduction_head_id=$1 and effective_from='2026-01-01' and effective_to='2026-01-31'
`, [advanceHead]);
assert.deepEqual(januaryDeduction.rows, [{
  amount: "120.00",
  source_type: "advance_register",
  source_batch_id: null,
  source_row_id: null
}]);

const januaryRetry = await applyRecovery("2026-01-01", "2026-01-31", 120);
assert.deepEqual(januaryRetry.rows[0].result, january.rows[0].result);
const afterRetry = await db.query(`
  select
    count(*) filter (where status='deducted')::int active_count,
    coalesce(sum(amount) filter (where status='deducted'),0)::numeric active_amount,
    count(*) filter (where status='reversed')::int reversed_count,
    coalesce(sum(amount) filter (where status='reversed'),0)::numeric reversed_amount,
    count(*) filter (
      where status='reversed'
        and reversed_at is not null
        and reversed_by=$1
        and reversal_reason='Recalculated for the same Workforce payout period'
    )::int audited_reversals
  from public.workforce_advance_recoveries
  where period_start='2026-01-01' and period_end='2026-01-31'
`, [actor]);
assert.deepEqual(afterRetry.rows[0], {
  active_count: 2,
  active_amount: "120.00",
  reversed_count: 0,
  reversed_amount: "0",
  audited_reversals: 0
}, "an identical retry must preserve the original recovery rows without creating audit noise");

await assert.rejects(
  applyRecovery("2026-01-15", "2026-01-31", 10),
  /overlapping ADVANCE deduction/i,
  "a non-exact period overlapping the January 1-31 recovery must be rejected"
);
const afterOverlapFailure = await db.query(`
  select count(*)::int recoveries
  from public.workforce_advance_recoveries
  where period_start='2026-01-15' and period_end='2026-01-31'
`);
assert.equal(afterOverlapFailure.rows[0].recoveries, 0,
  "an overlapping payout attempt must not leave recovery rows behind");

await db.query(`update public.workforce set location_id=$1 where id=$2`, [otherStation, worker]);
const february = await applyRecovery(
  "2026-02-01",
  "2026-02-28",
  9999,
  [otherStation],
  otherStation
);
assert.equal(Number(february.rows[0].result[0].deducted), 60,
  "a cap larger than the balance must deduct only the pending balance");
assert.equal(february.rows[0].result[0].station_id, otherStation,
  "a transferred worker's recovery must follow the selected current payout location");
const februaryLocations = await db.query(`
  select recovery.station_id::text recovery_station_id, value.station_id::text deduction_station_id
  from public.workforce_advance_recoveries recovery
  join public.workforce_payout_deduction_values value on value.id=recovery.deduction_value_id
  where recovery.period_start='2026-02-01'
    and recovery.period_end='2026-02-28'
    and recovery.status='deducted'
`);
assert.deepEqual(februaryLocations.rows, [{
  recovery_station_id: otherStation,
  deduction_station_id: otherStation
}], "recovery and deduction records must retain the transferred worker's payout location");
const balances = await db.query(`
  select advance.amount::numeric total,
    coalesce(sum(recovery.amount) filter (where recovery.status='deducted'),0)::numeric deducted
  from public.workforce_advances advance
  left join public.workforce_advance_recoveries recovery on recovery.advance_id=advance.id
  group by advance.id, advance.amount
  order by advance.advance_date, advance.id
`);
assert.deepEqual(balances.rows, [
  { total: "100.00", deducted: "100.00" },
  { total: "80.00", deducted: "80.00" }
], "no advance may be recovered beyond its original amount");

await assert.rejects(
  applyRecovery("2026-01-01", "2026-01-31", 110, [otherStation], otherStation),
  /Later ADVANCE deductions already exist.*before recalculating this earlier period/i,
  "a changed historical recovery must be rejected once a later payout consumed the FIFO balance"
);
const afterRetroactiveFailure = await db.query(`
  select
    coalesce(sum(amount) filter (
      where status='deducted' and period_start='2026-01-01'
    ),0)::numeric january_active,
    coalesce(sum(amount) filter (
      where status='deducted' and period_start='2026-02-01'
    ),0)::numeric february_active,
    count(*) filter (where status='reversed')::int reversed_count
  from public.workforce_advance_recoveries
  where workforce_id=$1
`, [worker]);
assert.deepEqual(afterRetroactiveFailure.rows[0], {
  january_active: "120.00",
  february_active: "60.00",
  reversed_count: 0
}, "a rejected retroactive recalculation must leave every recovery and audit row unchanged");

const marchAdvance = id(20);
await db.query(`
  insert into public.workforce_advances(
    id, company_id, workforce_id, station_id, advance_number, advance_date,
    amount, payment_mode, source_type, created_by, updated_by
  ) values ($1,$2,$3,$4,'WA-MARCH','2026-03-01',50,'upi','manual',$5,$5)
`, [marchAdvance, company, worker, otherStation, actor]);
await db.query(`
  insert into public.workforce_payroll_runs(id, company_id, period_start, period_end, status)
  values ($1,$2,'2026-03-01','2026-03-31','approved')
`, [payrollRun, company]);
await assert.rejects(
  applyRecovery("2026-03-01", "2026-03-31", 50, [otherStation], otherStation),
  /affected period is approved or paid/i
);
const afterFinalizedFailure = await db.query(`
  select
    (select count(*)::int from public.workforce_advance_recoveries where advance_id=$1) recoveries,
    (select count(*)::int from public.workforce_payout_deduction_values
      where deduction_head_id=$2 and effective_from='2026-03-01') deductions
`, [marchAdvance, advanceHead]);
assert.deepEqual(afterFinalizedFailure.rows[0], { recoveries: 0, deductions: 0 },
  "the deduction guard failure must roll the whole recovery transaction back");

const laterOverlappingPeriod = await applyRecovery(
  "2026-04-15",
  "2026-04-30",
  10,
  [otherStation],
  otherStation
);
assert.equal(Number(laterOverlappingPeriod.rows[0].result[0].deducted), 10);
await assert.rejects(
  applyRecovery("2026-04-01", "2026-04-15", 5, [otherStation], otherStation),
  /overlapping ADVANCE deduction/i,
  "a custom period sharing an inclusive boundary with an existing period must be rejected as overlapping"
);

await assert.rejects(
  applyRecovery("2026-04-01", "2026-04-30", 10, [], otherStation),
  /outside your location scope/i
);

const historicalRow = {
  row_number: 2,
  workforce_id: worker,
  station_id: otherStation,
  advance_date: "2025-11-15",
  amount: 250,
  deducted_amount: 100,
  payment_mode: "bank_transfer",
  payment_reference: "HISTORICAL-001",
  remark: "Imported historical balance"
};
await applyImport("e".repeat(64), [historicalRow], [otherStation]);
const historicalBalance = await db.query(`
  select
    advance.amount::numeric total,
    coalesce(sum(recovery.amount) filter (where recovery.status='deducted'),0)::numeric deducted,
    (advance.amount - coalesce(sum(recovery.amount) filter (where recovery.status='deducted'),0))::numeric pending,
    count(*) filter (where recovery.recovery_type='opening_balance' and recovery.status='deducted')::int opening_rows,
    min(recovery.period_start)::text period_start,
    min(recovery.period_end)::text period_end
  from public.workforce_advances advance
  left join public.workforce_advance_recoveries recovery on recovery.advance_id=advance.id
  where advance.payment_reference='HISTORICAL-001'
  group by advance.id, advance.amount
`);
assert.deepEqual(historicalBalance.rows, [{
  total: "250.00",
  deducted: "100.00",
  pending: "150.00",
  opening_rows: 1,
  period_start: "2025-11-15",
  period_end: "2025-11-15"
}], "DEDUCTED_AMOUNT must atomically become an opening-balance recovery");

await assert.rejects(
  applyImport("f".repeat(64), [{
    ...historicalRow,
    row_number: 9,
    advance_date: "2025-12-01",
    amount: 999,
    deducted_amount: 0,
    payment_reference: "  historical-001  ",
    remark: "The workbook was saved again"
  }], [otherStation]),
  /duplicates an advance already in the register|already exists in the register/i,
  "a stable reference must block a duplicate from a re-saved workbook"
);

const referenceFreeRow = {
  row_number: 2,
  workforce_id: worker,
  station_id: otherStation,
  advance_date: "2025-12-05",
  amount: 75,
  deducted_amount: 0,
  payment_mode: "cash",
  payment_reference: null,
  remark: "Reference-free advance"
};
await applyImport("1".repeat(64), [referenceFreeRow], [otherStation]);
await assert.rejects(
  applyImport("2".repeat(64), [{
    ...referenceFreeRow,
    row_number: 7,
    remark: "Remark changed after re-saving"
  }], [otherStation]),
  /duplicates an advance already in the register|already exists in the register/i,
  "worker, date, amount and payment mode must protect reference-free imports"
);

const openingBalanceRow = {
  row_number: 10,
  workforce_id: openingBalanceWorker,
  station_id: station,
  advance_date: "2026-05-15",
  amount: 250,
  deducted_amount: 100,
  payment_mode: "cash",
  payment_reference: "OPENING-IN-PERIOD",
  remark: "Opening balance dated inside payout period"
};
await applyImport("3".repeat(64), [openingBalanceRow], [station]);
const mayRecovery = await applyRecovery(
  "2026-05-01",
  "2026-05-31",
  9999,
  [station],
  station,
  undefined,
  openingBalanceWorker
);
assert.equal(Number(mayRecovery.rows[0].result[0].deducted), 150,
  "an opening balance inside the payout period must reduce the amount still pending");
const afterMayRecovery = await db.query(`
  select
    coalesce(sum(amount) filter (where recovery_type='opening_balance' and status='deducted'),0)::numeric opening_amount,
    coalesce(sum(amount) filter (
      where recovery_type='payout' and status='deducted'
        and period_start='2026-05-01' and period_end='2026-05-31'
    ),0)::numeric payout_amount,
    coalesce(sum(amount) filter (where status='deducted'),0)::numeric total_active
  from public.workforce_advance_recoveries
  where workforce_id=$1
`, [openingBalanceWorker]);
assert.deepEqual(afterMayRecovery.rows[0], {
  opening_amount: "100.00",
  payout_amount: "150.00",
  total_active: "250.00"
}, "opening and payout recoveries must never exceed the imported advance amount");

const mayRecalculation = await applyRecovery(
  "2026-05-01",
  "2026-05-31",
  140,
  [station],
  station,
  undefined,
  openingBalanceWorker
);
assert.equal(Number(mayRecalculation.rows[0].result[0].deducted), 140,
  "the exact same payout period may be recalculated before a later recovery exists");
const mayRestored = await applyRecovery(
  "2026-05-01",
  "2026-05-31",
  9999,
  [station],
  station,
  undefined,
  openingBalanceWorker
);
assert.deepEqual(mayRestored.rows[0].result, mayRecovery.rows[0].result,
  "an exact-period recalculation may restore the original recovery plan");

await db.query(`
  insert into public.workforce_advances(
    id, company_id, workforce_id, station_id, advance_number, advance_date,
    amount, payment_mode, source_type, created_by, updated_by
  ) values ($1,$2,$3,$4,'WA-LATER','2026-06-01',50,'cash','manual',$5,$5)
`, [laterAdvance, company, openingBalanceWorker, station, actor]);
const juneRecovery = await applyRecovery(
  "2026-06-01",
  "2026-06-30",
  9999,
  [station],
  station,
  undefined,
  openingBalanceWorker
);
assert.equal(Number(juneRecovery.rows[0].result[0].deducted), 50);
const auditBeforeMayRetry = await db.query(`
  select count(*) filter (where status='reversed')::int reversed_count
  from public.workforce_advance_recoveries
  where workforce_id=$1
`, [openingBalanceWorker]);
const mayRetryWithLaterPeriod = await applyRecovery(
  "2026-05-01",
  "2026-05-31",
  9999,
  [station],
  station,
  undefined,
  openingBalanceWorker
);
assert.deepEqual(mayRetryWithLaterPeriod.rows[0].result, mayRecovery.rows[0].result,
  "an identical exact-period retry must remain a no-op even after a later recovery exists");
const afterMayRetryWithLaterPeriod = await db.query(`
  select
    count(*) filter (
      where recovery_type='payout' and status='deducted'
        and period_start='2026-05-01' and period_end='2026-05-31'
    )::int active_count,
    count(*) filter (where status='reversed')::int reversed_count
  from public.workforce_advance_recoveries
  where workforce_id=$1
`, [openingBalanceWorker]);
assert.deepEqual(afterMayRetryWithLaterPeriod.rows[0], {
  active_count: 1,
  reversed_count: auditBeforeMayRetry.rows[0].reversed_count
}, "an identical historical retry must not rewrite recovery audit history");

const pendingIdentityRow = {
  row_number: 12,
  dropx_id: " Dx Pending 007 ",
  advance_date: "2026-07-05",
  amount: 500,
  deducted_amount: 125,
  payment_mode: "upi",
  payment_reference: "PENDING-REF-007",
  remark: "Imported before registration"
};

await assert.rejects(
  applyImport("4".repeat(64), [pendingIdentityRow], [station]),
  /unregistered and cannot be imported without all-location access/i,
  "a location-scoped caller must not create a locationless pending identity"
);

await applyImport("5".repeat(64), [pendingIdentityRow], null);
const pendingBeforeRegistration = await db.query(`
  select
    imported_dropx_id,
    link_status,
    workforce_id,
    station_id,
    amount::numeric amount,
    opening_deducted_amount::numeric opening_deducted_amount,
    external_reference,
    linked_at,
    (select count(*)::int from public.workforce_advance_recoveries recovery
      where recovery.advance_id=advance.id) recovery_count
  from public.workforce_advances advance
  where payment_reference='PENDING-REF-007'
`);
assert.deepEqual(pendingBeforeRegistration.rows, [{
  imported_dropx_id: " Dx Pending 007 ",
  link_status: "pending",
  workforce_id: null,
  station_id: null,
  amount: "500.00",
  opening_deducted_amount: "125.00",
  external_reference: `WAI2-${createHash("md5").update("v2|DXPENDING007|reference|pending-ref-007").digest("hex")}`,
  linked_at: null,
  recovery_count: 0
}], "an unmatched import must retain the exact ID and opening balance without inventing canonical keys");

await db.query(`
  insert into public.workforce(id, company_id, dropx_id, full_name, location_id, migration_state)
  values ($1,$2,'dxpending007','Pending Worker',null,null)
`, [pendingWorker, company]);
const stillPending = await db.query(`
  select link_status from public.workforce_advances where payment_reference='PENDING-REF-007'
`);
assert.equal(stillPending.rows[0].link_status, "pending",
  "a profile without a canonical current location must not link a pending advance");

await db.query(`update public.workforce set location_id=$1 where id=$2`, [station, pendingWorker]);
const linkedAfterRegistration = await db.query(`
  select
    advance.imported_dropx_id,
    advance.link_status,
    advance.workforce_id::text workforce_id,
    advance.station_id::text station_id,
    advance.opening_deducted_amount::numeric opening_deducted_amount,
    (advance.linked_at is not null) linked,
    recovery.amount::numeric recovered,
    recovery.recovery_type,
    recovery.status,
    recovery.period_start::text period_start,
    recovery.period_end::text period_end
  from public.workforce_advances advance
  join public.workforce_advance_recoveries recovery on recovery.advance_id=advance.id
  where advance.payment_reference='PENDING-REF-007'
`);
assert.deepEqual(linkedAfterRegistration.rows, [{
  imported_dropx_id: " Dx Pending 007 ",
  link_status: "linked",
  workforce_id: pendingWorker,
  station_id: station,
  opening_deducted_amount: "125.00",
  linked: true,
  recovered: "125.00",
  recovery_type: "opening_balance",
  status: "deducted",
  period_start: "2026-07-05",
  period_end: "2026-07-05"
}], "Workforce registration must link identity, location, and opening recovery in one transaction");

await assert.rejects(
  applyImport("6".repeat(64), [{ ...pendingIdentityRow, row_number: 14 }], null),
  /duplicates an advance already in the register|already exists in the register/i,
  "the identity-based WAI2 key must remain duplicate-safe after automatic linking"
);

await assert.rejects(
  db.query(`
    insert into public.workforce_advances(
      id, company_id, workforce_id, station_id, advance_number, advance_date,
      amount, payment_mode, external_reference, source_type, created_by, updated_by
    ) values ($1,$2,$3,$4,'WA-RESERVED','2026-07-06',10,'cash',
      'WAI2-00000000000000000000000000000000','manual',$5,$5)
  `, [id(24), company, pendingWorker, station, actor]),
  /WAI1 and WAI2 references are reserved/i,
  "manual entries must not reserve or spoof an internal import key"
);

for (const table of [
  "workforce_advance_import_batches",
  "workforce_advances",
  "workforce_advance_recoveries"
]) {
  const rls = await db.query(`select relrowsecurity from pg_class where oid=$1::regclass`, [`public.${table}`]);
  assert.equal(rls.rows[0].relrowsecurity, true, `${table} must have RLS enabled`);
}

console.log("Workforce advance register migration verification passed.");
