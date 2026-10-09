import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";

const migrationUrl = new URL(
  "../supabase/migrations/20261009112849_workforce_payout_bank_payment_ledger.sql",
  import.meta.url
);
const compatibilityMigrationUrl = new URL(
  "../supabase/migrations/20261009113937_workforce_payout_bank_legacy_publication_compat.sql",
  import.meta.url
);
const publishedSnapshotFreshnessMigrationUrl = new URL(
  "../supabase/migrations/20261009125250_workforce_payout_bank_published_snapshot_freshness.sql",
  import.meta.url
);
const lifecycleMigrationUrl = new URL(
  "../supabase/migrations/20261009172942_workforce_payout_manual_status_and_holds.sql",
  import.meta.url
);
const migration = readFileSync(migrationUrl, "utf8");
const compatibilityMigration = readFileSync(compatibilityMigrationUrl, "utf8");
const publishedSnapshotFreshnessMigration = readFileSync(publishedSnapshotFreshnessMigrationUrl, "utf8");
const lifecycleMigration = readFileSync(lifecycleMigrationUrl, "utf8");
const executablePublishedSnapshotFreshnessMigration = publishedSnapshotFreshnessMigration
  .replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");
const executableLifecycleMigration = lifecycleMigration
  .replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");
const executableMigration = [migration, compatibilityMigration, publishedSnapshotFreshnessMigration]
  .map((sql) => sql.replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, ""))
  .join("\n");

