import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const independenceMigrationUrl = new URL(
  "../../supabase/migrations/20261015183000_workforce_registration_status_independence.sql",
  import.meta.url
);
const evidenceRepairMigrationUrl = new URL(
  "../../supabase/migrations/20261015190000_workforce_registration_evidence_repair.sql",
  import.meta.url
);
const defaultFieldRepairMigrationUrl = new URL(
  "../../supabase/migrations/20261015212000_workforce_default_field_registration_repair.sql",
  import.meta.url
);
const returnedOperationalRepairMigrationUrl = new URL(
  "../../supabase/migrations/20261017190000_repair_returned_workforce_operational_status.sql",
  import.meta.url
);

async function fixture() {
  const db = new PGlite();
  await db.exec(`
    create table public.workforce (
      id text primary key,
      company_id text not null default 'company',
      source_profile_type text not null default 'canonical',
      source_profile_id text,
      migration_state text not null default 'canonical',
      onboarding_status text,
      lifecycle_status text,
      is_active boolean not null default false,
      approval_required boolean,
      is_handicapped boolean,
      onboarding_submitted_at timestamptz,
      onboarding_reviewed_at timestamptz,
      onboarding_approved_at timestamptz,
      onboarding_activated_at timestamptz,
      deleted_at timestamptz,
      deactivated_at timestamptz,
      last_working_date date,
      updated_at timestamptz not null default now()
    );
    create function workforce_identity_default() returns trigger language plpgsql as $$
    begin
      if new.source_profile_id is null then new.source_profile_id := new.id; end if;
      return new;
    end $$;
    create trigger workforce_identity_default before insert on public.workforce
      for each row execute function workforce_identity_default();
    create table public.workforce_onboarding_events (
      id bigint generated always as identity primary key,
      company_id text,
      field_executive_id text,
      workforce_id text,
      event_code text,
      from_status text,
      to_status text,
      source_portal text,
      remarks text,
      metadata jsonb not null default '{}'::jsonb
    );
    create table public.mob_app_notifications (
      id bigint generated always as identity primary key,
      company_id text not null default 'company',
      recipient_profile_type text not null default 'workforce',
      recipient_account_id text,
      event_code text
    );

    insert into public.workforce (
      id, onboarding_status, lifecycle_status, is_active,
      approval_required, is_handicapped
    ) values
      ('bulk-unsubmitted', 'active', 'active', true, true, null),
      ('bulk-enabled-pending', 'pending', 'onboarding', true, true, null),
      ('submitted-notification', 'active', 'active', true, true, null),
      ('submitted-profile-field', 'active', 'active', true, true, false),
      ('submitted-event', 'active', 'active', true, true, null),
      ('legacy-no-request', 'active', 'active', true, true, null),
      ('manual-review', 'under_review', 'onboarding', true, true, false),
      ('returned', 'returned', 'onboarding', true, true, false),
      ('approved', 'approved', 'onboarding', true, true, false),
      ('ordinary-active', 'active', 'active', true, false, false);

    insert into public.workforce (
      id, source_profile_type, source_profile_id, migration_state,
      onboarding_status, lifecycle_status, is_active,
      approval_required, is_handicapped
    ) values
      (
        'mirrored-contractor-unsubmitted', 'contractor', 'contractor-unsubmitted', 'mirrored',
        'active', 'active', true, true, null
      ),
      (
        'mirrored-contractor-submitted', 'contractor', 'contractor-submitted', 'mirrored',
        'active', 'active', true, true, null
      ),
      (
        'mirrored-contractor-later-update', 'contractor', 'contractor-later-update', 'mirrored',
        'active', 'active', true, true, null
      );

    update public.workforce
    set updated_at = timestamptz '2026-10-15 09:11:26.5+00'
    where id in ('mirrored-contractor-unsubmitted', 'mirrored-contractor-submitted');

    insert into public.workforce_onboarding_events (
      company_id, workforce_id, event_code, to_status, source_portal
    ) values
      ('company', 'bulk-unsubmitted', 'onboarding_requested', 'pending', 'dashboard'),
      ('company', 'bulk-enabled-pending', 'onboarding_requested', 'pending', 'dashboard'),
      ('company', 'submitted-notification', 'onboarding_requested', 'pending', 'dashboard'),
      ('company', 'submitted-profile-field', 'onboarding_requested', 'pending', 'dashboard'),
      ('company', 'submitted-event', 'onboarding_requested', 'pending', 'dashboard'),
      ('company', 'submitted-event', 'candidate_submitted', 'active', 'connect');
    insert into public.mob_app_notifications (recipient_account_id, event_code)
      values ('submitted-notification', 'profile_submitted');
    insert into public.mob_app_notifications (
      recipient_profile_type, recipient_account_id, event_code
    ) values ('contractor', 'contractor-submitted', 'profile_submitted');
  `);
  await db.exec(await readFile(independenceMigrationUrl, "utf8"));
  await db.exec(await readFile(evidenceRepairMigrationUrl, "utf8"));
  await db.exec(await readFile(defaultFieldRepairMigrationUrl, "utf8"));
  return db;
}

