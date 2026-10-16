import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migration = await readFile(new URL("../../../supabase/migrations/20261015190000_report_bot.sql", import.meta.url), "utf8");
const geminiDefault = await readFile(new URL("../../../supabase/migrations/20261016100000_report_bot_gemini_default.sql", import.meta.url), "utf8");
const COMPANY_A = "aaaaaaaa-0000-0000-0000-000000000001";
const COMPANY_B = "bbbbbbbb-0000-0000-0000-000000000002";

async function setup() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.stations (id uuid primary key, company_id uuid);
  `);
  await db.exec(migration);
  await db.exec(geminiDefault);
  return db;
}

test("existing rows on the old untouched default move to free Gemini; deliberate choices stay", async () => {
  const db = new PGlite();
  try {
    await db.exec("create role anon; create role authenticated; create role service_role; create table public.stations (id uuid primary key, company_id uuid);");
    await db.exec(migration);
    await db.query("insert into public.report_bot_settings (company_id) values ($1)", [COMPANY_A]);
    await db.query("insert into public.report_bot_settings (company_id, ai_provider, ai_model) values ($1, 'openai', 'gpt-4o-mini')", [COMPANY_B]);
    await db.exec(geminiDefault);
    const rows = (await db.query("select company_id, ai_provider, ai_model from public.report_bot_settings order by company_id")).rows;
    assert.deepEqual(rows.map((row) => [row.ai_provider, row.ai_model]), [["gemini", "gemini-3.8-flash"], ["openai", "gpt-4o-mini"]]);
    await assert.rejects(db.query("update public.report_bot_settings set ai_provider = 'deepmind'"), /check constraint/);
  } finally {
    await db.close();
  }
});

async function seedGroup(db, companyId, jid) {
  const result = await db.query("insert into public.report_bot_groups (company_id, wa_group_id, is_enabled) values ($1, $2, true) returning id", [companyId, jid]);
  return result.rows[0].id;
}

async function seedSubmission(db, companyId, groupId, messageId) {
  await db.query("insert into public.report_bot_submissions (company_id, group_id, wa_message_id, message_at, media_ref) values ($1, $2, $3, now(), 'ref12345678')", [companyId, groupId, messageId]);
}

test("migration applies, enforces shape and keeps tables away from browser roles", async () => {
  const db = await setup();
  try {
    await assert.rejects(db.query("insert into public.report_bot_groups (company_id, wa_group_id) values ($1, 'not-a-group')", [COMPANY_A]), /check constraint/);
    await assert.rejects(db.query("insert into public.report_bot_settings (company_id, mode) values ($1, 'sometimes')", [COMPANY_A]), /check constraint/);
    await assert.rejects(db.query("insert into public.report_bot_settings (company_id, reply_delay_min_seconds, reply_delay_max_seconds) values ($1, 90, 20)", [COMPANY_A]), /check constraint/);
    const settings = await db.query("insert into public.report_bot_settings (company_id) values ($1) returning mode, ai_model, approval_mode", [COMPANY_A]);
    assert.deepEqual(settings.rows[0], { mode: "off", ai_model: "gemini-3.8-flash", approval_mode: "manual" }, "a new company starts switched off, on free Gemini and manual approval");

    const groupId = await seedGroup(db, COMPANY_A, "120363000000000001@g.us");
    await assert.rejects(seedGroup(db, COMPANY_A, "120363000000000001@g.us"), /duplicate key/);
    const type = await db.query("insert into public.report_bot_report_types (company_id, name, rules) values ($1, 'EOD', '{a}') returning id", [COMPANY_A]);
    await assert.rejects(db.query("insert into public.report_bot_schedules (company_id, group_id, report_type_id, due_time) values ($1, $2, $3, '25:00')", [COMPANY_A, groupId, type.rows[0].id]), /check constraint/);
    const schedule = await db.query("insert into public.report_bot_schedules (company_id, group_id, report_type_id, due_time) values ($1, $2, $3, '10:00') returning id", [COMPANY_A, groupId, type.rows[0].id]);
    const insertRequest = () => db.query(
      "insert into public.report_bot_requests (company_id, schedule_id, group_id, report_type_id, business_date) values ($1, $2, $3, $4, '2026-10-15') on conflict (schedule_id, business_date) do nothing returning id",
      [COMPANY_A, schedule.rows[0].id, groupId, type.rows[0].id]
    );
    assert.equal((await insertRequest()).rows.length, 1);
    assert.equal((await insertRequest()).rows.length, 0, "a schedule gets one request per day even if two cron runs race");

    const outbox = () => db.query("insert into public.report_bot_outbox (company_id, group_id, kind, dedupe_key, body) values ($1, $2, 'reminder', 'reminder:x:0', 'hi') on conflict (company_id, dedupe_key) do nothing returning id", [COMPANY_A, groupId]);
    assert.equal((await outbox()).rows.length, 1);
    assert.equal((await outbox()).rows.length, 0, "the same reminder is never queued twice");

    await seedSubmission(db, COMPANY_A, groupId, "MSG-1");
    await assert.rejects(seedSubmission(db, COMPANY_A, groupId, "MSG-1"), /duplicate key/, "a redelivered WhatsApp message is stored once");

    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query("select * from public.report_bot_settings"), /permission denied/);
      await assert.rejects(db.query("select * from public.report_bot_claim_outbox($1, 5, 60)", [COMPANY_A]), /permission denied/);
      await db.exec("reset role");
    }
  } finally {
    await db.close();
  }
});

test("claims are per company, never hand the same row out twice, and expire", async () => {
  const db = await setup();
  try {
    const groupA = await seedGroup(db, COMPANY_A, "120363000000000001@g.us");
    const groupB = await seedGroup(db, COMPANY_B, "120363000000000002@g.us");
    await seedSubmission(db, COMPANY_A, groupA, "A-1");
    await seedSubmission(db, COMPANY_A, groupA, "A-2");
    await seedSubmission(db, COMPANY_B, groupB, "B-1");

    const first = await db.query("select wa_message_id, attempts from public.report_bot_claim_submissions($1, 1, 60)", [COMPANY_A]);
    const second = await db.query("select wa_message_id from public.report_bot_claim_submissions($1, 5, 60)", [COMPANY_A]);
    const third = await db.query("select wa_message_id from public.report_bot_claim_submissions($1, 5, 60)", [COMPANY_A]);
    assert.equal(first.rows.length, 1);
    assert.equal(first.rows[0].attempts, 1, "claiming counts an attempt");
    assert.deepEqual(second.rows.map((row) => row.wa_message_id), [first.rows[0].wa_message_id === "A-1" ? "A-2" : "A-1"]);
    assert.equal(third.rows.length, 0, "leased rows are not handed out again");
    assert.deepEqual((await db.query("select wa_message_id from public.report_bot_claim_submissions($1, 5, 60)", [COMPANY_B])).rows.map((row) => row.wa_message_id), ["B-1"], "another company's work is separate");

    await db.query("update public.report_bot_submissions set locked_until = now() - interval '1 second' where wa_message_id = 'A-1'");
    const reclaimed = await db.query("select wa_message_id, attempts from public.report_bot_claim_submissions($1, 5, 60)", [COMPANY_A]);
    assert.deepEqual(reclaimed.rows.map((row) => [row.wa_message_id, row.attempts]), [["A-1", 2]], "a crashed run's lease expires and the row is retried");

    await db.query("update public.report_bot_submissions set status = 'awaiting_approval', locked_until = null");
    assert.equal((await db.query("select * from public.report_bot_claim_submissions($1, 5, 60)", [COMPANY_A])).rows.length, 0, "only queued rows are claimed");

    await db.query("insert into public.report_bot_outbox (company_id, group_id, kind, dedupe_key, body, not_before) values ($1, $2, 'feedback', 'f:later', 'later', now() + interval '1 hour'), ($1, $2, 'feedback', 'f:now', 'now', now())", [COMPANY_A, groupA]);
    const due = await db.query("select dedupe_key from public.report_bot_claim_outbox($1, 5, 60)", [COMPANY_A]);
    assert.deepEqual(due.rows.map((row) => row.dedupe_key), ["f:now"], "messages wait for their delay");
  } finally {
    await db.close();
  }
});
