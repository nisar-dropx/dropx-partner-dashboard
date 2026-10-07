import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const source = readFileSync(
  new URL("../supabase/migrations/20261008004000_workforce_payout_notification_publication.sql", import.meta.url),
  "utf8"
).replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");
if (!/disputed_publication\.station_id = pub\.station_id[\s\S]*disputed_publication\.period_start = pub\.period_start[\s\S]*disputed_publication\.period_end = pub\.period_end/.test(source)) {
  throw new Error("Open worksheet disputes must remain unique across revisions of the same Workforce, station and month.");
}
if (!/if publication\.publication_kind = 'worksheet' then\s+if p_locations is not null then\s+raise exception 'Company-wide location access is required to retry a worksheet payout notification'/.test(source)) {
  throw new Error("Worksheet payout notification retries must require company-wide location access.");
}
const db = new PGlite();
await db.exec(`
  create schema auth;
  do $$ begin create role anon; create role authenticated; create role service_role; end $$;
  create table auth.users(id uuid primary key);
  create table public.companies(id uuid primary key);
  create table public.stations(id uuid primary key, company_id uuid, station_code text);
  create table public.workforce_payroll_runs(id uuid primary key, company_id uuid, status text, calculated_at timestamptz, period_start date, period_end date);
  create table public.workforce(id uuid primary key, company_id uuid, deleted_at timestamptz, migration_state text, mobile text, mobile_country_code text);
  create table public.workforce_payout_review_submissions(id uuid primary key default gen_random_uuid(), company_id uuid, subject_type text, subject_id uuid, location_id uuid, period_start date, period_end date, status text, calculation_snapshot jsonb, submitted_by uuid, submitted_at timestamptz, updated_at timestamptz, unique(company_id,subject_type,subject_id,location_id,period_start,period_end));
  create table public.field_executive_provider_mappings(id uuid primary key, company_id uuid, workforce_id uuid, field_executive_id uuid, employee_id uuid, contractor_id uuid, status text, effective_from date, effective_to date, updated_at timestamptz);
  create table public.workforce_payment_allocations(id uuid primary key, company_id uuid, workforce_id uuid, status text, effective_from date, effective_to date, updated_at timestamptz);
  create table public.whatsapp_notification_configs(id uuid primary key, company_id uuid, event_code text, is_enabled boolean, whatsapp_profile_id uuid, template_id text, template_name text, template_language text, variable_mappings jsonb, updated_at timestamptz);
  create table public.whatsapp_profiles(id uuid primary key, company_id uuid, is_active boolean, phone_number_id text);
  create table public.whatsapp_template_cache(company_id uuid, whatsapp_profile_id uuid, template_id text, name text, language text, status text, components jsonb);
  create table public.whatsapp_settings(company_id uuid primary key, is_enabled boolean);
  create table public.workforce_payroll_items(id uuid primary key, company_id uuid, payroll_run_id uuid, workforce_id uuid, station_id uuid, status text);
  create table public.workforce_payroll_lines(id uuid primary key, company_id uuid, payroll_run_id uuid, workforce_id uuid, source_id uuid, calculation_snapshot jsonb);
  create table public.workforce_payroll_events(id uuid primary key default gen_random_uuid(), company_id uuid, payroll_run_id uuid, event_code text, actor_user_id uuid, metadata jsonb);
  create function public.lock_workforce_payment_allocation_company(uuid) returns void language sql as $$select$$;
  create function public.workforce_provider_mapping_person(uuid,uuid,uuid,uuid,uuid) returns uuid language sql immutable as $$select coalesce($2,$3,$4,$5)$$;
  create function public.workforce_advance_recovery_snapshot_hash(uuid,date,date) returns text language sql stable as $$select 'hash'::text$$;
  ${source}
`);

const functions = await db.query(`
  select proname from pg_proc
  where pronamespace = 'public'::regnamespace
    and proname in (
      'workforce_publish_payout_notifications',
      'workforce_raise_payout_dispute',
      'workforce_reply_payout_dispute',
      'workforce_retry_payout_notice',
      'workforce_update_payout_dispute',
      'workforce_propose_payout_correction',
      'workforce_review_payout_correction'
    )
  order by proname
`);
if (functions.rows.length !== 7) throw new Error("The fresh-schema payout publication RPC set is incomplete.");