async function returnedOperationalRepairFixture() {
  const db = await fixture();
  await db.exec(`
    create table public.request_tracker_events (
      id text primary key,
      company_id text not null,
      kind text not null,
      source_id text not null,
      source_table text not null,
      source_row_id text,
      operation text not null,
      executor text not null default 'service_role',
      before_data jsonb,
      after_data jsonb,
      changed_fields text[] not null,
      recorded_at timestamptz not null,
      transaction_id bigint not null
    );

    insert into public.workforce (
      id, onboarding_status, lifecycle_status, is_active,
      approval_required, is_handicapped, deactivated_at
    ) values
      ('return-bug', 'returned', 'onboarding', false, true, false, null),
      ('rereturn-bug', 'returned', 'onboarding', false, true, false, null),
      ('legacy-return-bug', 'returned', 'onboarding', false, true, false, null),
      ('legacy-lookalike', 'returned', 'onboarding', false, true, false, null),
      ('legacy-wrong-executor', 'returned', 'onboarding', false, true, false, null),
      ('return-bug-later-note', 'returned', 'onboarding', false, true, false, null),
      ('initially-inactive-return', 'returned', 'onboarding', false, true, false, null),
      ('later-manual-status-change', 'returned', 'onboarding', false, true, false, null),
      ('currently-rejected', 'rejected', 'onboarding', false, true, false, null),
      ('currently-exited', 'returned', 'exited', false, true, false, null),
      (
        'currently-deactivated', 'returned', 'onboarding', false, true, false,
        timestamptz '2026-10-17 14:00:00+00'
      ),
      ('returned-without-audit', 'returned', 'onboarding', false, true, false, null);

    update public.workforce
    set company_id = '43866344-b550-4e8a-9a2d-9d23f3d8a997'
    where id in ('legacy-return-bug', 'legacy-lookalike', 'legacy-wrong-executor');

    insert into public.workforce (
      id, onboarding_status, lifecycle_status, is_active,
      approval_required, is_handicapped, last_working_date
    ) values (
      'currently-last-working', 'returned', 'onboarding', false,
      true, false, date '2026-10-17'
    );

    insert into public.request_tracker_events (
      id, company_id, kind, source_id, source_table, source_row_id,
      operation, before_data, after_data, changed_fields,
      recorded_at, transaction_id
    ) values
      (
        'audit-return-bug', 'company', 'workforce_onboarding', 'return-bug', 'workforce', 'return-bug',
        'update',
        '{"onboarding_status":"under_review","lifecycle_status":"onboarding","is_active":true}'::jsonb,
        '{"onboarding_status":"returned","lifecycle_status":"onboarding","is_active":false,"profile_returned_at":"2026-10-17T11:00:00Z"}'::jsonb,
        array['is_active','onboarding_status','profile_returned_at','updated_at'],
        timestamptz '2026-10-17 11:00:00+00', 101
      ),
      (
        'audit-rereturn-bug', 'company', 'workforce_onboarding', 'rereturn-bug', 'workforce', 'rereturn-bug',
        'update',
        '{"onboarding_status":"returned","lifecycle_status":"onboarding","is_active":true,"profile_returned_at":"2026-10-16T11:00:00Z"}'::jsonb,
        '{"onboarding_status":"returned","lifecycle_status":"onboarding","is_active":false,"profile_returned_at":"2026-10-17T11:00:30Z"}'::jsonb,
        array['is_active','profile_returned_at','updated_at'],
        timestamptz '2026-10-17 11:00:30+00', 111
      ),
      (
        'audit-return-later-note', 'company', 'workforce_onboarding', 'return-bug-later-note', 'workforce', 'return-bug-later-note',
        'update',
        '{"onboarding_status":"under_review","lifecycle_status":"onboarding","is_active":true}'::jsonb,
        '{"onboarding_status":"returned","lifecycle_status":"onboarding","is_active":false,"profile_returned_at":"2026-10-17T11:01:00Z"}'::jsonb,
        array['is_active','onboarding_status','profile_returned_at','updated_at'],
        timestamptz '2026-10-17 11:01:00+00', 102
      ),
      (
        'audit-later-note', 'company', 'workforce_onboarding', 'return-bug-later-note', 'workforce', 'return-bug-later-note',
        'update',
        '{"onboarding_status":"returned","lifecycle_status":"onboarding","is_active":false,"profile_return_remarks":"Old"}'::jsonb,
        '{"onboarding_status":"returned","lifecycle_status":"onboarding","is_active":false,"profile_return_remarks":"Correct ID"}'::jsonb,
        array['profile_return_remarks','updated_at'],
        timestamptz '2026-10-17 11:02:00+00', 103
      ),
      (
        'audit-initially-inactive', 'company', 'workforce_onboarding', 'initially-inactive-return', 'workforce', 'initially-inactive-return',
        'update',
        '{"onboarding_status":"under_review","lifecycle_status":"onboarding","is_active":false}'::jsonb,
        '{"onboarding_status":"returned","lifecycle_status":"onboarding","is_active":false,"profile_returned_at":"2026-10-17T11:03:00Z"}'::jsonb,
        array['onboarding_status','profile_returned_at','updated_at'],
        timestamptz '2026-10-17 11:03:00+00', 104
      ),
      (
        'audit-return-before-manual', 'company', 'workforce_onboarding', 'later-manual-status-change', 'workforce', 'later-manual-status-change',
        'update',
        '{"onboarding_status":"under_review","lifecycle_status":"onboarding","is_active":true}'::jsonb,
        '{"onboarding_status":"returned","lifecycle_status":"onboarding","is_active":false,"profile_returned_at":"2026-10-17T11:04:00Z"}'::jsonb,
        array['is_active','onboarding_status','profile_returned_at','updated_at'],
        timestamptz '2026-10-17 11:04:00+00', 105
      ),
      (
        'audit-manual-reactivation', 'company', 'workforce_onboarding', 'later-manual-status-change', 'workforce', 'later-manual-status-change',
        'update',
        '{"onboarding_status":"returned","lifecycle_status":"onboarding","is_active":false}'::jsonb,
        '{"onboarding_status":"returned","lifecycle_status":"onboarding","is_active":true}'::jsonb,
        array['is_active','updated_at'],
        timestamptz '2026-10-17 11:05:00+00', 106
      ),
      (
        'audit-manual-deactivation', 'company', 'workforce_onboarding', 'later-manual-status-change', 'workforce', 'later-manual-status-change',
        'update',
        '{"onboarding_status":"returned","lifecycle_status":"onboarding","is_active":true}'::jsonb,
        '{"onboarding_status":"returned","lifecycle_status":"onboarding","is_active":false}'::jsonb,
        array['is_active','updated_at'],
        timestamptz '2026-10-17 11:06:00+00', 107
      ),
      (
        'audit-before-rejected', 'company', 'workforce_onboarding', 'currently-rejected', 'workforce', 'currently-rejected',
        'update',
        '{"onboarding_status":"under_review","lifecycle_status":"onboarding","is_active":true}'::jsonb,
        '{"onboarding_status":"returned","lifecycle_status":"onboarding","is_active":false,"profile_returned_at":"2026-10-17T11:07:00Z"}'::jsonb,
        array['is_active','onboarding_status','profile_returned_at','updated_at'],
        timestamptz '2026-10-17 11:07:00+00', 108
      ),
      (
        'audit-before-exit', 'company', 'workforce_onboarding', 'currently-exited', 'workforce', 'currently-exited',
        'update',
        '{"onboarding_status":"under_review","lifecycle_status":"onboarding","is_active":true}'::jsonb,
        '{"onboarding_status":"returned","lifecycle_status":"onboarding","is_active":false,"profile_returned_at":"2026-10-17T11:08:00Z"}'::jsonb,
        array['is_active','onboarding_status','profile_returned_at','updated_at'],
        timestamptz '2026-10-17 11:08:00+00', 109
      ),
      (
        'audit-before-deactivation', 'company', 'workforce_onboarding', 'currently-deactivated', 'workforce', 'currently-deactivated',
        'update',
        '{"onboarding_status":"under_review","lifecycle_status":"onboarding","is_active":true}'::jsonb,
        '{"onboarding_status":"returned","lifecycle_status":"onboarding","is_active":false,"profile_returned_at":"2026-10-17T11:09:00Z"}'::jsonb,
        array['is_active','onboarding_status','profile_returned_at','updated_at'],
        timestamptz '2026-10-17 11:09:00+00', 110
      );

    insert into public.request_tracker_events (
      id, company_id, kind, source_id, source_table, source_row_id,
      operation, executor, before_data, after_data, changed_fields,
      recorded_at, transaction_id
    ) values
      (
        '6a5c1edc-81d1-4263-b019-1913b7bf2cb3', '43866344-b550-4e8a-9a2d-9d23f3d8a997',
        'workforce_onboarding', 'legacy-return-bug', 'workforce', 'legacy-return-bug',
        'update', 'postgres',
        '{"onboarding_status":"returned","lifecycle_status":"onboarding","is_active":true}'::jsonb,
        '{"onboarding_status":"returned","lifecycle_status":"onboarding","is_active":false}'::jsonb,
        array['is_active','updated_at'],
        timestamptz '2026-10-15 15:00:00+00', 18788344
      ),
      (
        '10a5f7b0-bc9f-4053-b76f-870e2ec54a55', '43866344-b550-4e8a-9a2d-9d23f3d8a997',
        'workforce_onboarding', 'legacy-lookalike', 'workforce', 'legacy-lookalike',
        'update', 'postgres',
        '{"onboarding_status":"returned","lifecycle_status":"onboarding","is_active":true}'::jsonb,
        '{"onboarding_status":"returned","lifecycle_status":"onboarding","is_active":false}'::jsonb,
        array['is_active','updated_at'],
        timestamptz '2026-10-15 15:01:00+00', 18788345
      ),
      (
        '9d4e0541-17bf-4be5-b309-28bf33fc9cbc', '43866344-b550-4e8a-9a2d-9d23f3d8a997',
        'workforce_onboarding', 'legacy-wrong-executor', 'workforce', 'legacy-wrong-executor',
        'update', 'service_role',
        '{"onboarding_status":"returned","lifecycle_status":"onboarding","is_active":true}'::jsonb,
        '{"onboarding_status":"returned","lifecycle_status":"onboarding","is_active":false}'::jsonb,
        array['is_active','updated_at'],
        timestamptz '2026-10-15 15:02:00+00', 18788344
      ),
      (
        'audit-before-last-working', 'company', 'workforce_onboarding', 'currently-last-working', 'workforce', 'currently-last-working',
        'update', 'service_role',
        '{"onboarding_status":"under_review","lifecycle_status":"onboarding","is_active":true}'::jsonb,
        '{"onboarding_status":"returned","lifecycle_status":"onboarding","is_active":false,"profile_returned_at":"2026-10-17T11:10:00Z"}'::jsonb,
        array['is_active','onboarding_status','profile_returned_at','updated_at'],
        timestamptz '2026-10-17 11:10:00+00', 112
      );
  `);
  return db;
}

