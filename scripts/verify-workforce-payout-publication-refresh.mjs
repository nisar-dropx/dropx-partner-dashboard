import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync(
  new URL("../supabase/migrations/20261009031215_workforce_payout_publication_refresh_queue.sql", import.meta.url),
  "utf8"
).replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");
const stationFkIndexMigration = readFileSync(
  new URL("../supabase/migrations/20261009043000_index_workforce_payout_publication_refresh_station_fk.sql", import.meta.url),
  "utf8"
);
const hardeningMigration = readFileSync(
  new URL("../supabase/migrations/20261009050050_workforce_payout_publication_refresh_hardening.sql", import.meta.url),
  "utf8"
).replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");
const selectedClaimMigration = readFileSync(
  new URL("../supabase/migrations/20261010022326_claim_selected_workforce_payout_publication_refresh_jobs.sql", import.meta.url),
  "utf8"
).replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");

assert.match(migration, /security definer\s+set search_path = ''/i);
assert.match(migration, /for update of job skip locked/i);
assert.match(hardeningMigration, /claimed_at < clock_timestamp\(\) - interval '10 minutes'/i);
assert.doesNotMatch(hardeningMigration, /interval '5 minutes'/i);
assert.match(hardeningMigration, /target_batch[\s\S]*join target_batch on target_batch\.input_batch_id = job\.input_batch_id/i);
assert.match(hardeningMigration, /reconcile_covered_workforce_payout_refresh_failures/i);
assert.match(hardeningMigration, /\(job\.created_at, job\.id\) <= \(v_anchor_created_at, v_anchor_job_id\)/i);
assert.match(hardeningMigration, /workforce_send_payouts_for_review_without_lock_order/i);
assert.match(hardeningMigration, /workforce_transition_payout_review_status/i);
assert.match(hardeningMigration, /revoke update on table public\.workforce_payout_review_submissions from service_role/i);
assert.match(hardeningMigration, /v_expected_status = 'under_review'[\s\S]*v_new_status in \('returned', 'approved', 'cancelled'\)[\s\S]*v_expected_status = 'returned' and v_new_status = 'cancelled'/i);
assert.match(hardeningMigration, /concurrent direct review update[\s\S]*waiting for that mutex/i);
assert.match(hardeningMigration, /for update of publication\s*;/i);
assert.doesNotMatch(hardeningMigration, /for update of publication\s*,\s*review/i);
assert.match(migration, /workforce_apply_payout_import_without_publication_refresh/i);
assert.match(migration, /workforce_payout_publication_refresh_jobs[\s\S]*on conflict \([\s\S]*input_batch_id[\s\S]*\) do nothing/i);
assert.match(migration, /select distinct on \(existing\.period_start, existing\.period_end\)/i);
assert.match(migration, /workforce_advance_recovery_snapshot_hash/i);
assert.match(migration, /'\{app_notification_enabled\}'[\s\S]*'false'::jsonb[\s\S]*'\{whatsapp_notification_enabled\}'[\s\S]*'false'::jsonb/i);
assert.match(stationFkIndexMigration, /\(company_id, station_id\)/i);
assert.match(hardeningMigration, /claim_token uuid/i);
assert.match(hardeningMigration, /workforce_fail_payout_publication_refresh_jobs/i);
assert.match(hardeningMigration, /workforce_replay_failed_payout_publication_refresh_jobs/i);
assert.match(hardeningMigration, /notification_status in \('pending', 'failed', 'uncertain'\)/i);
assert.match(hardeningMigration, /notification_status = 'sending'/i);
assert.match(hardeningMigration, /review_status in \('approved', 'cancelled'\)/i);
assert.match(hardeningMigration, /next_attempt_at/i);
assert.match(hardeningMigration, /status in \('pending', 'processing', 'completed', 'failed'\)/i);
assert.match(hardeningMigration, /unresolved publication refresh/i);
assert.match(hardeningMigration, /submitted_by := old\.submitted_by/i);
assert.match(hardeningMigration, /input_values_cleared/i);
assert.match(selectedClaimMigration, /security definer\s+set search_path = ''/i);
assert.match(selectedClaimMigration, /job\.company_id = p_company_id/i);
assert.match(selectedClaimMigration, /job\.workforce_id = any\(p_workforce_ids\)/i);
assert.match(selectedClaimMigration, /job\.period_start = p_period_start[\s\S]*job\.period_end = p_period_end/i);
assert.match(selectedClaimMigration, /claimed_at < clock_timestamp\(\) - interval '10 minutes'/i);
assert.match(selectedClaimMigration, /predecessor\.status in \('pending', 'processing'\)/i);
assert.match(selectedClaimMigration, /target_batch[\s\S]*for update of job skip locked/i);
assert.match(selectedClaimMigration, /cardinality\(p_workforce_ids\) > 10000/i);
assert.match(selectedClaimMigration, /count\(distinct supplied\.workforce_id\)/i);

const db = new PGlite();

