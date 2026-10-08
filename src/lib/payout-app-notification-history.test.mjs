import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

import { payoutAppNotificationCampaigns } from "./payout-app-notification-history.ts";
import { payoutWhatsappNotificationCampaigns } from "./payout-whatsapp-notification-history.ts";

const migration = readFileSync(
  new URL("../../supabase/migrations/20261008030830_workforce_payout_app_notification_history.sql", import.meta.url),
  "utf8"
).replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");
const fkIndexMigration = readFileSync(
  new URL("../../supabase/migrations/20261008030910_workforce_payout_app_notification_campaign_fk_index.sql", import.meta.url),
  "utf8"
).replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");
const payoutWhatsappStatusMigration = readFileSync(
  new URL("../../supabase/migrations/20261008095420_payout_whatsapp_notification_history_status.sql", import.meta.url),
  "utf8"
);

const historyPage = readFileSync(new URL("../app/notifications/history/page.tsx", import.meta.url), "utf8");
const whatsappWebhook = readFileSync(new URL("../app/api/webhooks/whatsapp/route.ts", import.meta.url), "utf8");

const payoutProfileId = "40000000-0000-4000-8000-000000000001";
const payoutPublisherId = "50000000-0000-4000-8000-000000000001";
const payoutPublishedAt = "2026-10-08T10:00:00.000Z";

function payoutPublication({
  dropxId,
  fullName,
  id,
  notificationError = null,
  notificationReference = null,
  recipient,
  stationId,
  status,
  whatsappEnabled = true,
  withChannelFlag = true,
  workforceId
}) {
  const channelSnapshot = {
    schema_version: 1,
    whatsapp_profile_id: payoutProfileId,
    recipient,
    resolved_values: {
      dropx_id: dropxId,
      full_name: fullName,
      payout_period: "September 2026"
    }
  };
  if (withChannelFlag) channelSnapshot.whatsapp_notification_enabled = whatsappEnabled;
  return {
    id,
    workforce_id: workforceId,
    station_id: stationId,
    published_by: payoutPublisherId,
    published_at: payoutPublishedAt,
    period_start: "2026-09-01",
    period_end: "2026-09-30",
    notification_status: status,
    notification_error: notificationError,
    notification_reference: notificationReference,
    notification_config_snapshot: channelSnapshot
  };
}

function payoutMessageLog({
  id,
  publicationId,
  recipient,
  status,
  workforceId
}) {
  return {
    id,
    event_code: "workforce_payout_review",
    workforce_id: workforceId,
    whatsapp_profile_id: payoutProfileId,
    whatsapp_profile_name: "DropX Payout",
    recipient,
    status,
    provider_message_id: `wamid.${id}`,
    error_message: null,
    request_payload: { publication_id: publicationId },
    created_at: "2026-10-08T10:00:10.000Z",
    updated_at: "2026-10-08T10:01:00.000Z"
  };
}

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

test("one payout publication click groups multiple Workforce people into one WhatsApp campaign", () => {
  const first = payoutPublication({
    dropxId: "DF1001",
    fullName: "A Person",
    id: "61000000-0000-4000-8000-000000000001",
    notificationReference: "wamid.first",
    recipient: "919810000001",
    stationId: "81000000-0000-4000-8000-000000000001",
    status: "sent",
    workforceId: "71000000-0000-4000-8000-000000000001"
  });
  const second = payoutPublication({
    dropxId: "DF1002",
    fullName: "B Person",
    id: "61000000-0000-4000-8000-000000000002",
    notificationError: "Meta rejected the message.",
    recipient: "919810000002",
    stationId: "81000000-0000-4000-8000-000000000002",
    status: "failed",
    workforceId: "71000000-0000-4000-8000-000000000002"
  });

  const campaigns = payoutWhatsappNotificationCampaigns(
    [second, first],
    [],
    new Map([[payoutProfileId, "DropX Payout"]])
  );

  assert.equal(campaigns.length, 1);
  assert.equal(campaigns[0].channel, "WhatsApp");
  assert.equal(campaigns[0].whatsapp_profile_name, "DropX Payout");
  assert.equal(campaigns[0].total_count, 2);
  assert.deepEqual(
    campaigns[0].whatsapp_campaign_recipients
      ?.map((recipient) => [recipient.recipient_name, recipient.status])
      .sort((left, right) => left[0].localeCompare(right[0])),
    [["A Person", "sent"], ["B Person", "failed"]]
  );
});

test("a multi-location Workforce payout contributes only the lexicographically first station recipient", () => {
  const workforceId = "71000000-0000-4000-8000-000000000003";
  const higherStation = payoutPublication({
    dropxId: "DF1003",
    fullName: "C Person",
    id: "61000000-0000-4000-8000-000000000003",
    notificationReference: "wamid.higher",
    recipient: "919810000003",
    stationId: "91000000-0000-4000-8000-000000000002",
    status: "sent",
    workforceId
  });
  const lowerStation = payoutPublication({
    dropxId: "DF1003",
    fullName: "C Person",
    id: "61000000-0000-4000-8000-000000000004",
    notificationReference: "wamid.lower",
    recipient: "919810000003",
    stationId: "91000000-0000-4000-8000-000000000001",
    status: "sent",
    workforceId
  });

  const campaigns = payoutWhatsappNotificationCampaigns([higherStation, lowerStation], []);

  assert.equal(campaigns.length, 1);
  assert.equal(campaigns[0].total_count, 1);
  assert.equal(campaigns[0].whatsapp_campaign_recipients?.length, 1);
  assert.equal(campaigns[0].whatsapp_campaign_recipients?.[0].id, lowerStation.id);
});