test("repair restores approval-managed canonical and mirrored profiles without submission evidence", async (t) => {
  const db = await fixture();
  t.after(() => db.close());

  const { rows } = await db.query(`
    select id, onboarding_status, lifecycle_status, is_active
    from public.workforce
    order by id
  `);
  const byId = new Map(rows.map((row) => [row.id, row]));

  assert.deepEqual(byId.get("bulk-unsubmitted"), {
    id: "bulk-unsubmitted",
    onboarding_status: "pending",
    lifecycle_status: "onboarding",
    is_active: true
  });
  assert.deepEqual(byId.get("bulk-enabled-pending"), {
    id: "bulk-enabled-pending",
    onboarding_status: "pending",
    lifecycle_status: "onboarding",
    is_active: true
  });
  for (const id of [
    "mirrored-contractor-unsubmitted",
    "mirrored-contractor-later-update",
    "submitted-profile-field"
  ]) {
    assert.equal(byId.get(id)?.onboarding_status, "pending", `${id} must return to Pending`);
    assert.equal(byId.get(id)?.lifecycle_status, "onboarding", `${id} must return to onboarding`);
    assert.equal(byId.get(id)?.is_active, true, `${id} must remain operationally enabled`);
  }
  for (const id of [
    "legacy-no-request",
    "submitted-notification",
    "submitted-event",
    "mirrored-contractor-submitted",
    "ordinary-active"
  ]) {
    assert.equal(byId.get(id)?.onboarding_status, "active", `${id} must remain Active`);
    assert.equal(byId.get(id)?.lifecycle_status, "active", `${id} lifecycle must remain Active`);
    assert.equal(byId.get(id)?.is_active, true, `${id} must remain enabled`);
  }

  const repairEvents = await db.query(`
    select workforce_id, event_code, metadata ->> 'previous_onboarding_status' as previous_status
    from public.workforce_onboarding_events
    where event_code = 'registration_status_repaired'
  `);
  assert.deepEqual(repairEvents.rows.map((row) => row.workforce_id).sort(), [
    "bulk-unsubmitted",
    "mirrored-contractor-later-update",
    "mirrored-contractor-unsubmitted",
    "submitted-profile-field"
  ]);
  assert.ok(repairEvents.rows.every((row) => row.event_code === "registration_status_repaired"));
  assert.ok(repairEvents.rows.every((row) => row.previous_status === "active"));

  const evidenceRepairAudit = await db.query(`
    select
      workforce_id,
      metadata ->> 'source_profile_type' as source_profile_type,
      (metadata ->> 'previous_is_active')::boolean as previous_is_active
    from public.workforce_onboarding_events
    where event_code = 'registration_status_repaired'
      and metadata ->> 'repair_migration' =
        '20261015190000_workforce_registration_evidence_repair'
    order by workforce_id
  `);
  assert.deepEqual(evidenceRepairAudit.rows, [
    { workforce_id: "mirrored-contractor-later-update", source_profile_type: "contractor", previous_is_active: true },
    { workforce_id: "mirrored-contractor-unsubmitted", source_profile_type: "contractor", previous_is_active: true }
  ]);
});