try {
  await db.exec(`
    create schema auth;
    create role anon;
    create role authenticated;
    create role service_role bypassrls;

    create table auth.users(id uuid primary key);
    create table public.companies(id uuid primary key);
    create table public.stations(
      id uuid primary key,
      company_id uuid not null,
      station_code text,
      unique(company_id, id)
    );
    create table public.workforce(
      id uuid primary key,
      company_id uuid not null,
      deleted_at timestamptz,
      migration_state text not null default 'active',
      unique(company_id, id)
    );
    create table public.workforce_payout_import_batches(
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references public.companies(id),
      effective_from date not null,
      effective_to date not null,
      file_name text not null,
      file_sha256 text not null,
      status text not null default 'committed',
      row_count integer not null,
      created_by uuid references auth.users(id),
      created_at timestamptz not null default now(),
      committed_at timestamptz
    );
    create table public.workforce_payout_import_rows(
      id uuid primary key default gen_random_uuid(),
      batch_id uuid not null references public.workforce_payout_import_batches(id),
      company_id uuid not null references public.companies(id),
      row_number integer not null,
      workforce_id uuid not null,
      station_id uuid not null,
      effective_from date not null,
      effective_to date not null
    );
    create table public.workforce_payout_review_submissions(
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null,
      subject_type text not null,
      subject_id uuid not null,
      location_id uuid not null,
      period_start date not null,
      period_end date not null,
      status text not null,
      calculation_snapshot jsonb not null default '{}'::jsonb,
      submitted_by uuid,
      submitted_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique(company_id, subject_type, subject_id, location_id, period_start, period_end)
    );
    grant select, insert, update on public.workforce_payout_review_submissions to service_role;
    create table public.workforce_payout_publications(
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references public.companies(id),
      payroll_run_id uuid,
      workforce_id uuid not null references public.workforce(id),
      station_id uuid not null references public.stations(id),
      revision integer not null,
      snapshot jsonb not null,
      published_by uuid not null references auth.users(id),
      published_at timestamptz not null default now(),
      review_until timestamptz not null,
      notify_at timestamptz not null,
      source_calculated_at timestamptz not null,
      notification_status text not null,
      notification_error text,
      notification_reference text,
      notification_attempted_at timestamptz,
      review_submission_id uuid references public.workforce_payout_review_submissions(id),
      period_start date,
      period_end date,
      snapshot_hash text,
      dependency_hash text,
      notification_config_snapshot jsonb not null default '{}'::jsonb,
      publication_kind text not null default 'legacy_payroll'
    );
    create unique index workforce_payout_publications_worksheet_revision_uidx
      on public.workforce_payout_publications
      (company_id, workforce_id, station_id, period_start, period_end, revision)
      where publication_kind = 'worksheet';
    grant select, insert, update on public.workforce_payout_publications to service_role;

    create table public.test_payout_dependency_hashes(
      company_id uuid not null,
      period_start date not null,
      period_end date not null,
      dependency_hash text not null,
      primary key(company_id, period_start, period_end)
    );

    create or replace function public.lock_workforce_payment_allocation_company(uuid)
    returns void language sql as $$select$$;

    create or replace function public.workforce_advance_recovery_snapshot_hash(
      p_company_id uuid,
      p_period_start date,
      p_period_end date
    ) returns text language sql stable set search_path = '' as $$
      select dependency_hash
      from public.test_payout_dependency_hashes
      where company_id = p_company_id
        and period_start = p_period_start
        and period_end = p_period_end
    $$;

    create or replace function public.guard_test_publication_immutable()
    returns trigger language plpgsql set search_path = '' as $$
    begin
      if (to_jsonb(new) - array[
          'notification_status', 'notification_error', 'notification_reference',
          'notification_attempted_at', 'notify_at'
        ]::text[])
        is distinct from
        (to_jsonb(old) - array[
          'notification_status', 'notification_error', 'notification_reference',
          'notification_attempted_at', 'notify_at'
        ]::text[])
      then
        raise exception 'A published Workforce payout snapshot is immutable. Publish a new revision instead.';
      end if;
      return new;
    end
    $$;
    create trigger workforce_payout_publications_00_immutable
      before update on public.workforce_payout_publications
      for each row execute function public.guard_test_publication_immutable();

    create or replace function public.workforce_apply_payout_import(
      p_company_id uuid,
      p_effective_from date,
      p_effective_to date,
      p_file_name text,
      p_file_sha256 text,
      p_rows jsonb,
      p_actor_user_id uuid,
      p_allowed_location_ids uuid[] default null
    ) returns uuid language plpgsql security definer set search_path = '' as $$
    declare
      v_batch_id uuid := gen_random_uuid();
      v_row jsonb;
    begin
      insert into public.workforce_payout_import_batches(
        id, company_id, effective_from, effective_to, file_name, file_sha256,
        status, row_count, created_by, committed_at
      ) values (
        v_batch_id, p_company_id, p_effective_from, p_effective_to,
        p_file_name, p_file_sha256, 'committed', jsonb_array_length(p_rows),
        p_actor_user_id, clock_timestamp()
      );
      for v_row in select value from jsonb_array_elements(p_rows)
      loop
        insert into public.workforce_payout_import_rows(
          batch_id, company_id, row_number, workforce_id, station_id,
          effective_from, effective_to
        ) values (
          v_batch_id, p_company_id, (v_row ->> 'row_number')::integer,
          (v_row ->> 'workforce_id')::uuid, (v_row ->> 'station_id')::uuid,
          (v_row ->> 'effective_from')::date, (v_row ->> 'effective_to')::date
        );
      end loop;
      return v_batch_id;
    end
    $$;
    grant execute on function public.workforce_apply_payout_import(
      uuid, date, date, text, text, jsonb, uuid, uuid[]
    ) to service_role;

    create or replace function public.workforce_send_payouts_for_review(
      p_company uuid,
      p_actor uuid,
      p_period_start date,
      p_period_end date,
      p_items jsonb,
      p_locations uuid[]
    ) returns integer language sql security invoker set search_path = '' as $$
      select jsonb_array_length(p_items)::integer
    $$;
    grant execute on function public.workforce_send_payouts_for_review(
      uuid, uuid, date, date, jsonb, uuid[]
    ) to service_role;

    create or replace function public.workforce_publish_payout_notifications(
      p_company uuid,
      p_actor uuid,
      p_period_start date,
      p_period_end date,
      p_items jsonb,
      p_locations uuid[],
      p_expected_dependency_hash text,
      p_review_until timestamptz,
      p_notify_at timestamptz,
      p_notification_config_id uuid,
      p_notification_config_updated_at timestamptz
    ) returns jsonb language sql security invoker set search_path = '' as $$
      select jsonb_build_object('published', jsonb_array_length(p_items))
    $$;
    grant execute on function public.workforce_publish_payout_notifications(
      uuid, uuid, date, date, jsonb, uuid[], text, timestamptz, timestamptz, uuid, timestamptz
    ) to service_role;

    ${migration}
    ${stationFkIndexMigration}
    ${hardeningMigration}
    ${selectedClaimMigration}
  `);

  const company = randomUUID();
  const actor = randomUUID();
  const newerActor = randomUUID();
  const station = randomUUID();
  const otherStation = randomUUID();
  const workforce = randomUUID();
  const unpublishedWorkforce = randomUUID();
  const sendingWorkforce = randomUUID();
  const review = randomUUID();
  const sendingReview = randomUUID();
  const basePublication = randomUUID();
  const sendingPublication = randomUUID();
  const periodStart = "2026-09-01";
  const periodEnd = "2026-09-30";

  await db.query("insert into auth.users(id) values ($1),($2)", [actor, newerActor]);
  await db.query("insert into public.companies(id) values ($1)", [company]);
  await db.query(
    "insert into public.stations(id,company_id,station_code) values ($1,$2,'ONE'),($3,$2,'TWO')",
    [station, company, otherStation]
  );
  await db.query(
    "insert into public.workforce(id,company_id) values ($1,$2),($3,$2),($4,$2)",
    [workforce, company, unpublishedWorkforce, sendingWorkforce]
  );
  await db.query(
    `insert into public.workforce_payout_review_submissions(
      id,company_id,subject_type,subject_id,location_id,period_start,period_end,status,
      submitted_by,submitted_at
    ) values
      ($1,$2,'workforce',$3,$4,$5,$6,'under_review',$7,'2026-10-01T00:00:00Z'),
      ($8,$2,'workforce',$9,$4,$5,$6,'under_review',$7,'2026-10-01T00:00:00Z')`,
    [review, company, workforce, station, periodStart, periodEnd, actor, sendingReview, sendingWorkforce]
  );
  const originalSnapshot = {
    schema_version: 2,
    source: "workforce_payout_worksheet",
    dependency_hash: "hash-v0",
    run: { period_start: periodStart, period_end: periodEnd },
    item: { workforce_id: workforce, station_id: station, net_amount: 100 }
  };
  const originalNotificationConfig = {
    schema_version: 1,
    event_code: "workforce_payout_review",
    app_notification_enabled: true,
    whatsapp_notification_enabled: true
  };
  await db.query(
    `insert into public.workforce_payout_publications(
      id,company_id,workforce_id,station_id,revision,snapshot,published_by,
      review_until,notify_at,source_calculated_at,notification_status,
      review_submission_id,period_start,period_end,snapshot_hash,dependency_hash,
      notification_config_snapshot,publication_kind
    ) values (
      $1,$2,$3,$4,1,$5::jsonb,$6,now()+interval '7 days',now(),now(),'pending',
      $7,$8,$9,$10,'hash-v0',$11::jsonb,'worksheet'
    )`,
    [
      basePublication,
      company,
      workforce,
      station,
      JSON.stringify(originalSnapshot),
      actor,
      review,
      periodStart,
      periodEnd,
      "0".repeat(64),
      JSON.stringify(originalNotificationConfig)
    ]
  );
  await db.query(
    `insert into public.workforce_payout_publications(
      id,company_id,workforce_id,station_id,revision,snapshot,published_by,
      review_until,notify_at,source_calculated_at,notification_status,
      review_submission_id,period_start,period_end,snapshot_hash,dependency_hash,
      notification_config_snapshot,publication_kind
    ) values (
      $1,$2,$3,$4,1,$5::jsonb,$6,now()+interval '7 days',now(),now(),'sending',
      $7,$8,$9,$10,'hash-v0',$11::jsonb,'worksheet'
    )`,
    [
      sendingPublication,
      company,
      sendingWorkforce,
      station,
      JSON.stringify({
        ...originalSnapshot,
        item: { ...originalSnapshot.item, workforce_id: sendingWorkforce }
      }),
      actor,
      sendingReview,
      periodStart,
      periodEnd,
      "f".repeat(64),
      JSON.stringify(originalNotificationConfig)
    ]
  );
  await db.query(
    `insert into public.test_payout_dependency_hashes values ($1,$2,$3,'hash-v1')`,
    [company, periodStart, periodEnd]
  );

  await db.exec("set role service_role");

  const importRows = [
    {
      row_number: 2,
      workforce_id: workforce,
      station_id: station,
      effective_from: "2026-09-10",
      effective_to: "2026-09-10"
    },
    {
      row_number: 3,
      workforce_id: workforce,
      station_id: station,
      effective_from: "2026-09-11",
      effective_to: "2026-09-11"
    },
    {
      row_number: 4,
      workforce_id: workforce,
      station_id: otherStation,
      effective_from: "2026-09-10",
      effective_to: "2026-09-10"
    },
    {
      row_number: 5,
      workforce_id: unpublishedWorkforce,
      station_id: station,
      effective_from: "2026-09-10",
      effective_to: "2026-09-10"
    }
  ];
  await db.exec("reset role");
  const batchesBeforeSendingConflict = Number((
    await db.query("select count(*)::int as count from public.workforce_payout_import_batches")
  ).rows[0].count);
  await db.exec("set role service_role");
  await assert.rejects(
    db.query(
      `select public.workforce_apply_payout_import(
        $1,$2,$3,'sending.csv',$4,$5::jsonb,$6,null
      )`,
      [company, periodStart, periodEnd, "e".repeat(64), JSON.stringify([{
        ...importRows[0],
        workforce_id: sendingWorkforce
      }]), actor]
    ),
    /currently sending/i,
    "an in-flight notification rolls the entire input import back"
  );
  await db.exec("reset role");
  assert.equal(
    Number((await db.query("select count(*)::int as count from public.workforce_payout_import_batches")).rows[0].count),
    batchesBeforeSendingConflict,
    "the rejected import must not leave a committed batch"
  );
  await db.exec("set role service_role");

  const firstBatch = (
    await db.query(
      `select public.workforce_apply_payout_import(
        $1,$2,$3,'first.csv',$4,$5::jsonb,$6,null
      ) as id`,
      [company, periodStart, periodEnd, "1".repeat(64), JSON.stringify(importRows), actor]
    )
  ).rows[0].id;

  const queued = await db.query(
    `select * from public.workforce_payout_publication_refresh_jobs where input_batch_id=$1`,
    [firstBatch]
  );
  assert.equal(queued.rows.length, 1, "only the exact published Workforce/station/period is queued once");
  assert.equal(queued.rows[0].workforce_id, workforce);
  assert.equal(queued.rows[0].station_id, station);
  assert.equal(queued.rows[0].requested_by, actor);
  assert.equal(queued.rows[0].base_publication_id, basePublication);
  assert.equal(
    (await db.query("select notification_status from public.workforce_payout_publications where id=$1", [basePublication])).rows[0].notification_status,
    "superseded",
    "queueing atomically prevents an old pending notification from being claimed"
  );
  await assert.rejects(
    db.query(
      "update public.workforce_payout_review_submissions set status='approved' where id=$1",
      [review]
    ),
    /permission denied/i,
    "service_role cannot bypass lock ordering with a direct review update"
  );
  await assert.rejects(
    db.query(
      `select public.workforce_transition_payout_review_status(
        $1,'workforce',$2,$3,$4,$5,'under_review','approved',null
      )`,
      [company, workforce, station, periodStart, periodEnd]
    ),
    /unresolved publication refresh/i,
    "the lock-ordered transition RPC cannot approve a stale published payout"
  );

  const claimed = (
    await db.query(
      `select * from public.workforce_claim_payout_publication_refresh_jobs(1,$1,$2)`,
      [company, firstBatch]
    )
  ).rows;
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].status, "processing");
  assert.equal(claimed[0].claim_attempts, 1);
  assert.match(claimed[0].claim_token, /^[0-9a-f-]{36}$/i);

  const revisedSnapshot = {
    schema_version: 2,
    source: "workforce_payout_worksheet",
    dependency_hash: "hash-v1",
    run: { period_start: periodStart, period_end: periodEnd },
    item: { workforce_id: workforce, station_id: station, net_amount: 125 },
    lines: [],
    worksheet: {}
  };
  const applied = (
    await db.query(
      `select public.workforce_apply_payout_publication_input_revisions(
        $1,$2,$3,'hash-v1',$4,$5::jsonb
      ) as result`,
      [
        company,
        periodStart,
        periodEnd,
        actor,
        JSON.stringify([{
          job_id: claimed[0].id,
          claim_token: claimed[0].claim_token,
          workforce_id: workforce,
          station_id: station,
          snapshot: revisedSnapshot,
          snapshot_hash: "a".repeat(64)
        }])
      ]
    )
  ).rows[0].result;
  assert.equal(applied.completed, 1);
  assert.equal(applied.published, 1);
  assert.equal(applied.publication_ids.length, 1);

  const publications = await db.query(
    `select id,revision,snapshot,notification_status,notification_config_snapshot,
      revision_source,input_batch_id,supersedes_publication_id
    from public.workforce_payout_publications
    where company_id=$1 and workforce_id=$2 and station_id=$3
    order by revision`,
    [company, workforce, station]
  );
  assert.equal(publications.rows.length, 2);
  assert.deepEqual(publications.rows[0].snapshot, originalSnapshot, "the historical snapshot remains unchanged");
  assert.equal(publications.rows[0].notification_status, "superseded");
  assert.equal(publications.rows[1].revision, 2);
  assert.equal(publications.rows[1].revision_source, "input_batch_refresh");
  assert.equal(publications.rows[1].input_batch_id, firstBatch);
  assert.equal(publications.rows[1].supersedes_publication_id, basePublication);
  assert.equal(publications.rows[1].notification_status, "disabled");
  assert.equal(publications.rows[1].notification_config_snapshot.app_notification_enabled, false);
  assert.equal(publications.rows[1].notification_config_snapshot.whatsapp_notification_enabled, false);
  assert.equal(publications.rows[1].notification_config_snapshot.silent_revision, true);

  const finishedJob = await db.query(
    `select status,published_publication_id from public.workforce_payout_publication_refresh_jobs where id=$1`,
    [claimed[0].id]
  );
  assert.equal(finishedJob.rows[0].status, "completed");
  assert.equal(finishedJob.rows[0].published_publication_id, publications.rows[1].id);
  const originalReviewAudit = await db.query(
    `select submitted_by, submitted_at::text as submitted_at
      from public.workforce_payout_review_submissions where id=$1`,
    [review]
  );
  assert.equal(originalReviewAudit.rows[0].submitted_by, actor);
  assert.match(originalReviewAudit.rows[0].submitted_at, /^2026-10-01 00:00:00/);
  await assert.rejects(
    db.query(
      `select public.workforce_transition_payout_review_status(
        $1,'workforce',$2,$3,$4,$5,'returned','cancelled',null
      )`,
      [company, workforce, station, periodStart, periodEnd]
    ),
    /state changed/i,
    "a stale expected review status cannot overwrite the current state"
  );
  await db.exec("begin");
  const returnedTransition = (
    await db.query(
      `select public.workforce_transition_payout_review_status(
        $1,'workforce',$2,$3,$4,$5,'under_review','returned',null
      ) as result`,
      [company, workforce, station, periodStart, periodEnd]
    )
  ).rows[0].result;
  assert.equal(returnedTransition.status, "returned");
  await assert.rejects(
    db.query(
      `select public.workforce_transition_payout_review_status(
        $1,'workforce',$2,$3,$4,$5,'returned','under_review',null
      )`,
      [company, workforce, station, periodStart, periodEnd]
    ),
    /valid payout review status transition/i,
    "resubmission cannot bypass the existing snapshot/publication RPCs"
  );
  await db.exec("rollback");
  await db.exec("begin");
  const approvedTransition = (
    await db.query(
      `select public.workforce_transition_payout_review_status(
        $1,'workforce',$2,$3,$4,$5,'under_review','approved',null
      ) as result`,
      [company, workforce, station, periodStart, periodEnd]
    )
  ).rows[0].result;
  assert.equal(approvedTransition.previous_status, "under_review");
  assert.equal(approvedTransition.status, "approved");
  await db.exec("rollback");

  await assert.rejects(
    db.query(
      `update public.workforce_payout_publications set snapshot='{}'::jsonb where id=$1`,
      [basePublication]
    ),
    /immutable/i,
    "a historical publication remains immutable"
  );

  const secondBatch = (
    await db.query(
      `select public.workforce_apply_payout_import(
        $1,$2,$3,'second.csv',$4,$5::jsonb,$6,null
      ) as id`,
      [company, periodStart, periodEnd, "2".repeat(64), JSON.stringify([importRows[0]]), actor]
    )
  ).rows[0].id;
  await db.exec("reset role");
  await assert.rejects(
    db.query(
      "update public.workforce_payout_review_submissions set status='approved' where id=$1",
      [review]
    ),
    /unresolved publication refresh/i,
    "a terminal review decision cannot overtake open refresh work"
  );
  await db.exec("set role service_role");
  const secondClaim = (
    await db.query(
      `select * from public.workforce_claim_payout_publication_refresh_jobs(1,$1,$2)`,
      [company, secondBatch]
    )
  ).rows[0];

  const thirdBatch = (
    await db.query(
      `select public.workforce_apply_payout_import(
        $1,$2,$3,'third.csv',$4,$5::jsonb,$6,null
      ) as id`,
      [company, periodStart, periodEnd, "3".repeat(64), JSON.stringify([importRows[0]]), newerActor]
    )
  ).rows[0].id;
  const leapfrogClaim = await db.query(
    `select * from public.workforce_claim_payout_publication_refresh_jobs(1,$1,$2)`,
    [company, thirdBatch]
  );
  assert.equal(
    leapfrogClaim.rows.length,
    0,
    "a batch filter cannot claim a newer generation before an older processing job for the same identity"
  );

  await db.exec("reset role");
  await db.query(
    `update public.test_payout_dependency_hashes set dependency_hash='hash-v2'
      where company_id=$1 and period_start=$2 and period_end=$3`,
    [company, periodStart, periodEnd]
  );
  await db.exec("set role service_role");

  await assert.rejects(
    db.query(
      `select public.workforce_apply_payout_publication_input_revisions(
        $1,$2,$3,'hash-v1',$4,$5::jsonb
      )`,
      [
        company,
        periodStart,
        periodEnd,
        actor,
        JSON.stringify([{
          job_id: secondClaim.id,
          claim_token: secondClaim.claim_token,
          workforce_id: workforce,
          station_id: station,
          snapshot: revisedSnapshot,
          snapshot_hash: "b".repeat(64)
        }])
      ]
    ),
    /inputs changed/i,
    "a stale dependency cannot publish or complete a job"
  );
  const afterStale = await db.query(
    `select
      (select count(*)::int from public.workforce_payout_publications where company_id=$1 and workforce_id=$2) as publications,
      (select status from public.workforce_payout_publication_refresh_jobs where id=$3) as job_status`,
    [company, workforce, secondClaim.id]
  );
  assert.equal(afterStale.rows[0].publications, 2);
  assert.equal(afterStale.rows[0].job_status, "processing");

  const released = (
    await db.query(
      `select public.workforce_fail_payout_publication_refresh_jobs($1::jsonb) as result`,
      [JSON.stringify([{
        job_id: secondClaim.id,
        claim_token: secondClaim.claim_token,
        error: "snapshot calculation failed"
      }])]
    )
  ).rows[0].result;
  assert.equal(released.retried, 1);
  assert.equal(released.failed, 0);
  assert.equal(released.stale, 0);
  assert.ok(released.jobs[0].next_attempt_at, "a retry is delayed by backoff");
  await db.exec("reset role");
  await db.query(
    `update public.workforce_payout_publication_refresh_jobs
      set next_attempt_at=clock_timestamp() where id=$1`,
    [secondClaim.id]
  );
  await db.exec("set role service_role");
  const blockedBatchClaim = await db.query(
    `select * from public.workforce_claim_payout_publication_refresh_jobs(1,$1,$2)`,
    [company, thirdBatch]
  );
  assert.equal(
    blockedBatchClaim.rows.length,
    0,
    "a batch-scoped claim never substitutes an older predecessor from another batch"
  );
  const retried = (
    await db.query(
      `select * from public.workforce_claim_payout_publication_refresh_jobs(1,$1,$2)`,
      [company, secondBatch]
    )
  ).rows[0];
  assert.equal(retried.id, secondClaim.id);
  assert.equal(
    retried.input_batch_id,
    secondBatch,
    "the predecessor remains claimable through its own batch"
  );
  assert.equal(retried.claim_attempts, 2);
  assert.equal(retried.last_error, null);

  const hashV2Snapshot = {
    ...revisedSnapshot,
    dependency_hash: "hash-v2",
    item: { ...revisedSnapshot.item, net_amount: 130 }
  };
  await assert.rejects(
    db.query(
      `select public.workforce_apply_payout_publication_input_revisions(
        $1,$2,$3,'hash-v2',$4,$5::jsonb
      )`,
      [
        company,
        periodStart,
        periodEnd,
        actor,
        JSON.stringify([{
          job_id: retried.id,
          claim_token: retried.claim_token,
          workforce_id: workforce,
          station_id: station,
          snapshot: { ...hashV2Snapshot, source: undefined },
          snapshot_hash: "c".repeat(64)
        }])
      ]
    ),
    /snapshot is invalid/i,
    "a malformed schema-v2 snapshot cannot publish or complete a job"
  );
  const afterMalformed = await db.query(
    `select
      (select count(*)::int from public.workforce_payout_publications where company_id=$1 and workforce_id=$2) as publications,
      (select status from public.workforce_payout_publication_refresh_jobs where id=$3) as job_status`,
    [company, workforce, retried.id]
  );
  assert.equal(afterMalformed.rows[0].publications, 2);
  assert.equal(afterMalformed.rows[0].job_status, "processing");

  await db.exec("reset role");
  await db.query(
    `update public.workforce_payout_publication_refresh_jobs
      set claimed_at=now()-interval '6 minutes'
      where id=$1`,
    [retried.id]
  );
  await db.exec("set role service_role");
  const stillLeased = await db.query(
    `select * from public.workforce_claim_payout_publication_refresh_jobs(1,$1,$2)`,
    [company, secondBatch]
  );
  assert.equal(
    stillLeased.rows.length,
    0,
    "a six-minute-old claim remains owned beyond the five-minute route ceiling"
  );
  const leaseStillOwned = (
    await db.query(
      `select claim_token,claim_attempts,status
       from public.workforce_payout_publication_refresh_jobs where id=$1`,
      [retried.id]
    )
  ).rows[0];
  assert.equal(leaseStillOwned.status, "processing");
  assert.equal(leaseStillOwned.claim_attempts, 2);
  assert.equal(leaseStillOwned.claim_token, retried.claim_token);

  await db.exec("reset role");
  await db.query(
    `update public.workforce_payout_publication_refresh_jobs
      set claimed_at=now()-interval '11 minutes'
      where id=$1`,
    [retried.id]
  );
  await db.exec("set role service_role");
  const reclaimed = (
    await db.query(
      `select * from public.workforce_claim_payout_publication_refresh_jobs(1,$1,$2)`,
      [company, secondBatch]
    )
  ).rows[0];
  assert.equal(reclaimed.id, retried.id, "a stale processing claim is reclaimable");
  assert.equal(reclaimed.claim_attempts, 3);
  assert.notEqual(reclaimed.claim_token, retried.claim_token, "reclaiming rotates lease ownership");

  await assert.rejects(
    db.query(
      `select public.workforce_apply_payout_publication_input_revisions(
        $1,$2,$3,'hash-v2',$4,$5::jsonb
      )`,
      [
        company,
        periodStart,
        periodEnd,
        actor,
        JSON.stringify([{
          job_id: retried.id,
          claim_token: retried.claim_token,
          workforce_id: workforce,
          station_id: station,
          snapshot: hashV2Snapshot,
          snapshot_hash: "e".repeat(64)
        }])
      ]
    ),
    /lease changed/i,
    "the former worker cannot publish after its stale lease was reclaimed"
  );
  const staleFailure = (
    await db.query(
      `select public.workforce_fail_payout_publication_refresh_jobs($1::jsonb) as result`,
      [JSON.stringify([{
        job_id: retried.id,
        claim_token: retried.claim_token,
        error: "old worker failed late"
      }])]
    )
  ).rows[0].result;
  assert.equal(staleFailure.accepted, 0);
  assert.equal(staleFailure.stale, 1, "the former worker also cannot release the new lease");

  const retryResult = (
    await db.query(
      `select public.workforce_apply_payout_publication_input_revisions(
        $1,$2,$3,'hash-v2',$4,$5::jsonb
      ) as result`,
      [
        company,
        periodStart,
        periodEnd,
        actor,
        JSON.stringify([{
          job_id: reclaimed.id,
          claim_token: reclaimed.claim_token,
          workforce_id: workforce,
          station_id: station,
          snapshot: hashV2Snapshot,
          snapshot_hash: "d".repeat(64)
        }])
      ]
    )
  ).rows[0].result;
  assert.equal(retryResult.completed, 2, "one current snapshot coalesces both open input generations");
  const newest = await db.query(
    `select id,revision,input_batch_id,supersedes_publication_id,published_by
      from public.workforce_payout_publications
      where company_id=$1 and workforce_id=$2 and station_id=$3
      order by revision desc limit 1`,
    [company, workforce, station]
  );
  assert.equal(newest.rows[0].revision, 3);
  assert.equal(newest.rows[0].input_batch_id, thirdBatch);
  assert.equal(newest.rows[0].supersedes_publication_id, publications.rows[1].id);
  assert.equal(
    newest.rows[0].published_by,
    newerActor,
    "the visible revision is attributed to the newest coalesced input batch"
  );
  const revisedReview = await db.query(
    `select submitted_by, submitted_at::text as submitted_at
      from public.workforce_payout_review_submissions where id=$1`,
    [review]
  );
  assert.equal(revisedReview.rows[0].submitted_by, actor, "silent revisions preserve the original submitter");
  assert.match(revisedReview.rows[0].submitted_at, /^2026-10-01 00:00:00/, "silent revisions preserve the original submission time");

  const coalescedJobs = await db.query(
    `select input_batch_id,status,published_publication_id
      from public.workforce_payout_publication_refresh_jobs
      where input_batch_id in ($1,$2)
      order by created_at`,
    [secondBatch, thirdBatch]
  );
  assert.deepEqual(coalescedJobs.rows.map((row) => row.status), ["completed", "completed"]);
  assert.equal(coalescedJobs.rows[0].published_publication_id, coalescedJobs.rows[1].published_publication_id);
  const noThirdClaim = await db.query(
    `select * from public.workforce_claim_payout_publication_refresh_jobs(1,$1,$2)`,
    [company, thirdBatch]
  );
  assert.equal(noThirdClaim.rows.length, 0, "the coalesced newer generation cannot publish a duplicate revision");

  const inputOnlySnapshot = {
    schema_version: 2,
    source: "workforce_payout_worksheet",
    dependency_hash: "hash-v2",
    run: { period_start: periodStart, period_end: periodEnd },
    item: { workforce_id: workforce, station_id: station, base_amount: 0, work_days: 0 },
    lines: [{ source_type: "additional_payment" }],
    worksheet: {
      row_id: `payout-input-${workforce}-${station}`,
      mapping_status: "Not required",
      payment_method_breakdown: [],
      production_breakdown: [],
      daily_breakdown: []
    }
  };
  await db.exec("reset role");
  assert.equal((
    await db.query(
      "select public.workforce_payout_snapshot_is_input_only($1::jsonb) as safe",
      [JSON.stringify(inputOnlySnapshot)]
    )
  ).rows[0].safe, true);
  assert.equal((
    await db.query(
      "select public.workforce_payout_snapshot_is_input_only($1::jsonb) as safe",
      [JSON.stringify(hashV2Snapshot)]
    )
  ).rows[0].safe, false);

  const invalidTombstone = {
    ...hashV2Snapshot,
    item: {
      ...hashV2Snapshot.item,
      worker_name: null,
      dropx_id: null,
      station_code: null,
      designation: null,
      provider_member_ids: [],
      work_days: 0,
      base_amount: 0,
      incentive_amount: 0,
      adjustment_amount: 0,
      deduction_amount: 0,
      gross_amount: 0,
      net_amount: 0
    },
    lines: [],
    worksheet: {
      row_id: `payout-input-${workforce}-${station}`,
      mapping_status: "Not required",
      payment_method_breakdown: [],
      production_breakdown: [],
      additional_payment_breakdown: [],
      deduction_breakdown: [],
      daily_breakdown: [],
      tombstone_reason: "input_values_cleared"
    }
  };
  await assert.rejects(
    db.query(
      `insert into public.workforce_payout_publications(
        company_id,workforce_id,station_id,revision,snapshot,published_by,
        review_until,notify_at,source_calculated_at,notification_status,
        review_submission_id,period_start,period_end,snapshot_hash,dependency_hash,
        notification_config_snapshot,publication_kind,revision_source,input_batch_id,
        supersedes_publication_id
      ) values (
        $1,$2,$3,4,$4::jsonb,$5,now()+interval '7 days',now(),now(),'disabled',
        $6,$7,$8,$9,'hash-v2',$10::jsonb,'worksheet','input_batch_refresh',$11,$12
      )`,
      [
        company, workforce, station, JSON.stringify(invalidTombstone), actor, review,
        periodStart, periodEnd, "9".repeat(64), JSON.stringify(originalNotificationConfig),
        thirdBatch, newest.rows[0].id
      ]
    ),
    /missing mapped payout cannot be replaced/i,
    "database validation refuses to tombstone a genuinely missing mapped payout"
  );

  await db.exec("set role service_role");
  const fourthBatch = (
    await db.query(
      `select public.workforce_apply_payout_import(
        $1,$2,$3,'fourth.csv',$4,$5::jsonb,$6,null
      ) as id`,
      [company, periodStart, periodEnd, "4".repeat(64), JSON.stringify([importRows[0]]), actor]
    )
  ).rows[0].id;
  let retryClaim = (
    await db.query(
      `select * from public.workforce_claim_payout_publication_refresh_jobs(1,$1,$2)`,
      [company, fourthBatch]
    )
  ).rows[0];
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    assert.equal(retryClaim.claim_attempts, attempt);
    const failure = (
      await db.query(
        `select public.workforce_fail_payout_publication_refresh_jobs($1::jsonb) as result`,
        [JSON.stringify([{
          job_id: retryClaim.id,
          claim_token: retryClaim.claim_token,
          error: `calculation failed on attempt ${attempt}`
        }])]
      )
    ).rows[0].result;
    if (attempt === 5) {
      assert.equal(failure.failed, 1);
      assert.equal(failure.jobs[0].status, "failed");
      break;
    }
    assert.equal(failure.retried, 1);
    assert.ok(failure.jobs[0].next_attempt_at);
    await db.exec("reset role");
    await db.query(
      "update public.workforce_payout_publication_refresh_jobs set next_attempt_at=clock_timestamp() where id=$1",
      [retryClaim.id]
    );
    await db.exec("set role service_role");
    retryClaim = (
      await db.query(
        `select * from public.workforce_claim_payout_publication_refresh_jobs(1,$1,$2)`,
        [company, fourthBatch]
      )
    ).rows[0];
  }
  const deadLetter = (
    await db.query(
      "select status,claim_attempts,failed_at,last_error from public.workforce_payout_publication_refresh_jobs where id=$1",
      [retryClaim.id]
    )
  ).rows[0];
  assert.equal(deadLetter.status, "failed");
  assert.equal(deadLetter.claim_attempts, 5);
  assert.ok(deadLetter.failed_at);
  assert.match(deadLetter.last_error, /attempt 5/);
  assert.equal((
    await db.query(
      `select count(*)::int as count
        from public.workforce_claim_payout_publication_refresh_jobs(1,$1,$2)`,
      [company, fourthBatch]
    )
  ).rows[0].count, 0, "dead-letter work is not reclaimed automatically");

  await db.exec("reset role");
  await assert.rejects(
    db.query(
      "update public.workforce_payout_review_submissions set status='approved' where id=$1",
      [review]
    ),
    /unresolved publication refresh/i,
    "dead-letter work keeps a stale published snapshot from being approved"
  );
  const replayAuditBefore = (
    await db.query(
      `select input_batch_id,base_publication_id,base_revision,requested_by,
        created_at::text as created_at
       from public.workforce_payout_publication_refresh_jobs where id=$1`,
      [retryClaim.id]
    )
  ).rows[0];
  await db.exec("set role service_role");
  await assert.rejects(
    db.query(
      `select public.workforce_replay_failed_payout_publication_refresh_jobs(
        array[$1::uuid,$1::uuid]
      )`,
      [retryClaim.id]
    ),
    /only once per request/i,
    "replay validates unique job IDs"
  );
  const replayResult = (
    await db.query(
      `select public.workforce_replay_failed_payout_publication_refresh_jobs(
        array[$1::uuid]
      ) as result`,
      [retryClaim.id]
    )
  ).rows[0].result;
  assert.equal(replayResult.replayed, 1);
  assert.deepEqual(replayResult.job_ids, [retryClaim.id]);
  const replayedJob = (
    await db.query(
      `select status,claim_attempts,claim_token,claimed_at,next_attempt_at,
        failed_at,last_error,completed_at,published_publication_id,
        input_batch_id,base_publication_id,base_revision,requested_by,
        created_at::text as created_at
       from public.workforce_payout_publication_refresh_jobs where id=$1`,
      [retryClaim.id]
    )
  ).rows[0];
  assert.equal(replayedJob.status, "pending");
  assert.equal(replayedJob.claim_attempts, 0);
  assert.equal(replayedJob.claim_token, null);
  assert.equal(replayedJob.claimed_at, null);
  assert.ok(replayedJob.next_attempt_at);
  assert.equal(replayedJob.failed_at, null);
  assert.equal(replayedJob.last_error, null);
  assert.equal(replayedJob.completed_at, null);
  assert.equal(replayedJob.published_publication_id, null);
  assert.deepEqual(
    {
      input_batch_id: replayedJob.input_batch_id,
      base_publication_id: replayedJob.base_publication_id,
      base_revision: replayedJob.base_revision,
      requested_by: replayedJob.requested_by,
      created_at: replayedJob.created_at
    },
    replayAuditBefore,
    "replay preserves the original request, batch, base revision, and creation audit"
  );

  await db.exec("reset role");
  await assert.rejects(
    db.query(
      "update public.workforce_payout_review_submissions set status='approved' where id=$1",
      [review]
    ),
    /unresolved publication refresh/i,
    "a replayed pending job continues blocking a terminal decision"
  );
  await db.exec("set role service_role");
  const replayClaim = (
    await db.query(
      `select * from public.workforce_claim_payout_publication_refresh_jobs(1,$1,$2)`,
      [company, fourthBatch]
    )
  ).rows[0];
  assert.equal(replayClaim.id, retryClaim.id);
  assert.equal(replayClaim.claim_attempts, 1);
  const replayApply = (
    await db.query(
      `select public.workforce_apply_payout_publication_input_revisions(
        $1,$2,$3,'hash-v2',$4,$5::jsonb
      ) as result`,
      [
        company,
        periodStart,
        periodEnd,
        actor,
        JSON.stringify([{
          job_id: replayClaim.id,
          claim_token: replayClaim.claim_token,
          workforce_id: workforce,
          station_id: station,
          snapshot: hashV2Snapshot,
          snapshot_hash: "c".repeat(64)
        }])
      ]
    )
  ).rows[0].result;
  assert.equal(replayApply.completed, 1, "replayed dead-letter work can reconcile the snapshot");

  const currentPublication = (
    await db.query(
      `select id,revision from public.workforce_payout_publications
       where company_id=$1 and workforce_id=$2 and station_id=$3
         and period_start=$4 and period_end=$5
       order by revision desc,published_at desc,id desc limit 1`,
      [company, workforce, station, periodStart, periodEnd]
    )
  ).rows[0];

  const oldestDueBatch = randomUUID();
  const newerDueBatch = randomUUID();
  const oldestDueJob = randomUUID();
  const oldestSecondGroupJob = randomUUID();
  const newerDueJob = randomUUID();
  await db.exec("reset role; begin");
  await db.query(
    `insert into public.workforce_payout_import_batches(
      id,company_id,effective_from,effective_to,file_name,file_sha256,status,
      row_count,created_by,committed_at
    ) values
      ($1,$3,$4,$5,'oldest-due.csv',$6,'committed',1,$7,clock_timestamp()),
      ($2,$3,$4,$5,'newer-due.csv',$8,'committed',1,$7,clock_timestamp())`,
    [oldestDueBatch, newerDueBatch, company, periodStart, periodEnd, "6".repeat(64), actor, "7".repeat(64)]
  );
  await db.query(
    `insert into public.workforce_payout_publication_refresh_jobs(
      id,company_id,input_batch_id,workforce_id,station_id,period_start,period_end,
      base_publication_id,base_revision,requested_by,next_attempt_at,created_at,updated_at
    ) values
      ($1,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp(),
        clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '2 minutes'),
      ($2,$3,$12,$13,$6,$7,$8,$14,1,$11,clock_timestamp(),
        clock_timestamp()-interval '1 minute',clock_timestamp()-interval '1 minute')`,
    [
      oldestDueJob, newerDueJob, company, oldestDueBatch, workforce, station,
      periodStart, periodEnd, currentPublication.id, currentPublication.revision,
      actor, newerDueBatch, sendingWorkforce, sendingPublication
    ]
  );
  await db.query(
    `insert into public.workforce_payout_publication_refresh_jobs(
      id,company_id,input_batch_id,workforce_id,station_id,period_start,period_end,
      base_publication_id,base_revision,requested_by,next_attempt_at,created_at,updated_at
    ) values (
      $1,$2,$3,$4,$5,'2026-08-01','2026-08-31',$6,1,$7,clock_timestamp(),
      clock_timestamp()-interval '90 seconds',clock_timestamp()-interval '90 seconds'
    )`,
    [oldestSecondGroupJob, company, oldestDueBatch, sendingWorkforce, station, sendingPublication, actor]
  );
  await db.exec("set role service_role");
  const oldestBatchClaim = await db.query(
    `select * from public.workforce_claim_payout_publication_refresh_jobs(1,$1,null)`,
    [company]
  );
  assert.equal(oldestBatchClaim.rows.length, 1);
  assert.equal(oldestBatchClaim.rows[0].id, oldestDueJob);
  assert.deepEqual(
    [...new Set(oldestBatchClaim.rows.map((row) => row.input_batch_id))],
    [oldestDueBatch],
    "one claim invocation is confined to the oldest eligible input batch"
  );
  const untouchedSameBatchGroup = (
    await db.query(
      `select status,claim_attempts,claim_token from public.workforce_payout_publication_refresh_jobs
       where id=$1`,
      [oldestSecondGroupJob]
    )
  ).rows[0];
  assert.deepEqual(
    untouchedSameBatchGroup,
    { status: "pending", claim_attempts: 0, claim_token: null },
    "a later processing group in the same input batch remains unleased until the worker asks for it"
  );
  const untouchedNewerBatch = (
    await db.query(
      `select status,claim_attempts,claim_token from public.workforce_payout_publication_refresh_jobs
       where id=$1`,
      [newerDueJob]
    )
  ).rows[0];
  assert.deepEqual(
    untouchedNewerBatch,
    { status: "pending", claim_attempts: 0, claim_token: null },
    "the newer batch remains wholly unclaimed"
  );
  const oldestSecondGroupClaim = await db.query(
    `select * from public.workforce_claim_payout_publication_refresh_jobs(1,$1,null)`,
    [company]
  );
  assert.equal(oldestSecondGroupClaim.rows.length, 1);
  assert.equal(oldestSecondGroupClaim.rows[0].id, oldestSecondGroupJob);
  assert.equal(oldestSecondGroupClaim.rows[0].claim_attempts, 1);
  const newerBatchClaim = await db.query(
    `select * from public.workforce_claim_payout_publication_refresh_jobs(1,$1,null)`,
    [company]
  );
  assert.equal(newerBatchClaim.rows.length, 1);
  assert.equal(newerBatchClaim.rows[0].input_batch_id, newerDueBatch, "the newer batch is claimable next");
  await db.exec("reset role; rollback");
  await db.exec("reset role");

  await db.exec("set role service_role");
  await assert.rejects(
    db.query(
      `select *
       from public.workforce_claim_selected_payout_publication_refresh_jobs(
         1,$1,array[$2,$2]::uuid[],$3,$4
       )`,
      [company, workforce, periodStart, periodEnd]
    ),
    /only once/i,
    "targeted claims reject duplicate Workforce IDs"
  );
  await assert.rejects(
    db.query(
      `select *
       from public.workforce_claim_selected_payout_publication_refresh_jobs(
         1,$1,array[$2]::uuid[],$3,'2026-09-29'
       )`,
      [company, workforce, periodStart]
    ),
    /complete calendar month/i,
    "targeted claims require an exact payout month"
  );
  const broadSelection = `{${Array.from({ length: 101 }, () => randomUUID()).join(",")}}`;
  const broadSelectionClaim = await db.query(
    `select *
     from public.workforce_claim_selected_payout_publication_refresh_jobs(
       1,$1,$2::uuid[],$3,$4
     )`,
    [company, broadSelection, periodStart, periodEnd]
  );
  assert.equal(
    broadSelectionClaim.rows.length,
    0,
    "the Workforce scope is not incorrectly capped at one 100-job claim batch"
  );

  const selectedWorkforceA = randomUUID();
  const selectedWorkforceB = randomUUID();
  const selectedWorkforceNewer = randomUUID();
  const unselectedWorkforce = randomUUID();
  const foreignCompany = randomUUID();
  const foreignStation = randomUUID();
  const foreignWorkforce = randomUUID();
  const targetedOldBatch = randomUUID();
  const targetedNewBatch = randomUUID();
  const unselectedBatch = randomUUID();
  const otherPeriodBatch = randomUUID();
  const foreignBatch = randomUUID();
  const predecessorJob = randomUUID();
  const successorJob = randomUUID();
  const sameBatchJob = randomUUID();
  const staleReclaimJob = randomUUID();
  const staleReclaimToken = randomUUID();
  const finalAttemptJob = randomUUID();
  const finalAttemptToken = randomUUID();
  const newerBatchJob = randomUUID();
  const unselectedFinalJob = randomUUID();
  const unselectedFinalToken = randomUUID();
  const otherPeriodJob = randomUUID();
  const foreignJob = randomUUID();
  const otherPeriodStart = "2026-10-01";
  const otherPeriodEnd = "2026-10-31";
  const targetClock = Date.now();
  const atMinutes = (minutes) => new Date(targetClock + minutes * 60_000).toISOString();

  await db.exec("reset role; begin");
  await db.query("insert into public.companies(id) values ($1)", [foreignCompany]);
  await db.query(
    "insert into public.stations(id,company_id,station_code) values ($1,$2,'FOREIGN')",
    [foreignStation, foreignCompany]
  );
  await db.query(
    `insert into public.workforce(id,company_id) values
      ($1,$6),($2,$6),($3,$6),($4,$6),($5,$7)`,
    [
      selectedWorkforceA,
      selectedWorkforceB,
      selectedWorkforceNewer,
      unselectedWorkforce,
      foreignWorkforce,
      company,
      foreignCompany
    ]
  );
  await db.query(
    `insert into public.workforce_payout_import_batches(
      id,company_id,effective_from,effective_to,file_name,file_sha256,status,
      row_count,created_by,committed_at
    ) values
      ($1,$6,$8,$9,'targeted-old.csv',$10,'committed',4,$11,clock_timestamp()),
      ($2,$6,$8,$9,'targeted-new.csv',$10,'committed',2,$11,clock_timestamp()),
      ($3,$6,$8,$9,'targeted-unselected.csv',$10,'committed',1,$11,clock_timestamp()),
      ($4,$6,$12,$13,'targeted-other-period.csv',$10,'committed',1,$11,clock_timestamp()),
      ($5,$7,$8,$9,'targeted-foreign.csv',$10,'committed',1,$11,clock_timestamp())`,
    [
      targetedOldBatch,
      targetedNewBatch,
      unselectedBatch,
      otherPeriodBatch,
      foreignBatch,
      company,
      foreignCompany,
      periodStart,
      periodEnd,
      "d".repeat(64),
      actor,
      otherPeriodStart,
      otherPeriodEnd
    ]
  );

  const insertPendingTargetJob = async ({
    id,
    companyId = company,
    batchId,
    workforceId,
    stationId = station,
    startsOn = periodStart,
    endsOn = periodEnd,
    nextAttemptAt,
    createdAt
  }) => db.query(
    `insert into public.workforce_payout_publication_refresh_jobs(
      id,company_id,input_batch_id,workforce_id,station_id,period_start,period_end,
      base_publication_id,base_revision,requested_by,next_attempt_at,created_at,updated_at
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
    [
      id,
      companyId,
      batchId,
      workforceId,
      stationId,
      startsOn,
      endsOn,
      currentPublication.id,
      currentPublication.revision,
      actor,
      nextAttemptAt,
      createdAt
    ]
  );
  const insertProcessingTargetJob = async ({
    id,
    batchId,
    workforceId,
    stationId,
    attempts,
    token,
    claimedAt,
    createdAt
  }) => db.query(
    `insert into public.workforce_payout_publication_refresh_jobs(
      id,company_id,input_batch_id,workforce_id,station_id,period_start,period_end,
      base_publication_id,base_revision,requested_by,status,claim_attempts,max_attempts,
      claim_token,claimed_at,created_at,updated_at
    ) values (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'processing',$11,5,$12,$13,$14,$14
    )`,
    [
      id,
      company,
      batchId,
      workforceId,
      stationId,
      periodStart,
      periodEnd,
      currentPublication.id,
      currentPublication.revision,
      actor,
      attempts,
      token,
      claimedAt,
      createdAt
    ]
  );

  await insertPendingTargetJob({
    id: predecessorJob,
    batchId: targetedOldBatch,
    workforceId: selectedWorkforceA,
    nextAttemptAt: atMinutes(60),
    createdAt: atMinutes(-6)
  });
  await insertPendingTargetJob({
    id: sameBatchJob,
    batchId: targetedOldBatch,
    workforceId: selectedWorkforceB,
    nextAttemptAt: atMinutes(-1),
    createdAt: atMinutes(-5)
  });
  await insertProcessingTargetJob({
    id: staleReclaimJob,
    batchId: targetedOldBatch,
    workforceId: selectedWorkforceB,
    stationId: otherStation,
    attempts: 1,
    token: staleReclaimToken,
    claimedAt: atMinutes(-11),
    createdAt: atMinutes(-4)
  });
  await insertProcessingTargetJob({
    id: finalAttemptJob,
    batchId: targetedOldBatch,
    workforceId: selectedWorkforceA,
    stationId: otherStation,
    attempts: 5,
    token: finalAttemptToken,
    claimedAt: atMinutes(-11),
    createdAt: atMinutes(-3)
  });
  await insertPendingTargetJob({
    id: successorJob,
    batchId: targetedNewBatch,
    workforceId: selectedWorkforceA,
    nextAttemptAt: atMinutes(-1),
    createdAt: atMinutes(-2)
  });
  await insertPendingTargetJob({
    id: newerBatchJob,
    batchId: targetedNewBatch,
    workforceId: selectedWorkforceNewer,
    nextAttemptAt: atMinutes(-1),
    createdAt: atMinutes(-1)
  });
  await insertProcessingTargetJob({
    id: unselectedFinalJob,
    batchId: unselectedBatch,
    workforceId: unselectedWorkforce,
    stationId: station,
    attempts: 5,
    token: unselectedFinalToken,
    claimedAt: atMinutes(-11),
    createdAt: atMinutes(-10)
  });
  await insertPendingTargetJob({
    id: otherPeriodJob,
    batchId: otherPeriodBatch,
    workforceId: selectedWorkforceA,
    startsOn: otherPeriodStart,
    endsOn: otherPeriodEnd,
    nextAttemptAt: atMinutes(-1),
    createdAt: atMinutes(-20)
  });
  await insertPendingTargetJob({
    id: foreignJob,
    companyId: foreignCompany,
    batchId: foreignBatch,
    workforceId: foreignWorkforce,
    stationId: foreignStation,
    nextAttemptAt: atMinutes(-1),
    createdAt: atMinutes(-30)
  });

  await db.exec("set role service_role");
  const predecessorBlockedClaim = await db.query(
    `select *
     from public.workforce_claim_selected_payout_publication_refresh_jobs(
       100,$1,array[$2]::uuid[],$3,$4
     )`,
    [company, selectedWorkforceA, periodStart, periodEnd]
  );
  assert.equal(
    predecessorBlockedClaim.rows.length,
    0,
    "a due selected generation cannot leapfrog an older delayed predecessor"
  );
  const scopedDeadLetter = (
    await db.query(
      "select status,claim_token,claimed_at,failed_at from public.workforce_payout_publication_refresh_jobs where id=$1",
      [finalAttemptJob]
    )
  ).rows[0];
  assert.equal(scopedDeadLetter.status, "failed");
  assert.equal(scopedDeadLetter.claim_token, null);
  assert.equal(scopedDeadLetter.claimed_at, null);
  assert.ok(scopedDeadLetter.failed_at);
  const unselectedLease = (
    await db.query(
      "select status,claim_attempts,claim_token from public.workforce_payout_publication_refresh_jobs where id=$1",
      [unselectedFinalJob]
    )
  ).rows[0];
  assert.deepEqual(
    unselectedLease,
    { status: "processing", claim_attempts: 5, claim_token: unselectedFinalToken },
    "the dead-letter sweep cannot mutate an unselected Workforce lease"
  );

  await db.exec("reset role");
  await db.query(
    "update public.workforce_payout_publication_refresh_jobs set next_attempt_at=clock_timestamp() where id=$1",
    [predecessorJob]
  );
  await db.exec("set role service_role");
  const selectedBatchClaim = await db.query(
    `select *
     from public.workforce_claim_selected_payout_publication_refresh_jobs(
       100,$1,array[$2,$3,$4]::uuid[],$5,$6
     )`,
    [
      company,
      selectedWorkforceA,
      selectedWorkforceB,
      selectedWorkforceNewer,
      periodStart,
      periodEnd
    ]
  );
  assert.deepEqual(
    selectedBatchClaim.rows.map((row) => row.id).sort(),
    [predecessorJob, sameBatchJob, staleReclaimJob].sort(),
    "the targeted claim leases only eligible identities from the oldest selected batch"
  );
  assert.deepEqual(
    [...new Set(selectedBatchClaim.rows.map((row) => row.input_batch_id))],
    [targetedOldBatch]
  );
  const reclaimedLease = selectedBatchClaim.rows.find((row) => row.id === staleReclaimJob);
  assert.equal(reclaimedLease.claim_attempts, 2);
  assert.notEqual(reclaimedLease.claim_token, staleReclaimToken);

  const untouchedTargetRows = await db.query(
    `select id,status,claim_attempts
     from public.workforce_payout_publication_refresh_jobs
     where id in ($1,$2,$3,$4)
     order by id`,
    [successorJob, newerBatchJob, otherPeriodJob, foreignJob]
  );
  assert.deepEqual(
    untouchedTargetRows.rows.map((row) => [row.id, row.status, row.claim_attempts]),
    [successorJob, newerBatchJob, otherPeriodJob, foreignJob]
      .sort()
      .map((id) => [id, "pending", 0]),
    "newer-batch, other-period, and other-company jobs remain untouched"
  );
  await db.exec("reset role; rollback");
  await db.exec("reset role");

  const coveredFailedBatch = randomUUID();
  const successfulNewerBatch = randomUUID();
  const blockingNewerBatch = randomUUID();
  const coveredFailedJob = randomUUID();
  const successfulNewerJob = randomUUID();
  const blockingNewerJob = randomUUID();
  await db.exec("begin");
  await db.query(
    `insert into public.workforce_payout_import_batches(
      id,company_id,effective_from,effective_to,file_name,file_sha256,status,
      row_count,created_by,committed_at
    ) values
      ($1,$4,$5,$6,'covered-failed.csv',$7,'committed',1,$8,clock_timestamp()),
      ($2,$4,$5,$6,'successful-newer.csv',$9,'committed',1,$8,clock_timestamp()),
      ($3,$4,$5,$6,'blocking-newer.csv',$10,'committed',1,$8,clock_timestamp())`,
    [
      coveredFailedBatch, successfulNewerBatch, blockingNewerBatch, company,
      periodStart, periodEnd, "8".repeat(64), actor, "9".repeat(64), "a".repeat(64)
    ]
  );
  await db.query(
    `insert into public.workforce_payout_publication_refresh_jobs(
      id,company_id,input_batch_id,workforce_id,station_id,period_start,period_end,
      base_publication_id,base_revision,requested_by,status,claim_attempts,
      next_attempt_at,failed_at,last_error,created_at,updated_at
    ) values
      ($1,$3,$4,$5,$6,$7,$8,$9,$10,$11,'failed',5,null,clock_timestamp(),
        'older dead letter',clock_timestamp()-interval '3 minutes',clock_timestamp()-interval '3 minutes'),
      ($2,$3,$12,$5,$6,$7,$8,$9,$10,$11,'pending',0,clock_timestamp(),null,null,
        clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '2 minutes')`,
    [
      coveredFailedJob, successfulNewerJob, company, coveredFailedBatch, workforce,
      station, periodStart, periodEnd, currentPublication.id, currentPublication.revision,
      actor, successfulNewerBatch
    ]
  );
  await db.exec("set role service_role");
  const successfulClaim = (
    await db.query(
      `select * from public.workforce_claim_payout_publication_refresh_jobs(1,$1,$2)`,
      [company, successfulNewerBatch]
    )
  ).rows[0];
  assert.equal(successfulClaim.id, successfulNewerJob);
  const successfulApply = (
    await db.query(
      `select public.workforce_apply_payout_publication_input_revisions(
        $1,$2,$3,'hash-v2',$4,$5::jsonb
      ) as result`,
      [
        company,
        periodStart,
        periodEnd,
        actor,
        JSON.stringify([{
          job_id: successfulClaim.id,
          claim_token: successfulClaim.claim_token,
          workforce_id: workforce,
          station_id: station,
          snapshot: hashV2Snapshot,
          snapshot_hash: "b".repeat(64)
        }])
      ]
    )
  ).rows[0].result;
  const successfulPublicationId = successfulApply.publication_ids[0];
  const reconciledOlderFailure = (
    await db.query(
      `select status,published_publication_id,completed_at,last_error
       from public.workforce_payout_publication_refresh_jobs where id=$1`,
      [coveredFailedJob]
    )
  ).rows[0];
  assert.equal(reconciledOlderFailure.status, "completed");
  assert.equal(reconciledOlderFailure.published_publication_id, successfulPublicationId);
  assert.ok(reconciledOlderFailure.completed_at);
  assert.match(reconciledOlderFailure.last_error, /reconciled by newer successful publication/i);

  await db.exec("reset role; savepoint terminal_unblocked");
  await db.query(
    "update public.workforce_payout_review_submissions set status='approved' where id=$1",
    [review]
  );
  await db.exec("rollback to savepoint terminal_unblocked");
  await db.query(
    `insert into public.workforce_payout_publication_refresh_jobs(
      id,company_id,input_batch_id,workforce_id,station_id,period_start,period_end,
      base_publication_id,base_revision,requested_by,status,claim_attempts,
      next_attempt_at,failed_at,last_error,created_at,updated_at
    ) values (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'failed',5,null,clock_timestamp(),
      'newer unresolved dead letter',clock_timestamp()-interval '1 minute',clock_timestamp()-interval '1 minute'
    )`,
    [
      blockingNewerJob, company, blockingNewerBatch, workforce, station,
      periodStart, periodEnd, successfulPublicationId, currentPublication.revision + 1, actor
    ]
  );
  await assert.rejects(
    db.query(
      "update public.workforce_payout_review_submissions set status='approved' where id=$1",
      [review]
    ),
    /unresolved publication refresh/i,
    "a failed generation newer than the successful publication remains blocking"
  );
  await db.exec("rollback");

  await db.exec("reset role");
  await db.query(
    "update public.workforce_payout_review_submissions set status='approved' where id=$1",
    [review]
  );
  await db.exec("reset role");
  const batchesBeforeApprovedConflict = Number((
    await db.query("select count(*)::int as count from public.workforce_payout_import_batches")
  ).rows[0].count);
  await db.exec("set role service_role");
  await assert.rejects(
    db.query(
      `select public.workforce_apply_payout_import(
        $1,$2,$3,'approved.csv',$4,$5::jsonb,$6,null
      )`,
      [company, periodStart, periodEnd, "5".repeat(64), JSON.stringify([importRows[0]]), actor]
    ),
    /approved or cancelled/i,
    "an approved review rolls the entire input import back"
  );
  await db.exec("reset role");
  assert.equal(
    Number((await db.query("select count(*)::int as count from public.workforce_payout_import_batches")).rows[0].count),
    batchesBeforeApprovedConflict
  );

  for (const role of ["anon", "authenticated"]) {
    await db.exec(`reset role; set role ${role}`);
    await assert.rejects(
      db.query("select * from public.workforce_payout_publication_refresh_jobs"),
      /permission denied/i
    );
    await assert.rejects(
      db.query("select * from public.workforce_claim_payout_publication_refresh_jobs(1,null,null)"),
      /permission denied/i
    );
    await assert.rejects(
      db.query(
        `select *
         from public.workforce_claim_selected_payout_publication_refresh_jobs(
           1,$1,array[$2]::uuid[],$3,$4
         )`,
        [company, workforce, periodStart, periodEnd]
      ),
      /permission denied/i
    );
    await assert.rejects(
      db.query(
        `select public.workforce_apply_payout_publication_input_revisions(
          $1,$2,$3,'hash-v2',$4,'[]'::jsonb
        )`,
        [company, periodStart, periodEnd, actor]
      ),
      /permission denied/i
    );
    await assert.rejects(
      db.query("select public.workforce_fail_payout_publication_refresh_jobs('[]'::jsonb)"),
      /permission denied/i
    );
    await assert.rejects(
      db.query("select public.workforce_replay_failed_payout_publication_refresh_jobs(array[]::uuid[])"),
      /permission denied/i
    );
    await assert.rejects(
      db.query(
        `select public.workforce_transition_payout_review_status(
          $1,'workforce',$2,$3,$4,$5,'under_review','approved',null
        )`,
        [company, workforce, station, periodStart, periodEnd]
      ),
      /permission denied/i
    );
  }

  await db.exec("reset role");
  const security = await db.query(`
    select
      c.relrowsecurity as rls_enabled,
      c.relforcerowsecurity as force_rls,
      has_function_privilege('service_role',
        'public.workforce_claim_payout_publication_refresh_jobs(integer,uuid,uuid)', 'execute') as service_claim,
      has_function_privilege('anon',
        'public.workforce_claim_payout_publication_refresh_jobs(integer,uuid,uuid)', 'execute') as anon_claim,
      has_function_privilege('service_role',
        'public.workforce_claim_selected_payout_publication_refresh_jobs(integer,uuid,uuid[],date,date)', 'execute') as service_selected_claim,
      has_function_privilege('anon',
        'public.workforce_claim_selected_payout_publication_refresh_jobs(integer,uuid,uuid[],date,date)', 'execute') as anon_selected_claim,
      has_function_privilege('service_role',
        'public.workforce_apply_payout_publication_input_revisions(uuid,date,date,text,uuid,jsonb)', 'execute') as service_apply,
      has_function_privilege('authenticated',
        'public.workforce_apply_payout_publication_input_revisions(uuid,date,date,text,uuid,jsonb)', 'execute') as authenticated_apply,
      has_function_privilege('service_role',
        'public.workforce_fail_payout_publication_refresh_jobs(jsonb)', 'execute') as service_fail,
      has_function_privilege('authenticated',
        'public.workforce_fail_payout_publication_refresh_jobs(jsonb)', 'execute') as authenticated_fail,
      has_function_privilege('service_role',
        'public.workforce_replay_failed_payout_publication_refresh_jobs(uuid[])', 'execute') as service_replay,
      has_function_privilege('authenticated',
        'public.workforce_replay_failed_payout_publication_refresh_jobs(uuid[])', 'execute') as authenticated_replay,
      has_function_privilege('service_role',
        'public.workforce_transition_payout_review_status(uuid,text,uuid,uuid,date,date,text,text,uuid[])', 'execute') as service_review_transition,
      has_function_privilege('authenticated',
        'public.workforce_transition_payout_review_status(uuid,text,uuid,uuid,date,date,text,text,uuid[])', 'execute') as authenticated_review_transition,
      has_function_privilege('service_role',
        'public.workforce_send_payouts_for_review_without_lock_order(uuid,uuid,date,date,jsonb,uuid[])', 'execute') as service_unordered_review_send,
      has_table_privilege('service_role',
        'public.workforce_payout_review_submissions', 'update') as service_direct_review_update,
      (select p.prosecdef from pg_proc p where p.oid =
        'public.workforce_send_payouts_for_review(uuid,uuid,date,date,jsonb,uuid[])'::regprocedure) as review_send_definer,
      (select p.prosecdef from pg_proc p where p.oid =
        'public.workforce_publish_payout_notifications(uuid,uuid,date,date,jsonb,uuid[],text,timestamptz,timestamptz,uuid,timestamptz)'::regprocedure) as payout_publish_definer,
      (select p.prosecdef from pg_proc p where p.oid =
        'public.workforce_transition_payout_review_status(uuid,text,uuid,uuid,date,date,text,text,uuid[])'::regprocedure) as review_transition_definer,
      has_table_privilege('service_role',
        'public.workforce_payout_publication_refresh_jobs', 'update') as service_direct_update
    from pg_class c
    where c.oid='public.workforce_payout_publication_refresh_jobs'::regclass
  `);
  assert.equal(security.rows[0].rls_enabled, true);
  assert.equal(security.rows[0].force_rls, true);
  assert.equal(security.rows[0].service_claim, true);
  assert.equal(security.rows[0].anon_claim, false);
  assert.equal(security.rows[0].service_selected_claim, true);
  assert.equal(security.rows[0].anon_selected_claim, false);
  assert.equal(security.rows[0].service_apply, true);
  assert.equal(security.rows[0].authenticated_apply, false);
  assert.equal(security.rows[0].service_fail, true);
  assert.equal(security.rows[0].authenticated_fail, false);
  assert.equal(security.rows[0].service_replay, true);
  assert.equal(security.rows[0].authenticated_replay, false);
  assert.equal(security.rows[0].service_review_transition, true);
  assert.equal(security.rows[0].authenticated_review_transition, false);
  assert.equal(security.rows[0].service_unordered_review_send, false);
  assert.equal(security.rows[0].service_direct_review_update, false);
  assert.equal(security.rows[0].review_send_definer, true);
  assert.equal(security.rows[0].payout_publish_definer, true);
  assert.equal(security.rows[0].review_transition_definer, true);
  assert.equal(security.rows[0].service_direct_update, false);

  console.log("Workforce payout publication refresh queue verification passed.");
} finally {
  await db.close();
}
