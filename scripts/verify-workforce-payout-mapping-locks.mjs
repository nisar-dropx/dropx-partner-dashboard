import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync(
  new URL("../supabase/migrations/20261009124255_workforce_payout_mapping_unlock_relock.sql", import.meta.url),
  "utf8"
).replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");

const db = new PGlite();

const company = randomUUID();
const actor = randomUUID();
const originalSubmitter = randomUUID();
const station = randomUUID();
const provider = randomUUID();
const workforce = randomUUID();
const review = randomUUID();
const publication = randomUUID();
const mapping = randomUUID();
const periodStart = "2026-09-01";
const periodEnd = "2026-09-30";
const dependencyHash = "hash-v2";

const publicationSnapshot = (workforceId, stationId, memberId) => ({
  schema_version: "2",
  source: "workforce_payout_worksheet",
  dependency_hash: dependencyHash,
  run: { period_start: periodStart, period_end: periodEnd },
  item: {
    workforce_id: workforceId,
    station_id: stationId,
    provider_member_ids: [memberId]
  },
  lines: [],
  worksheet: {}
});

async function seedPublishedPayout({
  workforceId,
  reviewId,
  publicationId,
  mappingId,
  memberId,
  reviewStatus = "under_review",
  submittedBy = actor,
  submittedAt = "2026-09-15T12:00:00.000Z"
}) {
  await db.query(
    `insert into public.workforce(id,company_id) values ($1,$2)`,
    [workforceId, company]
  );
  await db.query(
    `insert into public.field_executive_provider_mappings(
      id,company_id,workforce_id,provider_id,provider_member_id,station_id,
      status,effective_from,effective_to,updated_at
    ) values ($1,$2,$3,$4,$5,$6,'active',$7,$8,clock_timestamp())`,
    [mappingId, company, workforceId, provider, memberId, station, periodStart, periodEnd]
  );
  await db.query(
    `insert into public.workforce_payout_review_submissions(
      id,company_id,subject_type,subject_id,location_id,period_start,period_end,
      status,calculation_snapshot,submitted_by,submitted_at,updated_at
    ) values ($1,$2,'workforce',$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$10)`,
    [
      reviewId,
      company,
      workforceId,
      station,
      periodStart,
      periodEnd,
      reviewStatus,
      JSON.stringify(publicationSnapshot(workforceId, station, memberId)),
      submittedBy,
      submittedAt
    ]
  );
  await db.query(
    `insert into public.workforce_payout_publications(
      id,company_id,workforce_id,station_id,revision,snapshot,published_by,
      published_at,review_until,notify_at,source_calculated_at,
      notification_status,review_submission_id,period_start,period_end,
      snapshot_hash,dependency_hash,notification_config_snapshot,
      publication_kind,revision_source,input_batch_id,supersedes_publication_id
    ) values (
      $1,$2,$3,$4,1,$5::jsonb,$6,clock_timestamp(),clock_timestamp()+interval '7 days',
      clock_timestamp(),clock_timestamp(),'sent',$7,$8,$9,$10,$11,
      '{"schema_version":"1"}'::jsonb,'worksheet','initial',null,null
    )`,
    [
      publicationId,
      company,
      workforceId,
      station,
      JSON.stringify(publicationSnapshot(workforceId, station, memberId)),
      actor,
      reviewId,
      periodStart,
      periodEnd,
      "a".repeat(64),
      dependencyHash
    ]
  );
}

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
      submitted_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      unique(company_id,subject_type,subject_id,location_id,period_start,period_end)
    );
    create table public.workforce_payroll_runs(
      id uuid primary key,
      company_id uuid not null,
      status text not null,
      period_start date not null,
      period_end date not null
    );
    create table public.workforce_payroll_items(
      id uuid primary key,
      company_id uuid not null,
      payroll_run_id uuid not null,
      workforce_id uuid not null,
      station_id uuid,
      status text check (status in ('ready','hold','excluded','paid')),
      updated_at timestamptz not null default clock_timestamp()
    );
    grant all on table public.workforce_payroll_items to service_role;
    create table public.field_executive_provider_mappings(
      id uuid primary key,
      company_id uuid not null,
      workforce_id uuid,
      field_executive_id uuid,
      employee_id uuid,
      contractor_id uuid,
      provider_id uuid,
      provider_member_id text,
      station_id uuid,
      status text not null,
      effective_from date not null,
      effective_to date,
      updated_at timestamptz
    );
    create table public.workforce_payout_publications(
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null,
      payroll_run_id uuid,
      workforce_id uuid not null,
      station_id uuid not null,
      revision integer not null,
      snapshot jsonb not null,
      published_by uuid not null,
      published_at timestamptz not null default clock_timestamp(),
      review_until timestamptz not null,
      notify_at timestamptz not null,
      source_calculated_at timestamptz not null,
      notification_status text not null,
      notification_error text,
      notification_reference text,
      notification_attempted_at timestamptz,
      review_submission_id uuid,
      period_start date,
      period_end date,
      snapshot_hash text,
      dependency_hash text,
      notification_config_snapshot jsonb not null default '{}'::jsonb,
      publication_kind text not null default 'legacy_payroll',
      revision_source text not null default 'initial',
      input_batch_id uuid,
      supersedes_publication_id uuid,
      constraint workforce_payout_publications_revision_source_check
        check (revision_source in ('initial','input_batch_refresh')),
      constraint workforce_payout_publications_revision_source_shape_check
        check (
          (revision_source='initial' and input_batch_id is null and supersedes_publication_id is null)
          or
          (revision_source='input_batch_refresh' and input_batch_id is not null and supersedes_publication_id is not null)
        )
    );
    create unique index workforce_payout_publications_worksheet_revision_uidx
      on public.workforce_payout_publications(
        company_id,workforce_id,station_id,period_start,period_end,revision
      ) where publication_kind='worksheet';
    create table public.workforce_payout_disputes(
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references public.companies(id),
      publication_id uuid not null references public.workforce_payout_publications(id),
      payroll_run_id uuid references public.workforce_payroll_runs(id),
      workforce_id uuid not null references public.workforce(id),
      station_id uuid not null references public.stations(id),
      category text not null check (category in ('counts','training','loss','tds','other')),
      reason text not null check (length(btrim(reason)) between 10 and 2000),
      status text not null default 'open' check (status in ('open','in_review','resolved','rejected')),
      resolution text,
      resolved_by uuid references auth.users(id),
      resolved_at timestamptz,
      correction_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table public.workforce_payout_publication_refresh_jobs(
      id uuid primary key,
      company_id uuid not null,
      workforce_id uuid not null,
      station_id uuid not null,
      period_start date not null,
      period_end date not null,
      status text not null
    );

    create function public.lock_workforce_payment_allocation_company(uuid)
    returns void language sql as $$ select $$;
    create function public.workforce_provider_mapping_person(uuid,uuid,uuid,uuid,uuid)
    returns uuid language sql stable as $$ select coalesce($2,$3,$4,$5) $$;
    create function public.workforce_advance_recovery_snapshot_hash(uuid,date,date)
    returns text language sql stable as $$ select '${dependencyHash}'::text $$;

    create function public.guard_workforce_payout_publication_immutable()
    returns trigger language plpgsql set search_path='' as $$
    begin
      if (to_jsonb(new)-array[
          'notification_status','notification_error','notification_reference',
          'notification_attempted_at','notify_at'
        ]::text[]) is distinct from
        (to_jsonb(old)-array[
          'notification_status','notification_error','notification_reference',
          'notification_attempted_at','notify_at'
        ]::text[])
      then
        raise exception 'A published Workforce payout snapshot is immutable. Publish a new revision instead.';
      end if;
      return new;
    end $$;
    create trigger workforce_payout_publications_00_immutable
      before update on public.workforce_payout_publications
      for each row execute function public.guard_workforce_payout_publication_immutable();

    create function public.guard_published_workforce_provider_mapping()
    returns trigger language plpgsql set search_path='' as $$
    begin
      return case when tg_op='DELETE' then old else new end;
    end $$;
    create trigger field_executive_provider_mappings_00_published_payout_guard
      before insert or update or delete on public.field_executive_provider_mappings
      for each row execute function public.guard_published_workforce_provider_mapping();
  `);

  await db.exec(migration);
  assert.equal(
    (await db.query(
      `select has_table_privilege(
        'service_role','public.workforce_payroll_items','truncate'
      ) as allowed`
    )).rows[0].allowed,
    false,
    "the service role cannot bypass finalized-item guards with TRUNCATE"
  );

  await db.query(`insert into auth.users(id) values ($1),($2)`, [actor, originalSubmitter]);
  await db.query(`insert into public.companies(id) values ($1)`, [company]);
  await db.query(
    `insert into public.stations(id,company_id,station_code) values ($1,$2,'STN')`,
    [station, company]
  );
  await seedPublishedPayout({
    workforceId: workforce,
    reviewId: review,
    publicationId: publication,
    mappingId: mapping,
    memberId: "OLD-ID",
    submittedBy: originalSubmitter
  });

  const finalizedItemWorkforce = randomUUID();
  const finalizedItemOtherWorkforce = randomUUID();
  const finalizedItemRun = randomUUID();
  const finalizedItemDraftRun = randomUUID();
  const finalizedItem = randomUUID();
  await db.query(
    `insert into public.workforce(id,company_id) values ($1,$3),($2,$3)`,
    [finalizedItemWorkforce, finalizedItemOtherWorkforce, company]
  );
  await db.query(
    `insert into public.workforce_payroll_runs(id,company_id,status,period_start,period_end)
     values
       ($1,$3,'draft','2026-06-01','2026-06-30'),
       ($2,$3,'draft','2026-07-01','2026-07-31')`,
    [finalizedItemRun, finalizedItemDraftRun, company]
  );
  await db.query(
    `insert into public.workforce_payroll_items(
      id,company_id,payroll_run_id,workforce_id,station_id,status
    ) values ($1,$2,$3,$4,$5,'ready')`,
    [finalizedItem, company, finalizedItemRun, finalizedItemWorkforce, station]
  );
  await db.query(
    `update public.workforce_payroll_runs set status='approved' where id=$1`,
    [finalizedItemRun]
  );

  await assert.rejects(
    db.query(
      `insert into public.workforce_payroll_items(
        id,company_id,payroll_run_id,workforce_id,station_id,status
      ) values ($1,$2,$3,$4,$5,'ready')`,
      [randomUUID(), company, finalizedItemRun, finalizedItemOtherWorkforce, station]
    ),
    /approved or paid Workforce payroll items are immutable/i,
    "a finalized payroll must reject a new member"
  );
  await assert.rejects(
    db.query(
      `update public.workforce_payroll_items set workforce_id=$2 where id=$1`,
      [finalizedItem, finalizedItemOtherWorkforce]
    ),
    /approved or paid Workforce payroll items are immutable/i,
    "a finalized payroll item cannot be reassigned"
  );
  await assert.rejects(
    db.query(
      `update public.workforce_payroll_items set payroll_run_id=$2 where id=$1`,
      [finalizedItem, finalizedItemDraftRun]
    ),
    /approved or paid Workforce payroll items are immutable/i,
    "a finalized payroll item cannot be moved back into a draft run"
  );
  await assert.rejects(
    db.query(
      `update public.workforce_payroll_items set status='excluded' where id=$1`,
      [finalizedItem]
    ),
    /approved or paid Workforce payroll items are immutable/i,
    "a finalized payroll item cannot be excluded"
  );
  await assert.rejects(
    db.query(`delete from public.workforce_payroll_items where id=$1`, [finalizedItem]),
    /approved or paid Workforce payroll items are immutable/i,
    "a finalized payroll item cannot be deleted"
  );
  await assert.rejects(
    db.query(
      `update public.workforce_payroll_items
       set status='paid',station_id=$2,updated_at=clock_timestamp() where id=$1`,
      [finalizedItem, randomUUID()]
    ),
    /only the ready-to-paid payment transition is allowed/i,
    "ready-to-paid cannot conceal another finalized-item change"
  );
  await db.query(
    `update public.workforce_payroll_items
     set status='paid',updated_at=clock_timestamp() where id=$1`,
    [finalizedItem]
  );
  assert.equal(
    (await db.query(
      `select status from public.workforce_payroll_items where id=$1`,
      [finalizedItem]
    )).rows[0].status,
    "paid",
    "the canonical ready-to-paid transition remains available"
  );

  await assert.rejects(
    db.query(
      `update public.field_executive_provider_mappings
       set provider_member_id='BLOCKED-ID' where id=$1`,
      [mapping]
    ),
    /published to DropX One/i,
    "a published payout must lock its provider mapping before an audited unlock"
  );

  const unlockOperation = randomUUID();
  const unlockReason = "Correct the provider member ID for the published month.";
  const unlockResult = (
    await db.query(
      `select public.workforce_unlock_payout_mappings(
        $1,$2,$3,$4,array[$5]::uuid[],$6,$7
      ) as result`,
      [
        company,
        actor,
        periodStart,
        periodEnd,
        workforce,
        unlockOperation,
        unlockReason
      ]
    )
  ).rows[0].result;
  assert.equal(unlockResult.unlocked, 1);
  assert.equal(unlockResult.unlock_ids.length, 1);

  const unlockRetry = (
    await db.query(
      `select public.workforce_unlock_payout_mappings(
        $1,$2,$3,$4,array[$5]::uuid[],$6,$7
      ) as result`,
      [company, actor, periodStart, periodEnd, workforce, unlockOperation, unlockReason]
    )
  ).rows[0].result;
  assert.deepEqual(unlockRetry, unlockResult, "an identical unlock retry must reuse its audit row");
  assert.equal(Number((
    await db.query(
      `select count(*)::int as count from public.workforce_payout_mapping_unlocks
       where company_id=$1 and unlock_operation_id=$2`,
      [company, unlockOperation]
    )
  ).rows[0].count), 1);
  await assert.rejects(
    db.query(
      `select public.workforce_unlock_payout_mappings(
        $1,$2,$3,$4,array[$5]::uuid[],$6,$7
      )`,
      [
        company,
        actor,
        periodStart,
        periodEnd,
        workforce,
        unlockOperation,
        "Reuse the operation ID with a different unlock reason."
      ]
    ),
    /operation ID belongs to another request/i,
    "an unlock operation UUID must reject a different payload"
  );

  await assert.rejects(
    db.query(
      `insert into public.workforce_payout_disputes(
        company_id,publication_id,workforce_id,station_id,category,reason
      ) values ($1,$2,$3,$4,'other',$5)`,
      [
        company,
        publication,
        workforce,
        station,
        "Attempt a dispute while the payout mapping correction is open."
      ]
    ),
    /being revised after an ID mapping correction/i,
    "an open mapping unlock must block disputes against the affected publication"
  );

  await db.query(
    `update public.field_executive_provider_mappings
     set provider_member_id='NEW-ID',updated_at=clock_timestamp() where id=$1`,
    [mapping]
  );
  assert.equal(
    (await db.query(
      `select provider_member_id from public.field_executive_provider_mappings where id=$1`,
      [mapping]
    )).rows[0].provider_member_id,
    "NEW-ID"
  );

  await assert.rejects(
    db.query(
      `insert into public.workforce_payout_publications(
        company_id,workforce_id,station_id,revision,snapshot,published_by,
        review_until,notify_at,source_calculated_at,notification_status,
        review_submission_id,period_start,period_end,snapshot_hash,dependency_hash,
        notification_config_snapshot,publication_kind,revision_source,
        input_batch_id,supersedes_publication_id
      ) select company_id,workforce_id,station_id,2,snapshot,published_by,
        review_until,notify_at,source_calculated_at,'disabled',review_submission_id,
        period_start,period_end,$2,dependency_hash,notification_config_snapshot,
        'worksheet','initial',null,null
        from public.workforce_payout_publications where id=$1`,
      [publication, "c".repeat(64)]
    ),
    /mapping is unlocked/i,
    "an open mapping correction must block competing worksheet revisions"
  );

  await db.exec("begin");
  let emptyRelockError;
  try {
    await db.query(
      `select public.workforce_relock_payout_mappings(
        $1,$2,$3,$4,array[$5]::uuid[],$6,$7,$8,'[]'::jsonb
      )`,
      [
        company,
        actor,
        periodStart,
        periodEnd,
        unlockResult.unlock_ids[0],
        randomUUID(),
        "Attempt an incomplete relock without a worksheet row.",
        dependencyHash
      ]
    );
  } catch (error) {
    emptyRelockError = error;
  }
  await db.exec("rollback");
  assert.ok(emptyRelockError, "relock must reject an empty replacement worksheet");

  const reviewAuditBefore = (
    await db.query(
      `select submitted_by,submitted_at::text as submitted_at
       from public.workforce_payout_review_submissions where id=$1`,
      [review]
    )
  ).rows[0];

  const relockOperation = randomUUID();
  const relockSummary = "Relock after correcting the provider member ID.";
  const replacementSnapshot = publicationSnapshot(workforce, station, "NEW-ID");
  const relockItems = [{
    workforce_id: workforce,
    station_id: station,
    snapshot: replacementSnapshot,
    snapshot_hash: "b".repeat(64)
  }];
  const relockResult = (
    await db.query(
      `select public.workforce_relock_payout_mappings(
        $1,$2,$3,$4,array[$5]::uuid[],$6,$7,$8,$9::jsonb
      ) as result`,
      [
        company,
        actor,
        periodStart,
        periodEnd,
        unlockResult.unlock_ids[0],
        relockOperation,
        relockSummary,
        dependencyHash,
        JSON.stringify(relockItems)
      ]
    )
  ).rows[0].result;
  assert.equal(relockResult.relocked, 1);
  assert.equal(relockResult.published, 1);

  const reviewAuditAfter = (
    await db.query(
      `select submitted_by,submitted_at::text as submitted_at
       from public.workforce_payout_review_submissions where id=$1`,
      [review]
    )
  ).rows[0];
  assert.deepEqual(
    reviewAuditAfter,
    reviewAuditBefore,
    "relock must preserve the original review submitter and submission time"
  );

  const relockRetry = (
    await db.query(
      `select public.workforce_relock_payout_mappings(
        $1,$2,$3,$4,array[$5]::uuid[],$6,$7,$8,$9::jsonb
      ) as result`,
      [
        company,
        actor,
        periodStart,
        periodEnd,
        unlockResult.unlock_ids[0],
        relockOperation,
        relockSummary,
        dependencyHash,
        JSON.stringify(relockItems)
      ]
    )
  ).rows[0].result;
  assert.deepEqual(relockRetry, relockResult, "an identical relock retry must reuse N+1");
  await assert.rejects(
    db.query(
      `select public.workforce_relock_payout_mappings(
        $1,$2,$3,$4,array[$5]::uuid[],$6,$7,$8,$9::jsonb
      )`,
      [
        company,
        actor,
        periodStart,
        periodEnd,
        unlockResult.unlock_ids[0],
        relockOperation,
        "Reuse the operation ID with a different relock summary.",
        dependencyHash,
        JSON.stringify(relockItems)
      ]
    ),
    /operation ID belongs to another request/i,
    "a relock operation UUID must reject a different payload"
  );

  const revisions = await db.query(
    `select id,revision,revision_source,supersedes_publication_id,mapping_relock_id,
      snapshot #>> '{item,provider_member_ids,0}' as provider_member_id
     from public.workforce_payout_publications
     where company_id=$1 and workforce_id=$2 and station_id=$3
       and period_start=$4 and period_end=$5
     order by revision`,
    [company, workforce, station, periodStart, periodEnd]
  );
  assert.equal(revisions.rows.length, 2);
  assert.deepEqual(
    revisions.rows.map((row) => row.revision),
    [1, 2],
    "relock must append an N+1 revision"
  );
  assert.equal(revisions.rows[0].provider_member_id, "OLD-ID");
  assert.equal(revisions.rows[1].provider_member_id, "NEW-ID");
  assert.equal(revisions.rows[1].revision_source, "mapping_relock");
  assert.equal(revisions.rows[1].supersedes_publication_id, publication);
  assert.equal(revisions.rows[1].mapping_relock_id, relockOperation);

  await assert.rejects(
    db.query(
      `update public.field_executive_provider_mappings
       set provider_member_id='BLOCKED-AGAIN' where id=$1`,
      [mapping]
    ),
    /published to DropX One/i,
    "the replacement publication must immediately relock the mapping"
  );

  const replacementStation = randomUUID();
  await db.query(
    `insert into public.stations(id,company_id,station_code) values ($1,$2,'STN-NEW')`,
    [replacementStation, company]
  );
  const stationMoveWorkforce = randomUUID();
  const stationMoveReview = randomUUID();
  const stationMovePublication = randomUUID();
  const stationMoveMapping = randomUUID();
  await seedPublishedPayout({
    workforceId: stationMoveWorkforce,
    reviewId: stationMoveReview,
    publicationId: stationMovePublication,
    mappingId: stationMoveMapping,
    memberId: "STATION-MOVE-ID"
  });

  const stationMoveUnlock = (
    await db.query(
      `select public.workforce_unlock_payout_mappings(
        $1,$2,$3,$4,array[$5]::uuid[],$6,$7
      ) as result`,
      [
        company,
        actor,
        periodStart,
        periodEnd,
        stationMoveWorkforce,
        randomUUID(),
        "Move the published payout mapping to its corrected station."
      ]
    )
  ).rows[0].result;
  await db.query(
    `update public.field_executive_provider_mappings
     set station_id=$2,updated_at=clock_timestamp() where id=$1`,
    [stationMoveMapping, replacementStation]
  );

  const stationMoveRelockOperation = randomUUID();
  const stationMoveSnapshot = publicationSnapshot(
    stationMoveWorkforce,
    replacementStation,
    "STATION-MOVE-ID"
  );
  const stationMoveRelock = (
    await db.query(
      `select public.workforce_relock_payout_mappings(
        $1,$2,$3,$4,array[$5]::uuid[],$6,$7,$8,$9::jsonb
      ) as result`,
      [
        company,
        actor,
        periodStart,
        periodEnd,
        stationMoveUnlock.unlock_ids[0],
        stationMoveRelockOperation,
        "Relock the payout after correcting its active station.",
        dependencyHash,
        JSON.stringify([{
          workforce_id: stationMoveWorkforce,
          station_id: replacementStation,
          snapshot: stationMoveSnapshot,
          snapshot_hash: "d".repeat(64)
        }])
      ]
    )
  ).rows[0].result;
  assert.equal(stationMoveRelock.published, 1);

  await assert.rejects(
    db.query(
      `insert into public.workforce_payout_disputes(
        company_id,publication_id,workforce_id,station_id,category,reason
      ) values ($1,$2,$3,$4,'other',$5)`,
      [
        company,
        stationMovePublication,
        stationMoveWorkforce,
        station,
        "Attempt a dispute against the station replaced by the mapping relock."
      ]
    ),
    /replaced by an ID mapping correction/i,
    "a completed relock must block disputes against a station removed from its active manifest"
  );

  const transferSourceWorkforce = randomUUID();
  const transferTargetWorkforce = randomUUID();
  const transferSourceMapping = randomUUID();
  const transferSourceReview = randomUUID();
  const transferTargetReview = randomUUID();
  const transferSourcePublication = randomUUID();
  const transferTargetPublication = randomUUID();
  await seedPublishedPayout({
    workforceId: transferSourceWorkforce,
    reviewId: transferSourceReview,
    publicationId: transferSourcePublication,
    mappingId: transferSourceMapping,
    memberId: "TRANSFERRED-PROVIDER-ID"
  });
  await seedPublishedPayout({
    workforceId: transferTargetWorkforce,
    reviewId: transferTargetReview,
    publicationId: transferTargetPublication,
    mappingId: randomUUID(),
    memberId: "TARGET-EXISTING-ID"
  });
  const transferUnlock = (
    await db.query(
      `select public.workforce_unlock_payout_mappings(
        $1,$2,$3,$4,array[$5]::uuid[],$6,$7
      ) as result`,
      [
        company,
        actor,
        periodStart,
        periodEnd,
        transferSourceWorkforce,
        randomUUID(),
        "Transfer the published provider ID to the correct existing Workforce profile."
      ]
    )
  ).rows[0].result;
  await db.query(
    `update public.field_executive_provider_mappings
     set workforce_id=$2,updated_at=clock_timestamp() where id=$1`,
    [transferSourceMapping, transferTargetWorkforce]
  );

  await db.query(
    `update public.workforce_payout_publications
     set notification_status='sending',notification_attempted_at=clock_timestamp()
     where id=$1`,
    [transferTargetPublication]
  );
  await assert.rejects(
    db.query(
      `update public.field_executive_provider_mappings
       set provider_member_id='TRANSFER-WHILE-SENDING',updated_at=clock_timestamp()
       where id=$1`,
      [transferSourceMapping]
    ),
    /notification is currently sending/i,
    "a notification claimed before an owner transfer must block the mapping write"
  );
  await db.query(
    `update public.workforce_payout_publications
     set notification_status='pending',notification_attempted_at=null
     where id=$1`,
    [transferTargetPublication]
  );
  const blockedClaim = await db.query(
    `select public.workforce_claim_payout_review_notification($1,clock_timestamp()) as id`,
    [transferTargetPublication]
  );
  assert.equal(blockedClaim.rows[0].id, null, "an affected new owner cannot send a stale payout notification while the correction is open");

  await assert.rejects(
    db.query(
      `update public.workforce_payout_review_submissions set status='approved' where id=$1`,
      [transferTargetReview]
    ),
    /relock this payout mapping correction/i,
    "review finality cannot overtake an open mapping correction"
  );

  await assert.rejects(
    db.query(
      `insert into public.workforce_payout_publication_refresh_jobs(
        id,company_id,workforce_id,station_id,period_start,period_end,status
      ) values ($1,$2,$3,$4,$5,$6,'pending')`,
      [randomUUID(), company, transferTargetWorkforce, station, periodStart, periodEnd]
    ),
    /relock this payout mapping correction/i,
    "a payout input refresh cannot be enqueued during an open mapping correction"
  );

  const openPayrollRun = randomUUID();
  await db.query(
    `insert into public.workforce_payroll_runs(id,company_id,status,period_start,period_end)
     values ($1,$2,'draft',$3,$4)`,
    [openPayrollRun, company, "2026-09-15", periodEnd]
  );
  await db.query(
    `insert into public.workforce_payroll_items(
      id,company_id,payroll_run_id,workforce_id,station_id,status
    ) values ($1,$2,$3,$4,$5,'ready')`,
    [randomUUID(), company, openPayrollRun, transferTargetWorkforce, station]
  );
  await assert.rejects(
    db.query(`update public.workforce_payroll_runs set status='approved' where id=$1`, [openPayrollRun]),
    /relock every open payout mapping correction/i,
    "a partially overlapping payroll cannot overtake an open mapping correction"
  );

  const bypassPayrollRun = randomUUID();
  await db.query(
    `insert into public.workforce_payroll_runs(id,company_id,status,period_start,period_end)
     values ($1,$2,'draft',$3,$4)`,
    [bypassPayrollRun, company, "2026-08-15", "2026-10-15"]
  );
  await db.query(
    `insert into public.workforce_payroll_items(
      id,company_id,payroll_run_id,workforce_id,station_id,status
    ) values ($1,$2,$3,$4,$5,'ready')`,
    [randomUUID(), company, bypassPayrollRun, transferTargetWorkforce, station]
  );
  // Fault-inject a finalized run that bypassed the transition gate so the
  // relock RPC's independent financial-finality recheck remains covered.
  await db.exec(
    "alter table public.workforce_payroll_runs disable trigger workforce_01_mapping_unlock_payroll_gate"
  );
  await db.query(
    `update public.workforce_payroll_runs set status='approved' where id=$1`,
    [bypassPayrollRun]
  );
  await db.exec(
    "alter table public.workforce_payroll_runs enable trigger workforce_01_mapping_unlock_payroll_gate"
  );
  await assert.rejects(
    db.query(
      `select public.workforce_relock_payout_mappings(
        $1,$2,$3,$4,array[$5]::uuid[],$6,$7,$8,'[]'::jsonb
      )`,
      [
        company,
        actor,
        periodStart,
        periodEnd,
        transferUnlock.unlock_ids[0],
        randomUUID(),
        "Attempt relock after payroll became approved.",
        dependencyHash
      ]
    ),
    /approved or paid Workforce payroll cannot be replaced/i,
    "relock defensively rechecks a finalized payroll spanning the correction month"
  );
  const sourceRevisionState = await db.query(
    `select * from public.workforce_payout_mapping_revision_state($1,$2)`,
    [company, transferSourceWorkforce]
  );
  const targetRevisionState = await db.query(
    `select * from public.workforce_payout_mapping_revision_state($1,$2)`,
    [company, transferTargetWorkforce]
  );
  assert.equal(sourceRevisionState.rows.length, 1);
  assert.equal(sourceRevisionState.rows[0].revision_pending, true);
  assert.equal(targetRevisionState.rows.length, 1);
  assert.equal(
    targetRevisionState.rows[0].revision_pending,
    true,
    "an existing Workforce profile that becomes the current mapping owner must also see the payout as revising"
  );
  assert.equal(targetRevisionState.rows[0].active_station_ids, null);

  await db.query(
    `update public.workforce_payout_review_submissions set status='approved' where id=$1`,
    [review]
  );
  await assert.rejects(
    db.query(
      `select public.workforce_unlock_payout_mappings(
        $1,$2,$3,$4,array[$5]::uuid[],$6,$7
      )`,
      [
        company,
        actor,
        periodStart,
        periodEnd,
        workforce,
        randomUUID(),
        "Attempt to reopen an approved payout review."
      ]
    ),
    /approved or cancelled payout review cannot be unlocked/i
  );

  const paidWorkforce = randomUUID();
  const paidReview = randomUUID();
  const paidPublication = randomUUID();
  const paidMapping = randomUUID();
  await seedPublishedPayout({
    workforceId: paidWorkforce,
    reviewId: paidReview,
    publicationId: paidPublication,
    mappingId: paidMapping,
    memberId: "PAID-ID"
  });
  const paidRun = randomUUID();
  await db.query(
    `insert into public.workforce_payroll_runs(
      id,company_id,status,period_start,period_end
    ) values ($1,$2,'draft',$3,$4)`,
    [paidRun, company, periodStart, periodEnd]
  );
  await db.query(
    `insert into public.workforce_payroll_items(
      id,company_id,payroll_run_id,workforce_id,station_id,status
    ) values ($1,$2,$3,$4,$5,'ready')`,
    [randomUUID(), company, paidRun, paidWorkforce, station]
  );
  await db.query(
    `update public.workforce_payroll_runs set status='paid' where id=$1`,
    [paidRun]
  );
  await assert.rejects(
    db.query(
      `select public.workforce_unlock_payout_mappings(
        $1,$2,$3,$4,array[$5]::uuid[],$6,$7
      )`,
      [
        company,
        actor,
        periodStart,
        periodEnd,
        paidWorkforce,
        randomUUID(),
        "Attempt to reopen a financially paid payout period."
      ]
    ),
    /approved or paid Workforce payroll period cannot be unlocked/i
  );

  console.log("Workforce payout mapping unlock/relock migration verification passed.");
} finally {
  await db.close();
}