test("payout WhatsApp history maps sent, failed, pending and uncertain delivery states", () => {
  const rows = [
    payoutPublication({
      dropxId: "DF1011",
      fullName: "Sent Person",
      id: "62000000-0000-4000-8000-000000000001",
      notificationReference: "wamid.sent",
      recipient: "919820000001",
      stationId: "82000000-0000-4000-8000-000000000001",
      status: "sent",
      workforceId: "72000000-0000-4000-8000-000000000001"
    }),
    payoutPublication({
      dropxId: "DF1012",
      fullName: "Failed Person",
      id: "62000000-0000-4000-8000-000000000002",
      notificationError: "Meta rejected the message.",
      recipient: "919820000002",
      stationId: "82000000-0000-4000-8000-000000000002",
      status: "failed",
      workforceId: "72000000-0000-4000-8000-000000000002"
    }),
    payoutPublication({
      dropxId: "DF1013",
      fullName: "Pending Person",
      id: "62000000-0000-4000-8000-000000000003",
      recipient: "919820000003",
      stationId: "82000000-0000-4000-8000-000000000003",
      status: "pending",
      workforceId: "72000000-0000-4000-8000-000000000003"
    }),
    payoutPublication({
      dropxId: "DF1014",
      fullName: "Uncertain Person",
      id: "62000000-0000-4000-8000-000000000004",
      notificationError: "Delivery outcome needs operator verification.",
      recipient: "919820000004",
      stationId: "82000000-0000-4000-8000-000000000004",
      status: "uncertain",
      workforceId: "72000000-0000-4000-8000-000000000004"
    })
  ];
  const sentLog = payoutMessageLog({
    id: "92000000-0000-4000-8000-000000000001",
    publicationId: rows[0].id,
    recipient: "919820000001",
    status: "sent",
    workforceId: rows[0].workforce_id
  });

  const campaigns = payoutWhatsappNotificationCampaigns(rows, [sentLog]);
  const statusByName = new Map(
    campaigns[0].whatsapp_campaign_recipients?.map((recipient) => [recipient.recipient_name, recipient.status])
  );

  assert.equal(statusByName.get("Sent Person"), "sent");
  assert.equal(statusByName.get("Failed Person"), "failed");
  assert.equal(statusByName.get("Pending Person"), "pending");
  assert.equal(statusByName.get("Uncertain Person"), "processing");
});

test("legacy payout notification snapshots infer WhatsApp from a frozen profile and recipient", () => {
  const legacy = payoutPublication({
    dropxId: "DF1021",
    fullName: "Legacy Person",
    id: "63000000-0000-4000-8000-000000000001",
    notificationReference: "wamid.legacy",
    recipient: "919830000001",
    stationId: "83000000-0000-4000-8000-000000000001",
    status: "sent",
    withChannelFlag: false,
    workforceId: "73000000-0000-4000-8000-000000000001"
  });
  const explicitlyAppOnly = payoutPublication({
    dropxId: "DF1022",
    fullName: "App Only Person",
    id: "63000000-0000-4000-8000-000000000002",
    recipient: "919830000002",
    stationId: "83000000-0000-4000-8000-000000000002",
    status: "sent",
    whatsappEnabled: false,
    workforceId: "73000000-0000-4000-8000-000000000002"
  });

  const campaigns = payoutWhatsappNotificationCampaigns([explicitlyAppOnly, legacy], []);

  assert.equal(campaigns.length, 1);
  assert.equal(campaigns[0].total_count, 1);
  assert.equal(campaigns[0].whatsapp_campaign_recipients?.[0].recipient_name, "Legacy Person");
});

test("Dashboard history loads only tenant-scoped payout App campaigns", () => {
  assert.match(historyPage, /from\("mob_app_notification_campaigns"\)/);
  assert.match(historyPage, /\.eq\("company_id", companyId\)/);
  assert.match(historyPage, /\.eq\("event_code", "workforce_payout_review"\)/);
  assert.match(historyPage, /payoutAppNotificationCampaigns\(appRows\)/);
  assert.doesNotMatch(historyPage, /\.eq\("(?:station_id|location_id)"|ops_workforce/i);
});

test("Dashboard history loads tenant-scoped payout WhatsApp publications and their message logs", () => {
  assert.match(
    historyPage,
    /from\("workforce_payout_publications"\)[\s\S]{0,1600}?\.eq\("company_id", companyId\)/
  );
  assert.match(
    historyPage,
    /from\("whatsapp_message_logs"\)[\s\S]{0,1600}?\.eq\("company_id", companyId\)/
  );
  assert.match(historyPage, /payoutWhatsappNotificationCampaigns\(/);
});

test("WhatsApp delivery webhooks update payout message logs as well as campaign recipients", () => {
  assert.match(
    whatsappWebhook,
    /from\("whatsapp_message_logs"\)[\s\S]{0,800}?\.update\(logUpdate\)[\s\S]{0,400}?\.eq\("provider_message_id", status\.id\)/
  );
});

test("payout WhatsApp audit logs accept provider delivery and read states", () => {
  assert.match(payoutWhatsappStatusMigration, /whatsapp_message_logs_status_check/i);
  assert.match(payoutWhatsappStatusMigration, /'delivered'/i);
  assert.match(payoutWhatsappStatusMigration, /'read'/i);
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
