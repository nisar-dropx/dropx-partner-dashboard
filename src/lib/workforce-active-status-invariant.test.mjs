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