for (const table of [
  "workforce_payout_payment_batches",
  "workforce_payout_payment_items",
  "workforce_payout_payment_allocations",
  "workforce_payout_payment_response_imports",
  "workforce_payout_payment_events"
]) {
  assert.match(migration, new RegExp(`create table public\\.${table}`, "i"));
  assert.match(migration, new RegExp(`alter table public\\.${table} force row level security`, "i"));
}
assert.match(migration, /numeric\(14,2\)/i);
assert.match(migration, /instruction_amount_snapshot numeric\(14,2\) not null/i);
assert.match(
  migration,
  /unique\s*\(company_id,\s*workforce_id,\s*period_start,\s*period_end,\s*payment_version\)/i
);
assert.match(migration, /unique\s*\(company_id,\s*reference_no\)/i);
assert.match(
  migration,
  /create unique index workforce_payout_payment_items_active_uidx[\s\S]*?where status = 'processing'/i
);
assert.match(
  migration,
  /create unique index workforce_payout_payment_items_paid_transaction_uidx[\s\S]*?where status = 'paid'[\s\S]*?not in \('', '0', 'NA', 'NIL', 'NONE', 'NULL', 'NOTAVAILABLE', 'NOTAPPLICABLE'\)/i
);
assert.match(migration, /'WP' \|\| v_normalized_id[\s\S]*?extract\(month[\s\S]*?'V' \|\| p_version::text/i);
assert.match(migration, /create or replace function public\.workforce_payout_bank_account_canonical/i);
assert.match(migration, /create or replace function public\.workforce_payout_bank_ifsc_canonical/i);
assert.match(migration, /create or replace function public\.workforce_payout_bank_reference_canonical/i);
assert.match(migration, /debit_account_no_snapshot ~ '\^\[A-Z0-9\]\{4,30\}\$'/i);
assert.match(migration, /ifsc_snapshot ~ '\^\[A-Z\]\{4\}0\[A-Z0-9\]\{6\}\$'/i);
assert.match(migration, /create or replace function public\.workforce_create_payout_payment_batch/i);
assert.match(migration, /create or replace function public\.workforce_finalize_payout_payment_response/i);
assert.match(migration, /create or replace function public\.workforce_payout_payment_candidates/i);
assert.match(migration, /create or replace function public\.workforce_preview_payout_payments/i);
assert.match(
  migration,
  /workforce_create_payout_payment_batch[\s\S]*?from public\.workforce_payout_payment_candidates\(/i,
  "the mutating creator must consume the same canonical candidate calculation as the read-only preview"
);
assert.match(
  migration,
  /workforce_preview_payout_payments[\s\S]*?from public\.workforce_payout_payment_candidates\(/i,
  "the dashboard preview must consume the canonical candidate calculation"
);
assert.match(migration, /set search_path = ''/i);
assert.match(migration, /upper\(btrim\(bank\.bank_code\)\) = 'FEDERAL_BANK'[\s\S]*?for share/i);
assert.match(
  migration,
  /v_debit_account := public\.workforce_payout_bank_account_canonical[\s\S]*?for v_candidate in[\s\S]*?insert into public\.workforce_payout_payment_batches/i,
  "bank and beneficiary identifiers must be preflighted before the processing batch is inserted"
);
assert.doesNotMatch(migration, /bank\.file_type/i);
assert.match(migration, /'fedone', 'processing', p_actor_user_id/i);
assert.match(migration, /latest\.review_status in \('under_review', 'approved'\)/i);
assert.match(migration, /latest\.snapshot #>> '\{worksheet,payment_eligible\}' = 'true'/i);
assert.match(migration, /payment_details_available\}' is null[\s\S]*?published_at < '2026-10-10 00:00:00\+00'/i);
assert.match(compatibilityMigration, /Expected three legacy payment eligibility predicates/i);
assert.match(migration, /required_stations as \([\s\S]*?latest_relock\.active_locations[\s\S]*?workforce_payout_review_submissions/i);
assert.match(migration, /from required_stations required_station[\s\S]*?left join latest/i);
assert.match(migration, /latest\.dependency_hash = v_current_dependency_hash/i);
assert.match(migration, /workforce_advance_recovery_snapshot_hash\([\s\S]*?p_period_start, p_period_end/i);
assert.match(
  publishedSnapshotFreshnessMigration,
  /Unexpected live dependency-hash structure in workforce_payout_payment_candidates/i
);
assert.match(
  publishedSnapshotFreshnessMigration,
  /v_definition := replace\(v_definition, v_predicate, ''\)/i,
  "bank eligibility must stop comparing an immutable publication with the volatile live dependency hash"
);
assert.match(
  publishedSnapshotFreshnessMigration,
  /Unfinished publication refreshes and mapping relocks block payment/i
);
assert.match(migration, /v_amount_paise_text := btrim\(coalesce\(v_row ->> 'debit_amount_paise'/i);
assert.match(migration, /v_remarks := btrim\(coalesce\(v_row ->> 'remarks'/i);
assert.match(migration, /v_amount_paise <> round\(v_item\.instruction_amount \* 100, 0\)/i);
assert.match(migration, /v_status = 'PAID' and v_utr = ''/i);
assert.match(migration, /This exact terminal response was already recorded/i);
assert.match(migration, /UTR\/CIN is already recorded for another paid Workforce instruction/i);
assert.match(migration, /meaningful bank UTR\/CIN is required[\s\S]*?placeholder values are not accepted/i);
assert.match(migration, /already terminal with a different bank response/i);
assert.match(migration, /already partially or fully finalized and its bank file cannot be regenerated/i);
assert.match(migration, /'company_id', 'workforce_id', 'effective_from', 'effective_to', 'null_is_infinity'/i);
assert.match(migration, /field_executive_provider_mappings_00_published_processing_guard/i);
assert.match(migration, /workforce_payout_review_submissions_00_bank_processing_guard/i);
assert.match(migration, /workforce_payout_mapping_relocks_00_bank_processing_guard/i);
assert.match(migration, /workforce_payment_settings_00_bank_processing_insert/i);
assert.match(migration, /workforce_attendance_capture_settings_00_bank_processing_insert/i);
for (const patchedRpc of [
  "workforce_apply_advance_recoveries",
  "payment_recovery_configure_case",
  "workforce_relock_payout_mappings",
  "workforce_transition_payout_review_status"
]) {
  assert.match(
    migration,
    new RegExp(`Could not install the bank-processing assertion in ${patchedRpc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i")
  );
}
assert.match(
  migration,
  /revoke all on table public\.workforce_payout_payment_batches,[\s\S]*?from public, anon, authenticated, service_role/i
);
assert.match(
  migration,
  /grant select on table public\.workforce_payout_payment_batches,[\s\S]*?to service_role/i
);
assert.doesNotMatch(
  migration,
  /grant\s+(?:[^;]*\b(?:insert|update|delete|truncate)\b[^;]*)\s+on table public\.workforce_payout_payment_/i
);
assert.match(lifecycleMigration, /create table public\.workforce_payout_payment_hold_events/i);
assert.match(lifecycleMigration, /state_changed boolean not null/i);
assert.match(lifecycleMigration, /force row level security/i);
assert.match(lifecycleMigration, /status in \('processing', 'paid', 'cancelled', 'failed'\)/i);
assert.match(lifecycleMigration, /eligibility_code := 'pan_not_linked'/i);
assert.match(lifecycleMigration, /eligibility_code := 'payment_on_hold'/i);
assert.match(lifecycleMigration, /cardinality\(selected_workforce_ids\) >= 1/i);
assert.doesNotMatch(lifecycleMigration, /cardinality\(selected_workforce_ids\) <= 1000/i);

const db = new PGlite();
const id = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const company = id(1);
const actor = id(2);
const bank = id(3);
const station = id(4);
const workforce = id(5);
const review = id(6);
const publicationV1 = id(7);
const publicationV2 = id(8);
const secondStation = id(9);
const secondReview = id(10);
const secondPublication = id(11);
const ineligiblePublication = id(12);
const unmarkedPublication = id(13);
const mappingRelock = id(14);
const legacyPublication = id(35);
const refreshJob = id(36);
const periodStart = "2026-09-01";
const periodEnd = "2026-09-30";
const dependencyHash = "dependency-september-2026";

await db.exec(`
  create schema auth;
  create role anon;
  create role authenticated;
  create role service_role bypassrls;

  create table auth.users(id uuid primary key);
  create table public.companies(id uuid primary key);
  create table public.payment_banks(
    id uuid primary key,
    company_id uuid not null,
    bank_code text not null,
    display_name text not null,
    account_no text not null,
    ifsc text not null,
    is_active boolean not null default true
  );
  create table public.stations(
    id uuid primary key,
    company_id uuid not null,
    station_code text not null,
    unique(company_id,id)
  );
  create table public.workforce(
    id uuid primary key,
    company_id uuid not null,
    dropx_id text,
    full_name text,
    email text,
    location_id uuid,
    bank_account_no text,
    ifsc_code text,
    deleted_at timestamptz,
    migration_state text not null default 'active',
    source_profile_type text,
    source_profile_id uuid,
    unique(company_id,id)
  );
  create table public.connect_profile_verifications(
    company_id uuid not null,
    profile_type text not null,
    account_id uuid not null,
    kind text not null,
    verified boolean not null default false,
    primary key(company_id, profile_type, account_id, kind)
  );
  create table public.workforce_payout_review_submissions(
    id uuid primary key,
    company_id uuid not null,
    subject_type text not null,
    subject_id uuid not null,
    location_id uuid not null,
    period_start date not null,
    period_end date not null,
    status text not null,
    calculation_snapshot jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default clock_timestamp()
  );
  grant select,insert,update on public.workforce_payout_review_submissions to service_role;
  create table public.workforce_payout_mapping_relocks(
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null,
    period_start date not null,
    period_end date not null,
    affected_workforce_ids uuid[] not null,
    active_locations jsonb not null default '{}'::jsonb,
    relocked_at timestamptz not null default clock_timestamp()
  );
  create table public.workforce_payout_publications(
    id uuid primary key,
    company_id uuid not null,
    workforce_id uuid not null,
    station_id uuid not null,
    revision integer not null,
    snapshot jsonb not null,
    snapshot_hash text,
    dependency_hash text,
    mapping_relock_id uuid,
    review_submission_id uuid,
    publication_kind text not null,
    period_start date not null,
    period_end date not null,
    published_at timestamptz not null default clock_timestamp()
  );
  create table public.workforce_payout_publication_refresh_jobs(
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null,
    workforce_id uuid not null,
    period_start date not null,
    period_end date not null,
    status text not null
  );
  create table public.workforce_payroll_runs(
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null,
    period_start date not null,
    period_end date not null,
    status text not null
  );
  create table public.workforce_payout_attendance_overrides(
    company_id uuid, workforce_id uuid, work_date date
  );
  create table public.workforce_custom_production_inputs(
    company_id uuid, workforce_id uuid, work_date date
  );
  create table public.workforce_payment_field_overrides(
    company_id uuid, workforce_id uuid, effective_from date, effective_to date
  );
  create table public.workforce_additional_payment_values(
    company_id uuid, workforce_id uuid, effective_from date, effective_to date
  );
  create table public.workforce_payout_deduction_values(
    company_id uuid, workforce_id uuid, effective_from date, effective_to date
  );
  create table public.workforce_payout_attendance_values(
    company_id uuid, workforce_id uuid, effective_from date, effective_to date
  );
  create table public.workforce_payment_allocations(
    company_id uuid, workforce_id uuid, effective_from date, effective_to date
  );
  create table public.workforce_payout_mapping_unlocks(
    id uuid primary key default gen_random_uuid(),
    company_id uuid, workforce_id uuid, period_start date, period_end date
  );
  create table public.verify_workforce_payout_mapping_revision_state(
    company_id uuid not null,
    workforce_id uuid not null,
    period_start date not null,
    period_end date not null,
    revision_pending boolean not null
  );
  create table public.field_executive_provider_mappings(
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null,
    workforce_id uuid,
    field_executive_id uuid,
    employee_id uuid,
    contractor_id uuid,
    effective_from date not null,
    effective_to date,
    status text not null,
    updated_at timestamptz
  );
  create table public.workforce_payment_settings(
    id bigint generated always as identity primary key,
    company_id uuid not null,
    effective_from date not null
  );
  create table public.workforce_attendance_capture_settings(
    id bigint generated always as identity primary key,
    company_id uuid not null,
    effective_from date not null
  );

  create function public.lock_workforce_payment_allocation_company(uuid)
  returns void language sql as $$ select $$;
  create function public.workforce_provider_mapping_person(uuid,uuid,uuid,uuid,uuid)
  returns uuid language sql stable as $$ select coalesce($2,$3,$4,$5) $$;
  create function public.workforce_advance_recovery_snapshot_hash(uuid,date,date)
  returns text language sql stable as $$ select '${dependencyHash}'::text $$;
  create function public.workforce_payout_mapping_revision_state(uuid,uuid)
  returns table(period_start date, period_end date, revision_pending boolean)
  language sql stable as $$
    select state.period_start, state.period_end, state.revision_pending
    from public.verify_workforce_payout_mapping_revision_state state
    where state.company_id = $1 and state.workforce_id = $2
  $$;
  create function public.payment_recovery_eligible_payout_targets(uuid,date,uuid[])
  returns table(dropx_id text,payout_engine text,workforce_id uuid)
  language sql stable as $$ select null::text,null::text,null::uuid where false $$;

  create function public.workforce_apply_advance_recoveries(
    p_company_id uuid,p_actor_user_id uuid,p_period_start date,p_period_end date,
    p_items jsonb,p_allowed_location_ids uuid[] default null
  ) returns jsonb language plpgsql security definer as $$
  declare v_current_snapshot_hash text;
  begin
    perform public.lock_workforce_payment_allocation_company(p_company_id);
    v_current_snapshot_hash := '';
    return '{}'::jsonb;
  end $$;
  create function public.payment_recovery_configure_case(
    p_company_id uuid,p_case_id uuid,p_method text,p_payout_month date default null,
    p_dropx_ids text[] default null,p_workforce_items jsonb default '[]'::jsonb,
    p_actor_user_id uuid default null,p_allowed_location_ids uuid[] default null
  ) returns jsonb language plpgsql security definer as $$
  declare v_normalized_ids text[] := '{}'::text[]; v_period_end date := p_payout_month;
  begin
    perform public.lock_workforce_payment_allocation_company(p_company_id);
    return '{}'::jsonb;
  end $$;
  create function public.workforce_relock_payout_mappings(
    p_company_id uuid,p_actor_user_id uuid,p_period_start date,p_period_end date,
    p_unlock_ids uuid[],p_operation_id uuid,p_change_summary text,
    p_expected_dependency_hash text,p_items jsonb
  ) returns jsonb language plpgsql security definer as $$
  declare v_impacted_ids uuid[] := '{}'::uuid[];
  begin
    perform public.lock_workforce_payment_allocation_company(p_company_id);
    return '{}'::jsonb;
  end $$;
  create function public.workforce_transition_payout_review_status(
    p_company_id uuid,p_subject_type text,p_subject_id uuid,p_location_id uuid,
    p_period_start date,p_period_end date,p_expected_status text,p_new_status text,
    p_allowed_location_ids uuid[] default null
  ) returns jsonb language plpgsql security definer as $$
  declare v_subject_type text := lower(btrim(p_subject_type));
  begin
    perform public.lock_workforce_payment_allocation_company(p_company_id);
    return '{}'::jsonb;
  end $$;
`);

await db.exec(executableMigration);
await db.exec(executablePublishedSnapshotFreshnessMigration);
await db.exec(executableLifecycleMigration);

const installedCandidateDefinition = await db.query(`
  select pg_get_functiondef(
    'public.workforce_payout_payment_candidates(uuid,date,date,uuid[])'::regprocedure
  ) definition
`);
const installedCreatorDefinition = await db.query(`
  select pg_get_functiondef(
    'public.workforce_create_payout_payment_batch(uuid,uuid,uuid,text,uuid,date,date,date,uuid[])'::regprocedure
  ) definition
`);
const installedSelectionConstraint = await db.query(`
  select pg_get_constraintdef(oid) definition
  from pg_constraint
  where conname='workforce_payout_payment_batches_selection_check'
`);
assert.doesNotMatch(
  installedCandidateDefinition.rows[0].definition,
  /latest\.dependency_hash\s*=\s*v_current_dependency_hash/i,
  "the installed bank candidate must honor the published snapshot after unrelated live dependency changes"
);
assert.doesNotMatch(
  installedCandidateDefinition.rows[0].definition,
  /workforce_advance_recovery_snapshot_hash|v_current_dependency_hash/i,
  "bank eligibility must not depend on live dependency-hash availability"
);
assert.doesNotMatch(installedCandidateDefinition.rows[0].definition, /cardinality\(v_ids\)\s*>\s*1000/i);
assert.doesNotMatch(installedCreatorDefinition.rows[0].definition, /cardinality\(v_ids\)[^;]*1000/i);
assert.doesNotMatch(installedSelectionConstraint.rows[0].definition, /1000/i);

const reference = await db.query(
  "select public.workforce_payout_payment_reference('D-111',date '2026-09-01',1) reference_no"
);
assert.equal(reference.rows[0].reference_no, "WPD111092026V1");
const canonicalIdentifiers = await db.query(`
  select
    public.workforce_payout_bank_account_canonical(' 0011' || chr(160) || '223344 ') account_no,
    public.workforce_payout_bank_ifsc_canonical(' fdrl' || chr(8203) || '0000001 ') ifsc,
    public.workforce_payout_bank_reference_canonical(' wp' || chr(65279) || ' d111092026v1 ') reference_no
`);
assert.deepEqual(canonicalIdentifiers.rows[0], {
  account_no: "0011223344",
  ifsc: "FDRL0000001",
  reference_no: "WPD111092026V1"
});
await assert.rejects(
  db.query("select public.workforce_payout_payment_reference('---',date '2026-09-01',1)"),
  /DropX ID is required/i
);

await db.query("insert into public.companies(id) values ($1)", [company]);
await db.query("insert into auth.users(id) values ($1)", [actor]);
await db.query(
  "insert into public.payment_banks(id,company_id,bank_code,display_name,account_no,ifsc,is_active) values ($1,$2,'FEDERAL_BANK','Federal',' 0011 223344 ',' fdrl 0000001 ',true)",
  [bank, company]
);
await db.query("insert into public.stations(id,company_id,station_code) values ($1,$2,'NLRF')", [station, company]);
await db.query("insert into public.stations(id,company_id,station_code) values ($1,$2,'KOZA')", [secondStation, company]);
await db.query(
  `insert into public.workforce(
    id,company_id,dropx_id,full_name,email,location_id,bank_account_no,ifsc_code
  ) values ($1,$2,'D111','Test Worker','worker@example.com',$3,' 1234 567890 ',' fdrl 0000002 ')`,
  [workforce, company, station]
);
await db.query(
  `insert into public.connect_profile_verifications(
    company_id,profile_type,account_id,kind,verified
  ) values ($1,'workforce',$2,'pan_aadhaar',true)`,
  [company, workforce]
);
await db.query(
  `insert into public.workforce_payout_mapping_relocks(
    id,company_id,period_start,period_end,affected_workforce_ids,active_locations
  ) values ($1,$2,$3,$4,array[$5::uuid],$6::jsonb)`,
  [mappingRelock, company, periodStart, periodEnd, workforce,
    JSON.stringify({ [workforce]: [station, secondStation] })]
);
const snapshotV1 = JSON.stringify({
  schema_version: "2",
  source: "workforce_payout_worksheet",
  worksheet: { payment_eligible: true, payment_status: "Ready for review" },
  item: { workforce_id: workforce, station_code: "NLRF", net_amount: "10836.00" }
});
await db.query(
  `insert into public.workforce_payout_review_submissions(
    id,company_id,subject_type,subject_id,location_id,period_start,period_end,status,calculation_snapshot
  ) values ($1,$2,'workforce',$3,$4,$5,$6,'under_review',$7::jsonb)`,
  [review, company, workforce, station, periodStart, periodEnd, snapshotV1]
);
await db.query(
  `insert into public.workforce_payout_publications(
    id,company_id,workforce_id,station_id,revision,snapshot,snapshot_hash,dependency_hash,
    mapping_relock_id,review_submission_id,publication_kind,period_start,period_end
  ) values ($1,$2,$3,$4,1,$5::jsonb,$6,$7,$8,$9,'worksheet',$10,$11)`,
  [publicationV1, company, workforce, station, snapshotV1, "a".repeat(64), dependencyHash,
    mappingRelock, review, periodStart, periodEnd]
);
const createBatch = async ({ operation, fingerprint, valueDate = "2026-10-10" }) => {
  const result = await db.query(
    `select public.workforce_create_payout_payment_batch(
      $1,$2,$3,$4,$5,$6::date,$7::date,$8::date,array[$9::uuid]
    ) result`,
    [company, actor, operation, fingerprint, bank, periodStart, periodEnd, valueDate, workforce]
  );
  return result.rows[0].result;
};
const preview = async () => {
  const result = await db.query(
    `select * from public.workforce_preview_payout_payments(
      $1,$2::date,$3::date,array[$4::uuid]
    )`,
    [company, periodStart, periodEnd, workforce]
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0];
};
const incompletePreview = await preview();
assert.equal(incompletePreview.eligible, false);
assert.equal(incompletePreview.eligibility_code, "publication_stale_or_incomplete");
assert.equal(Number(incompletePreview.available_to_pay), 0);
await assert.rejects(
  createBatch({ operation: id(29), fingerprint: "5".repeat(64) }),
  /stale, incomplete, or not explicitly payment-eligible/i,
  "every active station in the latest mapping relock must have a current publication"
);
const secondSnapshot = JSON.stringify({
  schema_version: "2",
  source: "workforce_payout_worksheet",
  worksheet: { payment_eligible: true, payment_status: "Ready for review" },
  item: { workforce_id: workforce, station_code: "KOZA", net_amount: "1000.00" }
});
await db.query(
  `insert into public.workforce_payout_review_submissions(
    id,company_id,subject_type,subject_id,location_id,period_start,period_end,status,calculation_snapshot
  ) values ($1,$2,'workforce',$3,$4,$5,$6,'under_review',$7::jsonb)`,
  [secondReview, company, workforce, secondStation, periodStart, periodEnd, secondSnapshot]
);
await db.query(
  `insert into public.workforce_payout_publications(
    id,company_id,workforce_id,station_id,revision,snapshot,snapshot_hash,dependency_hash,
    mapping_relock_id,review_submission_id,publication_kind,period_start,period_end
  ) values ($1,$2,$3,$4,1,$5::jsonb,$6,$7,$8,$9,'worksheet',$10,$11)`,
  [secondPublication, company, workforce, secondStation, secondSnapshot, "d".repeat(64), dependencyHash,
    mappingRelock, secondReview, periodStart, periodEnd]
);

await db.exec(`
  create or replace function public.workforce_advance_recovery_snapshot_hash(uuid,date,date)
  returns text language sql stable as $$ select 'unrelated-live-dependency-change'::text $$
`);
await db.query(
  `insert into public.workforce_payout_publication_refresh_jobs(
    id,company_id,workforce_id,period_start,period_end,status
  ) values ($1,$2,$3,$4,$5,'pending')`,
  [refreshJob, company, workforce, periodStart, periodEnd]
);
const refreshBlockedPreview = await preview();
assert.equal(refreshBlockedPreview.eligible, false);
assert.equal(refreshBlockedPreview.eligibility_code, "publication_refresh_pending");
await db.query("delete from public.workforce_payout_publication_refresh_jobs where id=$1", [refreshJob]);

await db.query(
  `insert into public.verify_workforce_payout_mapping_revision_state(
    company_id,workforce_id,period_start,period_end,revision_pending
  ) values ($1,$2,$3,$4,true)`,
  [company, workforce, periodStart, periodEnd]
);
const mappingRelockBlockedPreview = await preview();
assert.equal(mappingRelockBlockedPreview.eligible, false);
assert.equal(mappingRelockBlockedPreview.eligibility_code, "mapping_relock_required");
await db.query(
  "delete from public.verify_workforce_payout_mapping_revision_state where company_id=$1 and workforce_id=$2",
  [company, workforce]
);

await db.query(
  `update public.connect_profile_verifications
   set verified=false
   where company_id=$1 and account_id=$2 and profile_type='workforce' and kind='pan_aadhaar'`,
  [company, workforce]
);
const panBlockedPreview = await preview();
assert.equal(panBlockedPreview.eligible, false);
assert.equal(panBlockedPreview.eligibility_code, "pan_not_linked");
assert.equal(panBlockedPreview.payment_status, "PAN Not Linked");
assert.equal(Number(panBlockedPreview.available_to_pay), 0);
await db.query(
  `update public.connect_profile_verifications
   set verified=true
   where company_id=$1 and account_id=$2 and profile_type='workforce' and kind='pan_aadhaar'`,
  [company, workforce]
);

const setHold = async ({ operation, hold, remarks }) => {
  const result = await db.query(
    `select public.workforce_set_payout_payment_hold(
      $1,$2,$3,$4,$5::date,$6::date,$7,$8
    ) result`,
    [company, actor, operation, workforce, periodStart, periodEnd, hold, remarks]
  );
  return result.rows[0].result;
};

const noOpRelease = await setHold({
  operation: id(57),
  hold: false,
  remarks: "Already available for bank payment"
});
assert.equal(noOpRelease.changed, false);
assert.equal(noOpRelease.replayed, false);
const interveningHold = await setHold({
  operation: id(58),
  hold: true,
  remarks: "Temporary finance hold"
});
assert.equal(interveningHold.changed, true);
const noOpReleaseReplay = await setHold({
  operation: id(57),
  hold: false,
  remarks: "Already available for bank payment"
});
assert.equal(noOpReleaseReplay.changed, false);
assert.equal(noOpReleaseReplay.replayed, true);
const stateAfterNoOpReplay = await db.query(
  `select
     (select action from public.workforce_payout_payment_hold_events
       where company_id=$1 and workforce_id=$2 and period_start=$3 and period_end=$4
       order by created_at desc,id desc limit 1) latest_action,
     (select count(*)::int from public.workforce_payout_payment_hold_events
       where company_id=$1 and operation_id=$5) no_op_operation_count,
     (select state_changed from public.workforce_payout_payment_hold_events
       where company_id=$1 and operation_id=$5) no_op_state_changed`,
  [company, workforce, periodStart, periodEnd, id(57)]
);
assert.deepEqual(stateAfterNoOpReplay.rows[0], {
  latest_action: "hold",
  no_op_operation_count: 1,
  no_op_state_changed: false
});
const restoredAfterNoOpReplay = await setHold({
  operation: id(59),
  hold: false,
  remarks: "Regression setup restored"
});
assert.equal(restoredAfterNoOpReplay.changed, true);
await assert.rejects(
  setHold({ operation: id(60), hold: true, remarks: "x" }),
  /remark between 3 and 1000 characters/i
);
const held = await setHold({ operation: id(60), hold: true, remarks: "Awaiting finance review" });
assert.equal(held.on_hold, true);
assert.equal(held.replayed, false);
const heldReplay = await setHold({ operation: id(60), hold: true, remarks: "Awaiting finance review" });
assert.equal(heldReplay.replayed, true);
const heldPreview = await preview();
assert.equal(heldPreview.eligible, false);
assert.equal(heldPreview.eligibility_code, "payment_on_hold");
assert.equal(heldPreview.payment_status, "Payment On Hold");
assert.equal(Number(heldPreview.available_to_pay), 0);
await assert.rejects(
  db.query(
    `update public.workforce_payout_payment_hold_events
     set remarks='Tampered hold reason' where company_id=$1 and operation_id=$2`,
    [company, id(60)]
  ),
  /only by the payment lifecycle RPC|history is immutable/i
);
const released = await setHold({ operation: id(61), hold: false, remarks: "Finance review completed" });
assert.equal(released.on_hold, false);
const holdAudit = await db.query(
  `select action,state_changed,remarks from public.workforce_payout_payment_hold_events
   where company_id=$1 and workforce_id=$2 order by created_at,id`,
  [company, workforce]
);
assert.deepEqual(holdAudit.rows, [
  { action: "release", state_changed: false, remarks: "Already available for bank payment" },
  { action: "hold", state_changed: true, remarks: "Temporary finance hold" },
  { action: "release", state_changed: true, remarks: "Regression setup restored" },
  { action: "hold", state_changed: true, remarks: "Awaiting finance review" },
  { action: "release", state_changed: true, remarks: "Finance review completed" }
]);

const payablePreview = await preview();
assert.equal(payablePreview.eligible, true);
assert.equal(payablePreview.eligibility_code, "eligible");
assert.equal(Number(payablePreview.current_target_amount), 11836);
assert.equal(Number(payablePreview.paid_amount), 0);
assert.equal(Number(payablePreview.available_to_pay), 11836);
assert.notEqual(
  dependencyHash,
  "unrelated-live-dependency-change",
  "the functional test must exercise a live hash that differs from the immutable publication hash"
);
const assertNoIdentifierFailureLock = async (operation) => {
  const result = await db.query(
    `select
      (select count(*)::int from public.workforce_payout_payment_batches where operation_id=$1) batch_count,
      (select count(*)::int from public.workforce_payout_payment_items
        where company_id=$2 and workforce_id=$3 and period_start=$4 and period_end=$5
          and status='processing') processing_count`,
    [operation, company, workforce, periodStart, periodEnd]
  );
  assert.deepEqual(result.rows[0], { batch_count: 0, processing_count: 0 },
    "invalid bank identifiers must not leave a processing batch or profile lock");
};

await db.query("update public.payment_banks set account_no='0011-223344' where id=$1", [bank]);
await assert.rejects(
  createBatch({ operation: id(40), fingerprint: "4".repeat(64) }),
  /Federal Bank debit account must contain 4 to 30 letters or digits/i
);
await assertNoIdentifierFailureLock(id(40));
await db.query("update public.payment_banks set account_no=' 0011 223344 ',ifsc='FDRL1000001' where id=$1", [bank]);
await assert.rejects(
  createBatch({ operation: id(41), fingerprint: "5".repeat(64) }),
  /Federal Bank IFSC must use the standard 11-character format/i
);
await assertNoIdentifierFailureLock(id(41));
await db.query("update public.payment_banks set ifsc=' fdrl 0000001 ' where id=$1", [bank]);

await db.query("update public.workforce set bank_account_no='1234-567890' where id=$1", [workforce]);
await assert.rejects(
  createBatch({ operation: id(42), fingerprint: "6".repeat(64) }),
  /Bank account for Workforce ID D111 must contain 4 to 30 letters or digits/i
);
await assertNoIdentifierFailureLock(id(42));
await db.query("update public.workforce set bank_account_no=' 1234 567890 ',ifsc_code='FDRL1000002' where id=$1", [workforce]);
await assert.rejects(
  createBatch({ operation: id(43), fingerprint: "7".repeat(64) }),
  /IFSC for Workforce ID D111 must use the standard 11-character format/i
);
await assertNoIdentifierFailureLock(id(43));
await db.query("update public.workforce set ifsc_code=' fdrl 0000002 ' where id=$1", [workforce]);
await db.query("update public.workforce set dropx_id='---' where id=$1", [workforce]);
await assert.rejects(
  createBatch({ operation: id(44), fingerprint: "8".repeat(64) }),
  /cannot produce a valid Workforce bank reference/i
);
await assertNoIdentifierFailureLock(id(44));
await db.query("update public.workforce set dropx_id='D111' where id=$1", [workforce]);

await assert.rejects(
  db.query(
    `insert into public.workforce_payout_payment_batches(
      company_id,operation_id,request_fingerprint,selected_workforce_ids,bank_id,
      period_start,period_end,value_date,debit_account_no_snapshot,
      bank_code_snapshot,file_type_snapshot,status,generated_by
    ) values ($1,$2,$3,array[$4::uuid],$5,$6,$7,date '2026-10-10',
      '0011223344','FEDERAL_BANK','fedone','processing',$8)`,
    [company, id(19), "9".repeat(64), workforce, bank, periodStart, periodEnd, actor]
  ),
  /only by the bank-processing RPCs/i
);

const first = await createBatch({ operation: id(20), fingerprint: "a".repeat(64) });
assert.equal(first.replayed, false);
assert.equal(first.items.length, 1);
assert.equal(first.items[0].reference_no, "WPD111092026V1");
assert.equal(Number(first.items[0].instruction_amount), 11836);
assert.equal(first.items[0].credit_remarks, "NLRF");
assert.equal(first.items[0].debit_account_no, "0011223344");
assert.equal(first.items[0].bank_account_no, "1234567890");
assert.equal(first.items[0].ifsc, "FDRL0000002");
const processingPreview = await preview();
assert.equal(processingPreview.eligible, false);
assert.equal(processingPreview.eligibility_code, "payment_processing");
assert.equal(processingPreview.payment_status, "Payment Processing");
assert.equal(Number(processingPreview.current_target_amount), 11836);
assert.equal(Number(processingPreview.processing_amount), 11836);
assert.equal(Number(processingPreview.available_to_pay), 0);
const allocationTotal = await db.query(
  `select count(*)::int allocation_count,
    sum(allocation.instruction_amount_snapshot) instruction_total
  from public.workforce_payout_payment_allocations allocation
  join public.workforce_payout_payment_items item on item.id=allocation.payment_item_id
  where item.reference_no='WPD111092026V1'`
);
assert.equal(allocationTotal.rows[0].allocation_count, 2);
assert.equal(Number(allocationTotal.rows[0].instruction_total), 11836,
  "station allocation instruction snapshots must sum exactly to the item instruction");
await assert.rejects(
  db.query(
    "update public.workforce_payout_payment_items set updated_at=clock_timestamp() where company_id=$1 and reference_no=$2",
    [company, "WPD111092026V1"]
  ),
  /only by the bank-processing RPCs/i
);

const replay = await createBatch({ operation: id(20), fingerprint: "a".repeat(64) });
assert.equal(replay.replayed, true);
assert.equal(replay.batch_id, first.batch_id);

await assert.rejects(
  db.query(
    "insert into public.workforce_payment_allocations(company_id,workforce_id,effective_from,effective_to) values ($1,$2,date '2026-08-01',null)",
    [company, workforce]
  ),
  /Payment Processing is active/i,
  "a null allocation end date must mean infinity and block an overlapping change"
);
await assert.rejects(
  db.query("update public.workforce_payout_review_submissions set status='returned' where id=$1", [review]),
  /Payment Processing is active/i
);
await assert.rejects(
  db.query("insert into public.workforce_payment_settings(company_id,effective_from) values ($1,date '2026-09-01')", [company]),
  /bank payment.*processing/i
);
await assert.rejects(
  db.query(
    "insert into public.field_executive_provider_mappings(company_id,workforce_id,effective_from,effective_to,status) values ($1,$2,date '2026-08-01',null,'active')",
    [company, workforce]
  ),
  /Payment Processing is active/i
);
await assert.rejects(
  db.query(
    "insert into public.workforce_payout_mapping_relocks(company_id,period_start,period_end,affected_workforce_ids) values ($1,$2,$3,array[$4::uuid])",
    [company, periodStart, periodEnd, workforce]
  ),
  /Payment Processing is active/i
);

const finalize = async ({ operation, hash, referenceNo, amountPaise, status, utrCin = "", remarks = "" }) => {
  const rows = [{
    row_number: 2,
    reference_no: referenceNo,
    credit_account: "1234567890",
    ifsc: "FDRL0000002",
    debit_amount_paise: amountPaise,
    status,
    utr_cin: utrCin,
    remarks
  }];
  const result = await db.query(
    `select public.workforce_finalize_payout_payment_response(
      $1,$2,$3,$4,'response.xlsx',$5::jsonb
    ) result`,
    [company, actor, operation, hash, JSON.stringify(rows)]
  );
  return result.rows[0].result;
};
const transitionPayment = async ({ operation, paymentItemId, outcome, remarks }) => {
  const result = await db.query(
    `select public.workforce_transition_payout_payment_item(
      $1,$2,$3,$4,$5,$6
    ) result`,
    [company, actor, operation, paymentItemId, outcome, remarks]
  );
  return result.rows[0].result;
};
const paid = await finalize({
  operation: id(21),
  hash: "b".repeat(64),
  referenceNo: "WPD111092026V1",
  amountPaise: 1183600,
  status: "PAID",
  utrCin: "UTR-001",
  remarks: "SUCCESS"
});
assert.equal(paid.paid, 1);
assert.equal(paid.cancelled, 0);
const paidReplay = await finalize({
  operation: id(21),
  hash: "b".repeat(64),
  referenceNo: "WPD111092026V1",
  amountPaise: 1183600,
  status: "PAID",
  utrCin: "UTR-001",
  remarks: "SUCCESS"
});
assert.equal(paidReplay.replayed, true);
const terminal = await db.query(
  "select status,utr_cin from public.workforce_payout_payment_items where reference_no='WPD111092026V1'"
);
assert.deepEqual(terminal.rows[0], { status: "paid", utr_cin: "UTR-001" });
const normalizedTerminalReplay = await finalize({
  operation: id(34),
  hash: "3".repeat(64),
  referenceNo: "WPD111092026V1",
  amountPaise: 1183600,
  status: "PAID",
  utrCin: " u t r / 0-0 1 ",
  remarks: "SUCCESS"
});
assert.equal(normalizedTerminalReplay.replayed_items, 1);
assert.equal(normalizedTerminalReplay.rejected, 0,
  "the same terminal instruction and normalized UTR/CIN must remain idempotent across response files");
await assert.rejects(
  createBatch({ operation: id(20), fingerprint: "a".repeat(64) }),
  /already partially or fully finalized.*cannot be regenerated/i,
  "an idempotency replay must not regenerate a bank file containing terminal instructions"
);

await db.query("update public.workforce_payout_review_submissions set status='returned' where id=$1", [review]);
await assert.rejects(
  createBatch({ operation: id(26), fingerprint: "2".repeat(64) }),
  /stale, incomplete, or not explicitly payment-eligible/i,
  "a returned current publication must not remain payable"
);
await db.query("update public.workforce_payout_review_submissions set status='under_review' where id=$1", [review]);

const legacySnapshot = JSON.stringify({
  schema_version: "2",
  source: "workforce_payout_worksheet",
  worksheet: {},
  item: { workforce_id: workforce, station_code: "NLRF", net_amount: "12000.00" }
});
await db.query(
  `insert into public.workforce_payout_publications(
    id,company_id,workforce_id,station_id,revision,snapshot,snapshot_hash,dependency_hash,
    mapping_relock_id,review_submission_id,publication_kind,period_start,period_end,published_at
  ) values ($1,$2,$3,$4,2,$5::jsonb,$6,$7,$8,$9,'worksheet',$10,$11,$12::timestamptz)`,
  [legacyPublication, company, workforce, station, legacySnapshot, "9".repeat(64), dependencyHash,
    mappingRelock, review, periodStart, periodEnd, "2026-10-09T10:00:00Z"]
);
const legacyPreview = await preview();
assert.equal(legacyPreview.eligible, true,
  "a bounded pre-marker worksheet publication remains payable during rollout");
assert.equal(Number(legacyPreview.available_to_pay), 1164);

const ineligibleSnapshot = JSON.stringify({
  schema_version: "2",
  source: "workforce_payout_worksheet",
  worksheet: { payment_eligible: false, payment_status: "Configuration incomplete" },
  item: { workforce_id: workforce, station_code: "NLRF", net_amount: "12000.00" }
});
await db.query(
  `insert into public.workforce_payout_publications(
    id,company_id,workforce_id,station_id,revision,snapshot,snapshot_hash,dependency_hash,
    mapping_relock_id,review_submission_id,publication_kind,period_start,period_end
  ) values ($1,$2,$3,$4,3,$5::jsonb,$6,$7,$8,$9,'worksheet',$10,$11)`,
  [ineligiblePublication, company, workforce, station, ineligibleSnapshot, "e".repeat(64), dependencyHash,
    mappingRelock, review, periodStart, periodEnd]
);
await assert.rejects(
  createBatch({ operation: id(27), fingerprint: "3".repeat(64) }),
  /not explicitly payment-eligible.*Republish or relock/i,
  "a current publication explicitly marked ineligible must reject the selected payout"
);

const unmarkedSnapshot = JSON.stringify({
  schema_version: "2",
  source: "workforce_payout_worksheet",
  worksheet: {},
  item: { workforce_id: workforce, station_code: "NLRF", net_amount: "12000.00" }
});
await db.query(
  `insert into public.workforce_payout_publications(
    id,company_id,workforce_id,station_id,revision,snapshot,snapshot_hash,dependency_hash,
    mapping_relock_id,review_submission_id,publication_kind,period_start,period_end,published_at
  ) values ($1,$2,$3,$4,4,$5::jsonb,$6,$7,$8,$9,'worksheet',$10,$11,$12::timestamptz)`,
  [unmarkedPublication, company, workforce, station, unmarkedSnapshot, "f".repeat(64), dependencyHash,
    mappingRelock, review, periodStart, periodEnd, "2026-10-10T01:00:00Z"]
);
await assert.rejects(
  createBatch({ operation: id(28), fingerprint: "4".repeat(64) }),
  /not explicitly payment-eligible.*Republish or relock/i,
  "a post-cutoff publication missing the eligibility marker must fail closed"
);

const snapshotV2 = JSON.stringify({
  schema_version: "2",
  source: "workforce_payout_worksheet",
  worksheet: { payment_eligible: true, payment_status: "Ready for review" },
  item: { workforce_id: workforce, station_code: "NLRF", net_amount: "12000.00" }
});
await db.query(
  `insert into public.workforce_payout_publications(
    id,company_id,workforce_id,station_id,revision,snapshot,snapshot_hash,dependency_hash,
    mapping_relock_id,review_submission_id,publication_kind,period_start,period_end
  ) values ($1,$2,$3,$4,5,$5::jsonb,$6,$7,$8,$9,'worksheet',$10,$11)`,
  [publicationV2, company, workforce, station, snapshotV2, "c".repeat(64), dependencyHash,
    mappingRelock, review, periodStart, periodEnd]
);
const deltaPreview = await preview();
assert.equal(deltaPreview.eligible, true);
assert.equal(deltaPreview.payment_status, "Partially paid");
assert.equal(Number(deltaPreview.current_target_amount), 13000);
assert.equal(Number(deltaPreview.paid_amount), 11836);
assert.equal(Number(deltaPreview.balance_payable), 1164);
assert.equal(Number(deltaPreview.available_to_pay), 1164);
const second = await createBatch({ operation: id(22), fingerprint: "d".repeat(64) });
assert.equal(second.items[0].reference_no, "WPD111092026V2");
assert.equal(Number(second.items[0].paid_before_amount), 11836);
assert.equal(Number(second.items[0].instruction_amount), 1164);

const secondItem = await db.query(
  "select id from public.workforce_payout_payment_items where company_id=$1 and reference_no='WPD111092026V2'",
  [company]
);
await assert.rejects(
  transitionPayment({ operation: id(23), paymentItemId: secondItem.rows[0].id, outcome: "cancelled", remarks: "x" }),
  /remark between 3 and 1000 characters/i
);
const cancelled = await transitionPayment({
  operation: id(23),
  paymentItemId: secondItem.rows[0].id,
  outcome: "cancelled",
  remarks: "Payment cancelled after bank rejection"
});
assert.equal(cancelled.outcome, "cancelled");
assert.equal(cancelled.batch_status, "completed");
const cancelledReplay = await transitionPayment({
  operation: id(23),
  paymentItemId: secondItem.rows[0].id,
  outcome: "cancelled",
  remarks: "Payment cancelled after bank rejection"
});
assert.equal(cancelledReplay.replayed, true);
const cancelledPreview = await preview();
assert.equal(cancelledPreview.eligible, true);
assert.equal(cancelledPreview.payment_status, "Payment Cancelled");
assert.equal(Number(cancelledPreview.available_to_pay), 1164);
const third = await createBatch({ operation: id(24), fingerprint: "f".repeat(64) });
assert.equal(third.items[0].reference_no, "WPD111092026V3", "cancelled attempts must consume a version");
assert.equal(Number(third.items[0].instruction_amount), 1164);
await assert.rejects(
  createBatch({ operation: id(25), fingerprint: "1".repeat(64) }),
  /already (?:has|have) a Payment Processing instruction/i
);

const duplicateTransaction = await finalize({
  operation: id(30),
  hash: "6".repeat(64),
  referenceNo: "WPD111092026V3",
  amountPaise: 116400,
  status: "PAID",
  utrCin: " utr / 0-0 1 ",
  remarks: "SUCCESS"
});
assert.equal(duplicateTransaction.paid, 0);
assert.equal(duplicateTransaction.rejected, 1);
assert.match(duplicateTransaction.rows[0].message, /already recorded for another paid Workforce instruction/i);
const stillProcessingAfterDuplicate = await db.query(
  "select status from public.workforce_payout_payment_items where reference_no='WPD111092026V3'"
);
assert.equal(stillProcessingAfterDuplicate.rows[0].status, "processing",
  "case, whitespace and punctuation variants of a paid UTR/CIN must not finalize a second instruction");

for (const [offset, utrCin, hashCharacter] of [
  [0, "N/A", "7"],
  [1, "N-A", "8"],
  [2, "NIL", "9"],
  [4, "NONE", "4"],
  [6, "---", "a"]
]) {
  const placeholderResult = await finalize({
    operation: id(31 + Number(offset)),
    hash: String(hashCharacter).repeat(64),
    referenceNo: "WPD111092026V3",
    amountPaise: 116400,
    status: "PAID",
    utrCin: String(utrCin),
    remarks: "SUCCESS"
  });
  assert.equal(placeholderResult.paid, 0);
  assert.equal(placeholderResult.rejected, 1);
  assert.match(placeholderResult.rows[0].message, /meaningful bank UTR\/CIN.*placeholder values/i);
}
const stillProcessingAfterPlaceholders = await db.query(
  "select status from public.workforce_payout_payment_items where reference_no='WPD111092026V3'"
);
assert.equal(stillProcessingAfterPlaceholders.rows[0].status, "processing",
  "placeholder bank identifiers must never finalize a paid instruction");
const meaningfulPaid = await finalize({
  operation: id(36),
  hash: "5".repeat(64),
  referenceNo: "WPD111092026V3",
  amountPaise: 116400,
  status: "PAID",
  utrCin: "UTR-003",
  remarks: "SUCCESS"
});
assert.equal(meaningfulPaid.paid, 1);

const revisedAfterPaymentSnapshot = JSON.stringify({
  schema_version: "2",
  source: "workforce_payout_worksheet",
  worksheet: { payment_eligible: true, payment_status: "Ready for review" },
  item: { workforce_id: workforce, station_code: "NLRF", net_amount: "13000.00" }
});
await db.query(
  `insert into public.workforce_payout_publications(
    id,company_id,workforce_id,station_id,revision,snapshot,snapshot_hash,dependency_hash,
    mapping_relock_id,review_submission_id,publication_kind,period_start,period_end
  ) values ($1,$2,$3,$4,6,$5::jsonb,$6,$7,$8,$9,'worksheet',$10,$11)`,
  [id(70), company, workforce, station, revisedAfterPaymentSnapshot, "7".repeat(64), dependencyHash,
    mappingRelock, review, periodStart, periodEnd]
);
const revisedDeltaPreview = await preview();
assert.equal(revisedDeltaPreview.eligible, true);
assert.equal(revisedDeltaPreview.payment_status, "Partially paid");
assert.equal(Number(revisedDeltaPreview.current_target_amount), 14000);
assert.equal(Number(revisedDeltaPreview.paid_amount), 13000);
assert.equal(Number(revisedDeltaPreview.available_to_pay), 1000);
const fourth = await createBatch({ operation: id(71), fingerprint: "7".repeat(64) });
assert.equal(fourth.items[0].reference_no, "WPD111092026V4");
assert.equal(Number(fourth.items[0].instruction_amount), 1000);
const fourthItem = await db.query(
  "select id from public.workforce_payout_payment_items where company_id=$1 and reference_no='WPD111092026V4'",
  [company]
);
const failed = await transitionPayment({
  operation: id(72),
  paymentItemId: fourthItem.rows[0].id,
  outcome: "failed",
  remarks: "Beneficiary bank rejected the transfer"
});
assert.equal(failed.outcome, "failed");
assert.equal(failed.batch_status, "completed");
const failedPreview = await preview();
assert.equal(failedPreview.eligible, true);
assert.equal(failedPreview.payment_status, "Payment Failed");
assert.equal(Number(failedPreview.available_to_pay), 1000);
const fifth = await createBatch({ operation: id(73), fingerprint: "8".repeat(64) });
assert.equal(fifth.items[0].reference_no, "WPD111092026V5", "failed attempts must consume a version");
assert.equal(Number(fifth.items[0].instruction_amount), 1000);
const fifthItem = await db.query(
  "select id from public.workforce_payout_payment_items where company_id=$1 and reference_no='WPD111092026V5'",
  [company]
);
await transitionPayment({
  operation: id(74),
  paymentItemId: fifthItem.rows[0].id,
  outcome: "cancelled",
  remarks: "Payment run cancelled by Finance"
});
const manualAudit = await db.query(
  `select event_type,event_data->>'remarks' remarks
   from public.workforce_payout_payment_events
   where company_id=$1 and operation_id in ($2,$3)
   order by event_type`,
  [company, id(72), id(74)]
);
assert.deepEqual(manualAudit.rows, [
  { event_type: "payment_cancelled_manually", remarks: "Payment run cancelled by Finance" },
  { event_type: "payment_failed_manually", remarks: "Beneficiary bank rejected the transfer" }
]);
await assert.rejects(
  db.query(
    `update public.workforce_payout_payment_events
     set event_data=jsonb_set(event_data,'{remarks}','"Tampered"'::jsonb)
     where company_id=$1 and operation_id=$2`,
    [company, id(72)]
  ),
  /audit rows (?:are immutable|may be appended only)/i
);

const catalog = await db.query(`
  select
    (select count(*)::int from pg_trigger
      where not tgisinternal and tgname like '%bank_processing%') trigger_count,
    exists(select 1 from pg_trigger where not tgisinternal
      and tgname='field_executive_provider_mappings_00_published_processing_guard') provider_trigger,
    (select relrowsecurity and relforcerowsecurity from pg_class
      where oid='public.workforce_payout_payment_items'::regclass) item_rls,
    has_table_privilege('service_role','public.workforce_payout_payment_items','SELECT') item_select,
    has_table_privilege('service_role','public.workforce_payout_payment_items','INSERT') item_insert,
    (select relrowsecurity and relforcerowsecurity from pg_class
      where oid='public.workforce_payout_payment_hold_events'::regclass) hold_rls,
    has_table_privilege('service_role','public.workforce_payout_payment_hold_events','SELECT') hold_select,
    has_table_privilege('service_role','public.workforce_payout_payment_hold_events','INSERT') hold_insert,
    has_table_privilege('service_role','public.workforce_payout_review_submissions','INSERT') review_insert,
    has_function_privilege('service_role',
      'public.workforce_create_payout_payment_batch(uuid,uuid,uuid,text,uuid,date,date,date,uuid[])',
      'EXECUTE') create_execute,
    has_function_privilege('service_role',
      'public.workforce_preview_payout_payments(uuid,date,date,uuid[])',
      'EXECUTE') preview_execute,
    has_function_privilege('authenticated',
      'public.workforce_preview_payout_payments(uuid,date,date,uuid[])',
      'EXECUTE') authenticated_preview_execute,
    has_function_privilege('service_role',
      'public.workforce_payout_payment_candidates(uuid,date,date,uuid[])',
      'EXECUTE') candidate_execute,
    has_function_privilege('authenticated',
      'public.workforce_create_payout_payment_batch(uuid,uuid,uuid,text,uuid,date,date,date,uuid[])',
      'EXECUTE') authenticated_execute,
    has_function_privilege('service_role',
      'public.workforce_payout_payment_interval_is_processing(uuid,date,date)',
      'EXECUTE') internal_execute,
    has_function_privilege('service_role',
      'public.workforce_set_payout_payment_hold(uuid,uuid,uuid,uuid,date,date,boolean,text)',
      'EXECUTE') hold_execute,
    has_function_privilege('authenticated',
      'public.workforce_set_payout_payment_hold(uuid,uuid,uuid,uuid,date,date,boolean,text)',
      'EXECUTE') authenticated_hold_execute,
    has_function_privilege('service_role',
      'public.workforce_transition_payout_payment_item(uuid,uuid,uuid,uuid,text,text)',
      'EXECUTE') transition_execute,
    has_function_privilege('authenticated',
      'public.workforce_transition_payout_payment_item(uuid,uuid,uuid,uuid,text,text)',
      'EXECUTE') authenticated_transition_execute
`);
assert.ok(Number(catalog.rows[0].trigger_count) >= 13);
assert.equal(catalog.rows[0].provider_trigger, true);
assert.equal(catalog.rows[0].item_rls, true);
assert.equal(catalog.rows[0].item_select, true);
assert.equal(catalog.rows[0].item_insert, false);
assert.equal(catalog.rows[0].hold_rls, true);
assert.equal(catalog.rows[0].hold_select, true);
assert.equal(catalog.rows[0].hold_insert, false);
assert.equal(catalog.rows[0].review_insert, false);
assert.equal(catalog.rows[0].create_execute, true);
assert.equal(catalog.rows[0].preview_execute, true);
assert.equal(catalog.rows[0].authenticated_preview_execute, false);
assert.equal(catalog.rows[0].candidate_execute, false);
assert.equal(catalog.rows[0].authenticated_execute, false);
assert.equal(catalog.rows[0].internal_execute, false);
assert.equal(catalog.rows[0].hold_execute, true);
assert.equal(catalog.rows[0].authenticated_hold_execute, false);
assert.equal(catalog.rows[0].transition_execute, true);
assert.equal(catalog.rows[0].authenticated_transition_execute, false);

await db.close();
console.log("Workforce payout bank payment ledger verification passed.");
