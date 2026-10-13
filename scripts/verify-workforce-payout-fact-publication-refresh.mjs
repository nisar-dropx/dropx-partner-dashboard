import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync(
  new URL("../supabase/migrations/20261012200000_workforce_payout_fact_publication_refresh.sql", import.meta.url),
  "utf8"
).replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");

assert.match(migration, /attendance_daily_90_queue_payout_publication_refresh/i);
assert.match(migration, /cps_shipment_daily_90_queue_payout_publication_refresh/i);
assert.match(migration, /referencing old table as workforce_payout_fact_old_rows[\s\S]*new table as workforce_payout_fact_new_rows/i);
assert.match(migration, /mapping\.station_id = station\.id/i);
assert.match(migration, /mapping_order = 1/i);
assert.match(migration, /open_job\.status in \('pending', 'processing'\)/i);
assert.match(migration, /not public\.workforce_payout_payment_is_processing/i);
assert.match(migration, /jsonb_agg\(to_jsonb\(batch_row\)/i);
assert.match(
  migration,
  /concat_ws\(' ', nullif\(provider\.code, ''\), nullif\(provider\.name, ''\)\)/i,
  "shipment refresh matching must normalize the same provider code + name identity as the payout loader"
);
assert.doesNotMatch(
  migration,
  /coalesce\(nullif\(provider\.name, ''\), provider\.code, ''\)/i,
  "a populated provider name must not hide a matching provider code"
);
assert.match(migration, /create or replace function public\.workforce_preview_payout_payment_rows/i);
assert.match(migration, /public\.workforce_payout_effective_paid_allocations/i);
assert.match(migration, /candidate\.available_to_pay/i);
assert.doesNotMatch(
  migration,
  /create or replace function public\.workforce_payout_payment_row_candidates/i,
  "the transactional bank candidate must remain unchanged and fail closed during refresh"
);
assert.doesNotMatch(migration, /DF1088|KGQC1201|DF1096/i);

const db = new PGlite();
const id = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const dateOnly = (value) => value instanceof Date
  ? value.toISOString().slice(0, 10)
  : String(value).slice(0, 10);

const company = id(1);
const actor = id(2);
const stationA = id(3);
const stationB = id(4);
const stationC = id(5);
const workforceA = id(10);
const workforceB = id(11);
const workforceC = id(12);
const method = id(20);
const field = id(21);
const provider = id(22);
const mappingA = id(30);
const mappingB = id(31);
const mappingC = id(32);
const publicationA = id(40);
const publicationAOther = id(41);
const publicationB = id(42);
const publicationC = id(43);
const attendance = id(50);
const shipment = id(51);
const processingItem = id(60);
const paidItem = id(61);
const processingAllocation = id(62);
const paidAllocation = id(63);

try {
  await db.exec(`
    create schema auth;
    create role anon;
    create role authenticated;
    create role service_role;
    create table auth.users(id uuid primary key);

    create table public.companies(id uuid primary key);
    create table public.stations(
      id uuid primary key,
      company_id uuid not null,
      station_code text not null,
      unique(company_id, id)
    );
    create table public.providers(
      id uuid primary key,
      company_id uuid not null,
      name text,
      code text
    );
    create table public.workforce(
      id uuid primary key,
      company_id uuid not null,
      source_profile_type text,
      source_profile_id uuid,
      biometric_id text,
      deleted_at timestamptz,
      migration_state text not null default 'active',
      unique(company_id, id)
    );
    create table public.payment_fields(
      id uuid primary key,
      company_id uuid not null,
      field_type text,
      calculation_source text
    );
    create table public.payment_method_components(
      id uuid primary key default gen_random_uuid(),
      payment_method_id uuid not null,
      payment_field_id uuid,
      component_type text,
      is_active boolean not null default true
    );
    create table public.field_executive_provider_mappings(
      id uuid primary key,
      company_id uuid not null,
      provider_member_id text,
      station_id uuid not null,
      provider_id uuid,
      workforce_id uuid,
      employee_id uuid,
      contractor_id uuid,
      field_executive_id uuid,
      payment_method_id uuid,
      effective_from date not null,
      effective_to date,
      status text not null
    );
    create table public.workforce_payment_allocations(
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null,
      workforce_id uuid not null,
      station_id uuid not null,
      payment_method_id uuid not null,
      payment_components jsonb not null default '[]'::jsonb,
      effective_from date not null,
      effective_to date,
      status text not null
    );
    create table public.workforce_payout_publications(
      id uuid primary key,
      company_id uuid not null,
      publication_kind text not null,
      workforce_id uuid not null,
      station_id uuid not null,
      period_start date not null,
      period_end date not null,
      revision integer not null,
      published_at timestamptz not null,
      published_by uuid
    );
    create table public.workforce_payout_publication_refresh_jobs(
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null,
      input_batch_id uuid,
      refresh_source text not null,
      refresh_request_id uuid not null,
      workforce_id uuid not null,
      station_id uuid not null,
      period_start date not null,
      period_end date not null,
      base_publication_id uuid not null,
      base_revision integer not null,
      requested_by uuid,
      status text not null default 'pending',
      claim_attempts integer not null default 0,
      max_attempts integer not null default 5,
      next_attempt_at timestamptz not null default clock_timestamp(),
      created_at timestamptz not null default clock_timestamp(),
      unique(company_id, refresh_request_id, workforce_id, station_id, period_start, period_end)
    );
    create table public.workforce_payout_payment_items(
      id uuid primary key,
      company_id uuid not null,
      workforce_id uuid not null,
      period_start date not null,
      period_end date not null,
      status text not null,
      instruction_amount numeric(14,2) not null default 0
    );
    create table public.workforce_payout_payment_allocations(
      id uuid primary key,
      company_id uuid not null,
      payment_item_id uuid not null,
      station_id uuid not null,
      instruction_amount_snapshot numeric(14,2) not null
    );
    create table public.workforce_payout_effective_paid_allocations(
      company_id uuid not null,
      payment_allocation_id uuid primary key,
      payment_item_id uuid not null,
      credited_workforce_id uuid not null,
      station_id uuid not null,
      period_start date not null,
      period_end date not null,
      instruction_amount_snapshot numeric(14,2) not null
    );
    create table public.attendance_daily(
      id uuid primary key,
      company_id uuid not null,
      workforce_id uuid,
      employee_id uuid,
      contractor_id uuid,
      field_executive_id uuid,
      enrolment_id text,
      punch_date date not null,
      status text,
      in_time timestamptz,
      out_time timestamptz,
      work_minutes integer,
      punch_count integer,
      updated_at timestamptz not null default clock_timestamp()
    );
    create table public.cps_shipment_daily(
      id uuid primary key,
      company_id uuid not null,
      client text,
      work_date date not null,
      station_code text,
      provider_employee_id text,
      amazon_delivery numeric,
      swa_delivery numeric,
      total_delivery numeric,
      c_return numeric,
      mfn numeric,
      mfn_return numeric,
      updated_at timestamptz not null default clock_timestamp()
    );

    create or replace function public.workforce_payout_payment_is_processing(
      p_company_id uuid, p_workforce_id uuid, p_period_start date, p_period_end date
    ) returns boolean language sql stable set search_path = '' as $$
      select exists(
        select 1 from public.workforce_payout_payment_items item
        where item.company_id=p_company_id and item.workforce_id=p_workforce_id
          and item.status='processing'
          and daterange(item.period_start,item.period_end,'[]')
            && daterange(p_period_start,p_period_end,'[]')
      )
    $$;

    create or replace function public.workforce_claim_payout_publication_refresh_jobs(
      p_limit integer, p_company_id uuid default null, p_batch_id uuid default null
    ) returns setof public.workforce_payout_publication_refresh_jobs
    language plpgsql security definer set search_path = '' as $function$
    begin
      return query
      with eligible as (
        select job.id
        from public.workforce_payout_publication_refresh_jobs job
        where (p_company_id is null or job.company_id=p_company_id)
          and job.claim_attempts < job.max_attempts
          and (
            job.status='pending' and job.next_attempt_at <= clock_timestamp()
          )
      )
      select job.* from public.workforce_payout_publication_refresh_jobs job
      join eligible on eligible.id=job.id limit p_limit;
    end
    $function$;

    create or replace function public.workforce_claim_selected_payout_publication_refresh_jobs(
      p_limit integer, p_company_id uuid, p_workforce_ids uuid[],
      p_period_start date, p_period_end date
    ) returns setof public.workforce_payout_publication_refresh_jobs
    language plpgsql security definer set search_path = '' as $function$
    begin
      return query
      with eligible as (
        select job.id
        from public.workforce_payout_publication_refresh_jobs job
        where job.company_id=p_company_id and job.workforce_id=any(p_workforce_ids)
          and job.period_start=p_period_start and job.period_end=p_period_end
          and job.claim_attempts < job.max_attempts
          and (
            job.status='pending' and job.next_attempt_at <= clock_timestamp()
          )
      )
      select job.* from public.workforce_payout_publication_refresh_jobs job
      join eligible on eligible.id=job.id limit p_limit;
    end
    $function$;

    create or replace function public.workforce_claim_selected_payout_publication_row_refresh_jobs(
      p_limit integer, p_company_id uuid, p_rows jsonb,
      p_period_start date, p_period_end date
    ) returns setof public.workforce_payout_publication_refresh_jobs
    language plpgsql security definer set search_path = '' as $function$
    begin
      return query
      with eligible as (
        select job.id
        from public.workforce_payout_publication_refresh_jobs job
        where job.company_id=p_company_id
          and job.period_start=p_period_start and job.period_end=p_period_end
          and job.claim_attempts < job.max_attempts
          and (
            job.status='pending' and job.next_attempt_at <= clock_timestamp()
          )
      )
      select job.* from public.workforce_payout_publication_refresh_jobs job
      join eligible on eligible.id=job.id
      where exists (
        select 1 from jsonb_array_elements(p_rows) selected(value)
        where (selected.value->>'workforce_id')::uuid=job.workforce_id
          and (selected.value->>'station_id')::uuid=job.station_id
      ) limit p_limit;
    end
    $function$;

    create or replace function public.workforce_payout_payment_row_candidates(
      p_company_id uuid, p_period_start date, p_period_end date, p_rows jsonb
    ) returns table (
      workforce_id uuid, station_id uuid, dropx_id text, station_code text,
      current_target_amount numeric(14,2), paid_amount numeric(14,2),
      processing_amount numeric(14,2), balance_payable numeric(14,2),
      available_to_pay numeric(14,2), history_count integer,
      payment_status text, eligible boolean, eligibility_code text,
      eligibility_message text, publication_id uuid, publication_revision integer,
      mapping_relock_id uuid, publication_snapshot_hash text
    ) language sql stable set search_path = '' as $function$
      select
        (selected.value->>'workforce_id')::uuid,
        (selected.value->>'station_id')::uuid,
        null::text, null::text,
        0::numeric(14,2), 0::numeric(14,2), 0::numeric(14,2),
        0::numeric(14,2), 0::numeric(14,2), 0::integer, null::text,
        not exists (
          select 1 from public.workforce_payout_publication_refresh_jobs job
          where job.company_id=p_company_id
            and job.workforce_id=(selected.value->>'workforce_id')::uuid
            and job.station_id=(selected.value->>'station_id')::uuid
            and job.period_start=p_period_start and job.period_end=p_period_end
            and job.status <> 'completed'
        ),
        case when exists (
          select 1 from public.workforce_payout_publication_refresh_jobs job
          where job.company_id=p_company_id
            and job.workforce_id=(selected.value->>'workforce_id')::uuid
            and job.station_id=(selected.value->>'station_id')::uuid
            and job.period_start=p_period_start and job.period_end=p_period_end
            and job.status <> 'completed'
        ) then 'publication_refresh_pending' else 'eligible' end,
        'test candidate'::text, null::uuid, null::integer, null::uuid, null::text
      from jsonb_array_elements(p_rows) selected(value)
    $function$;
  `);

  await db.exec(
    `insert into auth.users(id) values('${actor}');
     insert into public.companies(id) values('${company}');
     insert into public.stations(id,company_id,station_code) values
       ('${stationA}','${company}','ST-A'),('${stationB}','${company}','ST-B'),('${stationC}','${company}','ST-C');
     insert into public.providers(id,company_id,name,code) values('${provider}','${company}','Amazon','AMZ');
     insert into public.workforce(id,company_id,biometric_id) values
       ('${workforceA}','${company}','1088'),('${workforceB}','${company}','1201'),('${workforceC}','${company}','1096');
     insert into public.payment_fields(id,company_id,field_type,calculation_source)
       values('${field}','${company}','amount','attendance_eligibility');
     insert into public.payment_method_components(payment_method_id,payment_field_id,component_type)
       values('${method}','${field}','amount');
     insert into public.field_executive_provider_mappings(
       id,company_id,provider_member_id,station_id,provider_id,workforce_id,
       payment_method_id,effective_from,status
     ) values
       ('${mappingA}','${company}','A-1088','${stationA}','${provider}','${workforceA}','${method}','2026-09-01','active'),
       ('${mappingB}','${company}','B-1201','${stationB}','${provider}','${workforceB}','${method}','2026-09-01','active'),
       ('${mappingC}','${company}','C-1096','${stationC}','${provider}','${workforceC}','${method}','2026-10-01','active');
     insert into public.workforce_payout_publications(
       id,company_id,publication_kind,workforce_id,station_id,period_start,period_end,
       revision,published_at,published_by
     ) values
       ('${publicationA}','${company}','worksheet','${workforceA}','${stationA}','2026-09-01','2026-09-30',1,'2026-10-01 00:00:00+00','${actor}'),
       ('${publicationAOther}','${company}','worksheet','${workforceA}','${stationB}','2026-09-01','2026-09-30',1,'2026-10-01 00:00:00+00','${actor}'),
       ('${publicationB}','${company}','worksheet','${workforceB}','${stationB}','2026-09-01','2026-09-30',1,'2026-10-01 00:00:00+00','${actor}'),
       ('${publicationC}','${company}','worksheet','${workforceC}','${stationC}','2026-10-01','2026-10-31',1,'2026-11-01 00:00:00+00','${actor}');
     insert into public.attendance_daily(
       id,company_id,workforce_id,enrolment_id,punch_date,status,work_minutes,punch_count,updated_at
     ) values('${attendance}','${company}','${workforceA}','1088','2026-09-10','P',480,2,'2026-10-02 00:00:00+00');
     insert into public.cps_shipment_daily(
       id,company_id,client,work_date,station_code,provider_employee_id,
       amazon_delivery,total_delivery,updated_at
     ) values('${shipment}','${company}','Amazon','2026-09-11','ST-B','B-1201',20,20,'2026-10-02 00:00:00+00');
     insert into public.workforce_payout_payment_items(
       id,company_id,workforce_id,period_start,period_end,status,instruction_amount
     ) values('${processingItem}','${company}','${workforceA}','2026-09-01','2026-09-30','processing',100);
     insert into public.workforce_payout_payment_allocations(
       id,company_id,payment_item_id,station_id,instruction_amount_snapshot
     ) values('${processingAllocation}','${company}','${processingItem}','${stationA}',100);
     insert into public.workforce_payout_effective_paid_allocations(
       company_id,payment_allocation_id,payment_item_id,credited_workforce_id,
       station_id,period_start,period_end,instruction_amount_snapshot
     ) values('${company}','${paidAllocation}','${paidItem}','${workforceA}',
       '${stationA}','2026-09-01','2026-09-30',50);`
  );

  await db.exec(migration);

  const backfill = await db.query(`
    select workforce_id,station_id,period_start,status
    from public.workforce_payout_publication_refresh_jobs
    order by workforce_id,station_id
  `);
  assert.deepEqual(
    backfill.rows.map((row) => [row.workforce_id, row.station_id, dateOnly(row.period_start)]),
    [
      [workforceA, stationA, "2026-09-01"],
      [workforceB, stationB, "2026-09-01"]
    ],
    "backfill queues only the exact mapped location, not another publication for the same Workforce"
  );

  const pendingPreview = await db.query(
    `select * from public.workforce_preview_payout_payment_rows(
      $1,'2026-09-01','2026-09-30',$2::jsonb
    )`,
    [company, JSON.stringify([{ workforce_id: workforceA, station_id: stationA }])]
  );
  assert.equal(pendingPreview.rows.length, 1);
  assert.equal(pendingPreview.rows[0].eligible, false);
  assert.equal(pendingPreview.rows[0].eligibility_code, "publication_refresh_pending");
  assert.equal(Number(pendingPreview.rows[0].paid_amount), 50);
  assert.equal(Number(pendingPreview.rows[0].processing_amount), 100);
  assert.equal(Number(pendingPreview.rows[0].available_to_pay), 0,
    "an unfinished refresh remains impossible to select for a second bank attempt");
  assert.equal(Number(pendingPreview.rows[0].history_count), 2);
  assert.equal(pendingPreview.rows[0].payment_status, "Payment Processing");

  await db.query(
    `insert into public.workforce_payout_publication_refresh_jobs(
       company_id,refresh_source,refresh_request_id,workforce_id,station_id,
       period_start,period_end,base_publication_id,base_revision,requested_by,status
     ) values($1,'shipment_fact',$2,$3,$4,'2026-09-01','2026-09-30',$5,1,$6,'pending')`,
    [company, id(74), workforceA, stationB, publicationAOther, actor]
  );
  const pendingSiblingPreview = await db.query(
    `select * from public.workforce_preview_payout_payment_rows(
      $1,'2026-09-01','2026-09-30',$2::jsonb
    )`,
    [company, JSON.stringify([{ workforce_id: workforceA, station_id: stationB }])]
  );
  assert.equal(Number(pendingSiblingPreview.rows[0].processing_amount), 0,
    "processing money remains allocated only to its exact station row");
  assert.equal(pendingSiblingPreview.rows[0].payment_status, "Payment Processing",
    "an in-flight profile blocks a second attempt from every pending sibling station");
  assert.equal(Number(pendingSiblingPreview.rows[0].available_to_pay), 0);

  const processingClaim = await db.query(
    `select * from public.workforce_claim_selected_payout_publication_row_refresh_jobs(
      10,$1,$2::jsonb,'2026-09-01','2026-09-30'
    )`,
    [company, JSON.stringify([{ workforce_id: workforceA, station_id: stationA }])]
  );
  assert.equal(processingClaim.rows.length, 0, "a processing bank instruction keeps its queued publication immutable");

  await db.query("update public.workforce_payout_payment_items set status='cancelled' where id=$1", [processingItem]);
  const releasedClaim = await db.query(
    `select * from public.workforce_claim_selected_payout_publication_row_refresh_jobs(
      10,$1,$2::jsonb,'2026-09-01','2026-09-30'
    )`,
    [company, JSON.stringify([{ workforce_id: workforceA, station_id: stationA }])]
  );
  assert.equal(releasedClaim.rows.length, 1, "the queued correction becomes claimable after processing is released");

  await db.exec("delete from public.workforce_payout_publication_refresh_jobs");
  await db.query(
    `update public.attendance_daily
     set workforce_id=$1,enrolment_id='1096',punch_date='2026-10-05',work_minutes=60,updated_at=clock_timestamp()
     where id=$2`,
    [workforceC, attendance]
  );
  const movedAttendance = await db.query(`
    select workforce_id,station_id,period_start
    from public.workforce_payout_publication_refresh_jobs
    order by period_start,workforce_id
  `);
  assert.deepEqual(
    movedAttendance.rows.map((row) => [row.workforce_id, row.station_id, dateOnly(row.period_start)]),
    [
      [workforceA, stationA, "2026-09-01"],
      [workforceC, stationC, "2026-10-01"]
    ],
    "an attendance move queues both old and new Workforce/month identities"
  );

  await db.exec("delete from public.workforce_payout_publication_refresh_jobs");
  await db.query("update public.attendance_daily set updated_at=clock_timestamp() where id=$1", [attendance]);
  const timestampOnly = await db.query("select count(*)::int as count from public.workforce_payout_publication_refresh_jobs");
  assert.equal(timestampOnly.rows[0].count, 0, "timestamp-only attendance upserts do not create duplicate refresh work");

  await db.exec("delete from public.workforce_payout_publication_refresh_jobs");
  await db.query(
    `insert into public.cps_shipment_daily(
       id,company_id,client,work_date,station_code,provider_employee_id,amazon_delivery,total_delivery
     ) values
       ($1,$2,'Amazon','2026-09-12','ST-B','B-1201',1,1),
       ($3,$2,'Amazon','2026-09-13','ST-B','B-1201',2,2)`,
    [id(70), company, id(71)]
  );
  const deduplicated = await db.query("select count(*)::int as count from public.workforce_payout_publication_refresh_jobs");
  assert.equal(deduplicated.rows[0].count, 1, "one fact statement creates one job per publication identity");

  await db.exec("delete from public.workforce_payout_publication_refresh_jobs");
  await db.query(
    `insert into public.cps_shipment_daily(
       id,company_id,client,work_date,station_code,provider_employee_id,amazon_delivery,total_delivery
     ) values($1,$2,'AMZ','2026-09-14','ST-B','B-1201',3,3)`,
    [id(72), company]
  );
  const providerCodeMatch = await db.query(`
    select workforce_id,station_id from public.workforce_payout_publication_refresh_jobs
  `);
  assert.deepEqual(
    providerCodeMatch.rows.map((row) => [row.workforce_id, row.station_id]),
    [[workforceB, stationB]],
    "a shipment client matching the provider code queues the same publication as a provider-name match"
  );

  await db.exec("delete from public.workforce_payout_publication_refresh_jobs");
  await db.query(
    `insert into public.cps_shipment_daily(
       id,company_id,client,work_date,station_code,provider_employee_id,amazon_delivery,total_delivery
     ) values($1,$2,'Flipkart','2026-09-15','ST-B','B-1201',4,4)`,
    [id(73), company]
  );
  const providerMismatch = await db.query(
    "select count(*)::int as count from public.workforce_payout_publication_refresh_jobs"
  );
  assert.equal(providerMismatch.rows[0].count, 0, "an unrelated shipment provider does not queue the payout");

  console.log("Workforce payout attendance/shipment publication refresh verification passed.");
} finally {
  await db.close();
}