test("evidence repair is idempotent for canonical and mirrored profiles", async (t) => {
  const db = await fixture();
  t.after(() => db.close());

  await db.exec(await readFile(evidenceRepairMigrationUrl, "utf8"));
  await db.exec(await readFile(defaultFieldRepairMigrationUrl, "utf8"));

  const repairs = await db.query(`
    select workforce_id, count(*)::integer as repair_count
    from public.workforce_onboarding_events
    where event_code = 'registration_status_repaired'
    group by workforce_id
    order by workforce_id
  `);
  assert.deepEqual(repairs.rows, [
    { workforce_id: "bulk-unsubmitted", repair_count: 1 },
    { workforce_id: "mirrored-contractor-later-update", repair_count: 1 },
    { workforce_id: "mirrored-contractor-unsubmitted", repair_count: 1 },
    { workforce_id: "submitted-profile-field", repair_count: 1 }
  ]);
});

test("returned-profile repair restores only audit-proven operational deactivations and is idempotent", async (t) => {
  const db = await returnedOperationalRepairFixture();
  t.after(() => db.close());
  const migration = await readFile(returnedOperationalRepairMigrationUrl, "utf8");

  await db.exec(migration);

  const { rows } = await db.query(`
    select id, onboarding_status, lifecycle_status, is_active, deactivated_at, last_working_date
    from public.workforce
    where id in (
      'return-bug',
      'rereturn-bug',
      'legacy-return-bug',
      'legacy-lookalike',
      'legacy-wrong-executor',
      'return-bug-later-note',
      'initially-inactive-return',
      'later-manual-status-change',
      'currently-rejected',
      'currently-exited',
      'currently-deactivated',
      'currently-last-working',
      'returned-without-audit'
    )
    order by id
  `);
  const byId = new Map(rows.map((row) => [row.id, row]));

  assert.equal(byId.get("return-bug")?.is_active, true);
  assert.equal(byId.get("rereturn-bug")?.is_active, true);
  assert.equal(byId.get("legacy-return-bug")?.is_active, true);
  assert.equal(byId.get("return-bug-later-note")?.is_active, true);
  for (const id of [
    "legacy-lookalike",
    "legacy-wrong-executor",
    "initially-inactive-return",
    "later-manual-status-change",
    "currently-rejected",
    "currently-exited",
    "currently-deactivated",
    "currently-last-working",
    "returned-without-audit"
  ]) {
    assert.equal(byId.get(id)?.is_active, false, `${id} must remain inactive`);
  }
  assert.equal(byId.get("currently-rejected")?.onboarding_status, "rejected");
  assert.equal(byId.get("currently-exited")?.lifecycle_status, "exited");
  assert.ok(byId.get("currently-deactivated")?.deactivated_at);
  assert.ok(byId.get("currently-last-working")?.last_working_date);

  const repairs = await db.query(`
    select
      workforce_id,
      event_code,
      metadata ->> 'return_audit_event_id' as return_audit_event_id,
      metadata ->> 'repair_migration' as repair_migration
    from public.workforce_onboarding_events
    where event_code = 'returned_operational_status_repaired'
    order by workforce_id
  `);
  assert.deepEqual(repairs.rows, [
    {
      workforce_id: "legacy-return-bug",
      event_code: "returned_operational_status_repaired",
      return_audit_event_id: "6a5c1edc-81d1-4263-b019-1913b7bf2cb3",
      repair_migration: "20261017190000_repair_returned_workforce_operational_status"
    },
    {
      workforce_id: "rereturn-bug",
      event_code: "returned_operational_status_repaired",
      return_audit_event_id: "audit-rereturn-bug",
      repair_migration: "20261017190000_repair_returned_workforce_operational_status"
    },
    {
      workforce_id: "return-bug",
      event_code: "returned_operational_status_repaired",
      return_audit_event_id: "audit-return-bug",
      repair_migration: "20261017190000_repair_returned_workforce_operational_status"
    },
    {
      workforce_id: "return-bug-later-note",
      event_code: "returned_operational_status_repaired",
      return_audit_event_id: "audit-return-later-note",
      repair_migration: "20261017190000_repair_returned_workforce_operational_status"
    }
  ]);

  await db.exec(migration);
  const afterSecondRun = await db.query(`
    select workforce_id, count(*)::integer as repair_count
    from public.workforce_onboarding_events
    where event_code = 'returned_operational_status_repaired'
    group by workforce_id
    order by workforce_id
  `);
  assert.deepEqual(afterSecondRun.rows, [
    { workforce_id: "legacy-return-bug", repair_count: 1 },
    { workforce_id: "rereturn-bug", repair_count: 1 },
    { workforce_id: "return-bug", repair_count: 1 },
    { workforce_id: "return-bug-later-note", repair_count: 1 }
  ]);
});

