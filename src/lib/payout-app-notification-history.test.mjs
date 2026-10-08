import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

import { payoutAppNotificationCampaigns } from "./payout-app-notification-history.ts";

const migration = readFileSync(
  new URL("../../supabase/migrations/20261008030830_workforce_payout_app_notification_history.sql", import.meta.url),
  "utf8"
).replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");
const fkIndexMigration = readFileSync(
  new URL("../../supabase/migrations/20261008030910_workforce_payout_app_notification_campaign_fk_index.sql", import.meta.url),
  "utf8"
).replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");

const historyPage = readFileSync(new URL("../app/notifications/history/page.tsx", import.meta.url), "utf8");

test("payout App batches render as one campaign with recipient-level delivery states", () => {
  const campaigns = payoutAppNotificationCampaigns([{
    id: "10000000-0000-4000-8000-000000000001",
    campaign_code: "APP-PAYOUT-TEST",
    created_at: "2026-10-08T10:00:00.000Z",
    mob_app_notifications: [
      {
        id: "20000000-0000-4000-8000-000000000001",
        recipient_account_id: "30000000-0000-4000-8000-000000000001",
        recipient_profile_type: "workforce",
        title: "Payment details available",
        body: "September payout is ready.",
        data: { dropxId: "DF1001", dropxName: "A Person" },
        created_at: "2026-10-08T10:00:00.000Z",
        read_at: "2026-10-08T11:00:00.000Z",
        push_status: "sent",
        push_error: null
      },
      {
        id: "20000000-0000-4000-8000-000000000002",
        recipient_account_id: "30000000-0000-4000-8000-000000000002",
        recipient_profile_type: "workforce",
        title: "Payment details available",
        body: "September payout is ready.",
        data: { dropxId: "DF1002", dropxName: "B Person" },
        created_at: "2026-10-08T10:00:00.000Z",
        read_at: null,
        push_status: "failed",
        push_error: "No active device token."
      }
    ]
  }]);

  assert.equal(campaigns.length, 1);
  assert.equal(campaigns[0].channel, "App");
  assert.equal(campaigns[0].total_count, 2);
  assert.equal(campaigns[0].whatsapp_profile_name, "DropX One");
  assert.deepEqual(
    campaigns[0].whatsapp_campaign_recipients?.map((recipient) => [recipient.recipient_name, recipient.recipient_mobile, recipient.status]),
    [["A Person", "DF1001", "read"], ["B Person", "DF1002", "failed"]]
  );
});

test("an inbox notification without a device token completes instead of staying processing", () => {
  const campaigns = payoutAppNotificationCampaigns([{
    id: "10000000-0000-4000-8000-000000000002",
    campaign_code: "APP-PAYOUT-NO-TOKEN",
    created_at: "2026-10-08T10:00:00.000Z",
    mob_app_notifications: [{
      id: "20000000-0000-4000-8000-000000000003",
      recipient_account_id: "30000000-0000-4000-8000-000000000003",
      recipient_profile_type: "workforce",
      title: "Payment details available",
      body: "September payout is ready.",
      data: { dropxId: "DF1003", dropxName: "C Person" },
      created_at: "2026-10-08T10:00:00.000Z",
      read_at: null,
      push_status: "pending",
      push_error: "No active Android device token."
    }]
  }]);

  assert.equal(campaigns[0].status, "completed");
  assert.equal(campaigns[0].pending_count, 0);
  assert.equal(campaigns[0].whatsapp_campaign_recipients?.[0].status, "sent");
});

test("Dashboard history loads only tenant-scoped payout App campaigns", () => {
  assert.match(historyPage, /from\("mob_app_notification_campaigns"\)/);
  assert.match(historyPage, /\.eq\("company_id", companyId\)/);
  assert.match(historyPage, /\.eq\("event_code", "workforce_payout_review"\)/);
  assert.match(historyPage, /payoutAppNotificationCampaigns\(appRows\)/);
  assert.doesNotMatch(historyPage, /station|location_id|ops_workforce/i);
});