const triggers = await db.query(`
  select tgname from pg_trigger
  where not tgisinternal and tgname in (
    'workforce_payout_publications_00_immutable',
    'field_executive_provider_mappings_00_published_payout_guard',
    'workforce_payment_allocations_00_published_payout_guard'
  )
`);
if (triggers.rows.length !== 3) throw new Error("The payout publication lock triggers are incomplete.");

const company = "00000000-0000-4000-8000-000000000001";
const actor = "00000000-0000-4000-8000-000000000002";
const station = "00000000-0000-4000-8000-000000000003";
const otherStation = "00000000-0000-4000-8000-000000000004";
const workforce = "00000000-0000-4000-8000-000000000005";
const submission = "00000000-0000-4000-8000-000000000006";
const worksheetPublication = "00000000-0000-4000-8000-000000000007";
const payrollRun = "00000000-0000-4000-8000-000000000008";
const legacyPublication = "00000000-0000-4000-8000-000000000009";
await db.query(`insert into auth.users(id) values ($1)`, [actor]);
await db.query(`insert into public.companies(id) values ($1)`, [company]);
await db.query(`insert into public.stations(id,company_id,station_code) values ($1,$2,'ONE'),($3,$2,'TWO')`, [station, company, otherStation]);
await db.query(`insert into public.workforce(id,company_id) values ($1,$2)`, [workforce, company]);
await db.query(`insert into public.workforce_payout_review_submissions(id,company_id,subject_type,subject_id,location_id,period_start,period_end,status)
  values ($1,$2,'workforce',$3,$4,'2026-09-01','2026-09-30','under_review')`, [submission, company, workforce, station]);
await db.query(`insert into public.workforce_payout_publications(
    id,company_id,workforce_id,station_id,revision,snapshot,published_by,review_until,notify_at,source_calculated_at,
    notification_status,review_submission_id,period_start,period_end,snapshot_hash,dependency_hash,notification_config_snapshot,publication_kind
  ) values ($1,$2,$3,$4,1,'{"schema_version":"2"}'::jsonb,$5,now()+interval '1 day',now(),now(),'failed',$6,
    '2026-09-01','2026-09-30','snapshot','dependency','{"schema_version":"1"}'::jsonb,'worksheet')`,
  [worksheetPublication, company, workforce, station, actor, submission]);
await assert.rejects(
  db.query(`select public.workforce_retry_payout_notice($1,$2,$3,array[$4]::uuid[])`, [company, actor, worksheetPublication, station]),
  /company-wide location access is required/i,
  "station-scoped users must not retry a company-wide worksheet notification"
);
await db.query(`select public.workforce_retry_payout_notice($1,$2,$3,null)`, [company, actor, worksheetPublication]);
if ((await db.query(`select notification_status from public.workforce_payout_publications where id=$1`, [worksheetPublication])).rows[0].notification_status !== "pending") {
  throw new Error("A company-wide worksheet notification retry was not queued.");
}

await db.query(`insert into public.workforce_payroll_runs(id,company_id,status,calculated_at,period_start,period_end)
  values ($1,$2,'review',now(),'2026-09-01','2026-09-30')`, [payrollRun, company]);
await db.query(`insert into public.workforce_payout_publications(
    id,company_id,payroll_run_id,workforce_id,station_id,revision,snapshot,published_by,review_until,notify_at,source_calculated_at,notification_status,publication_kind
  ) select $1,$2,$3,$4,$5,1,'{}'::jsonb,$6,now()+interval '1 day',now(),calculated_at,'failed','legacy_payroll'
    from public.workforce_payroll_runs where id=$3`,
  [legacyPublication, company, payrollRun, workforce, station, actor]);
await assert.rejects(
  db.query(`select public.workforce_retry_payout_notice($1,$2,$3,array[$4]::uuid[])`, [company, actor, legacyPublication, otherStation]),
  /outside your station scope/i,
  "legacy notification retries must retain station scoping"
);
await db.query(`select public.workforce_retry_payout_notice($1,$2,$3,array[$4]::uuid[])`, [company, actor, legacyPublication, station]);
if ((await db.query(`select notification_status from public.workforce_payout_publications where id=$1`, [legacyPublication])).rows[0].notification_status !== "pending") {
  throw new Error("An authorized station-scoped legacy notification retry was not queued.");
}

console.log("Workforce payout publication migration verification passed.");