test("database keeps enabled and nonterminal registration states independent", async (t) => {
  const db = await fixture();
  t.after(() => db.close());

  for (const [id, onboarding] of [
    ["new-pending", "pending"],
    ["new-review", "under_review"],
    ["new-returned", "returned"],
    ["new-approved", "approved"]
  ]) {
    await db.exec(`insert into public.workforce (
      id, onboarding_status, lifecycle_status, is_active
    ) values ('${id}', '${onboarding}', 'onboarding', true)`);
    const result = await db.query(`
      select onboarding_status, lifecycle_status, is_active
      from public.workforce where id = '${id}'
    `);
    assert.deepEqual(result.rows[0], {
      onboarding_status: onboarding,
      lifecycle_status: "onboarding",
      is_active: true
    });
  }

  for (const [id, onboarding, lifecycle] of [
    ["invalid-rejected", "rejected", "onboarding"],
    ["invalid-cancelled", "cancelled", "onboarding"],
    ["invalid-exited", "active", "exited"]
  ]) {
    await assert.rejects(
      db.exec(`insert into public.workforce (
        id, onboarding_status, lifecycle_status, is_active
      ) values ('${id}', '${onboarding}', '${lifecycle}', true)`),
      /Enabled Workforce profiles must not be rejected, cancelled, archived or exited/
    );
  }

  await db.exec(`update public.workforce
    set lifecycle_status = 'settlement_pending'
    where id = 'ordinary-active'`);
  await db.exec(`update public.workforce
    set lifecycle_status = 'settled', is_active = false
    where id = 'ordinary-active'`);
  const terminal = await db.query(`
    select lifecycle_status, is_active
    from public.workforce where id = 'ordinary-active'
  `);
  assert.deepEqual(terminal.rows[0], { lifecycle_status: "settled", is_active: false });
});

test("database refuses approval-managed Active status without registration evidence", async (t) => {
  const db = await fixture();
  t.after(() => db.close());

  await assert.rejects(
    db.exec(`insert into public.workforce (
      id, onboarding_status, lifecycle_status, is_active, approval_required
    ) values ('invalid-active-without-submission', 'active', 'active', true, true)`),
    /Active Workforce registration requires completed registration evidence/
  );

  await db.exec(`insert into public.workforce (
    id, onboarding_status, lifecycle_status, is_active, approval_required,
    onboarding_submitted_at
  ) values (
    'active-with-submission', 'active', 'active', true, true,
    timestamptz '2026-10-15 12:00:00+00'
  )`);
  const active = await db.query(`
    select onboarding_status, lifecycle_status, is_active
    from public.workforce where id = 'active-with-submission'
  `);
  assert.deepEqual(active.rows[0], {
    onboarding_status: "active",
    lifecycle_status: "active",
    is_active: true
  });
});