test("migration groups one payout publication click and enforces tenant-safe campaign ownership", async () => {
  const db = new PGlite();
  await db.exec(`
    do $$ begin create role anon; create role authenticated; create role service_role; end $$;
    create table public.workforce(
      id uuid primary key,
      company_id uuid not null,
      dropx_id text,
      full_name text
    );
    create table public.mob_app_notifications(
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null,
      recipient_profile_type text not null,
      recipient_account_id uuid not null,
      event_code text not null,
      title text not null,
      body text not null,
      route text,
      data jsonb not null default '{}'::jsonb,
      source_key text,
      created_by uuid,
      created_at timestamptz not null default now(),
      read_at timestamptz,
      archived_at timestamptz,
      push_status text not null default 'not_configured',
      push_error text
    );
  `);

  const company = "00000000-0000-4000-8000-000000000001";
  const otherCompany = "00000000-0000-4000-8000-000000000002";
  const actor = "00000000-0000-4000-8000-000000000003";
  const workerA = "00000000-0000-4000-8000-000000000011";
  const workerB = "00000000-0000-4000-8000-000000000012";
  const workerOther = "00000000-0000-4000-8000-000000000013";
  await db.query(
    "insert into public.workforce(id,company_id,dropx_id,full_name) values ($1,$2,'DF1001','A Person'),($3,$2,'DF1002','B Person'),($4,$5,'DF2001','Other Person')",
    [workerA, company, workerB, workerOther, otherCompany]
  );
  await db.query(`
    insert into public.mob_app_notifications(
      company_id,recipient_profile_type,recipient_account_id,event_code,title,body,created_by,created_at
    ) values
      ($1,'workforce',$2,'workforce_payout_review','Ready','Ready',$3,'2026-10-08T09:00:00Z'),
      ($1,'workforce',$4,'workforce_payout_review','Ready','Ready',$3,'2026-10-08T09:00:00Z')
  `, [company, workerA, actor, workerB]);

  await db.exec(`${migration}\n${fkIndexMigration}`);

  const backfilled = await db.query(`
    select campaign_id, data ->> 'dropxId' as dropx_id, data ->> 'dropxName' as name
    from public.mob_app_notifications
    order by recipient_account_id
  `);
  assert.equal(new Set(backfilled.rows.map((row) => row.campaign_id)).size, 1);
  assert.deepEqual(backfilled.rows.map((row) => [row.dropx_id, row.name]), [
    ["DF1001", "A Person"],
    ["DF1002", "B Person"]
  ]);

  await db.query(
    "update public.mob_app_notifications set data = data || jsonb_build_object('dropxName','Original Name') where recipient_account_id=$1",
    [workerA]
  );
  await db.exec(migration);
  assert.equal(
    (await db.query("select data ->> 'dropxName' as name from public.mob_app_notifications where recipient_account_id=$1", [workerA])).rows[0].name,
    "Original Name"
  );

  await db.query(`
    insert into public.mob_app_notifications(
      company_id,recipient_profile_type,recipient_account_id,event_code,title,body,created_by,source_key
    ) values
      ($1,'workforce',$2,'workforce_payout_review','Ready','Ready',$3,'new-a'),
      ($1,'workforce',$4,'workforce_payout_review','Ready','Ready',$3,'new-b'),
      ($5,'workforce',$6,'workforce_payout_review','Ready','Ready',$3,'new-other')
  `, [company, workerA, actor, workerB, otherCompany, workerOther]);

  const grouped = await db.query(`
    select company_id,campaign_id,count(*)::int as recipients
    from public.mob_app_notifications
    where source_key like 'new-%'
    group by company_id,campaign_id
    order by company_id
  `);
  assert.deepEqual(grouped.rows.map((row) => row.recipients), [2, 1]);
  assert.notEqual(grouped.rows[0].campaign_id, grouped.rows[1].campaign_id);

  await assert.rejects(
    db.query(
      "update public.mob_app_notifications set company_id=$1 where company_id=$2 and campaign_id=$3",
      [otherCompany, company, grouped.rows[0].campaign_id]
    ),
    /foreign key constraint/i
  );

  const privileges = await db.query(`
    select
      has_table_privilege('authenticated', 'public.mob_app_notification_campaigns', 'SELECT') as authenticated,
      has_table_privilege('service_role', 'public.mob_app_notification_campaigns', 'SELECT') as service_role
  `);
  assert.equal(privileges.rows[0].authenticated, false);
  assert.equal(privileges.rows[0].service_role, true);
  const coveringIndex = await db.query(`
    select indexdef
    from pg_indexes
    where schemaname='public' and indexname='mob_app_notifications_campaign_idx'
  `);
  assert.match(coveringIndex.rows[0].indexdef, /\(company_id, campaign_id, created_at, id\)/i);
  await db.close();
});
