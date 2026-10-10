import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

import { helperPayoutPublicationSnapshotHash } from "./helper-payout-publication.ts";
import { buildHelperPayoutPublicationSnapshot } from "./helper-payout-publication-snapshot.ts";

const helperId = "10000000-0000-4000-8000-000000000001";
const stationId = "20000000-0000-4000-8000-000000000001";
const publicationMigration = readFileSync(
  new URL("../../supabase/migrations/20261010200000_helper_payout_publication_notifications.sql", import.meta.url),
  "utf8"
).replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");

function helperRow(overrides = {}) {
  return {
    id: "helper-allocation-1",
    dropxId: "H1001",
    dropxStatus: "Active",
    name: "Helper Person",
    designation: "House Keeping",
    providerMemberId: "No provider ID",
    providerMemberName: "Helper direct pay",
    locationId: stationId,
    reviewSubjectType: "helper",
    reviewSubjectId: helperId,
    location: "HO_MJR",
    provider: "Direct",
    model: "Attendance / fixed",
    paymentMethod: "Fixed Payment Per Day",
    mappingStatus: "Not required",
    paymentDetailsAvailable: true,
    workDays: 12,
    workDaysSource: "Biometric",
    production: 0,
    paymentMethodBreakdown: [{ id: "method-1", label: "Fixed Payment Per Day", amount: 3600 }],
    history: [],
    productionBreakdown: [],
    dailyBreakdown: [],
    additionalPaymentBreakdown: [],
    baseAmount: 3600,
    additions: 0,
    grossPayment: 3600,
    deductions: 0,
    deductionBreakdown: [],
    panAadhaarStatus: "NOT LINKED",
    netAmount: 3600,
    status: "Ready For Review",
    ...overrides
  };
}

test("Helper publication snapshots keep Helper identity explicit and remain client-safe", () => {
  const snapshot = buildHelperPayoutPublicationSnapshot(helperRow(), "2026-09-01", "2026-09-30");
  assert.equal(snapshot.source, "helper_payout_worksheet");
  assert.equal(snapshot.item.helper_id, helperId);
  assert.equal(snapshot.item.station_id, stationId);
  assert.equal(Object.hasOwn(snapshot.item, "workforce_id"), false);
  assert.equal(snapshot.item.net_amount, 3600);
  assert.match(helperPayoutPublicationSnapshotHash(snapshot), /^[a-f0-9]{64}$/);

  const clientSource = readFileSync(new URL("./helper-payout-publication-snapshot.ts", import.meta.url), "utf8");
  assert.doesNotMatch(clientSource, /node:crypto|server-only/);
});

test("Helper publication hashes change with payout amounts", () => {
  const original = buildHelperPayoutPublicationSnapshot(helperRow(), "2026-09-01", "2026-09-30");
  const changed = buildHelperPayoutPublicationSnapshot(helperRow({
    grossPayment: 3500,
    netAmount: 3500
  }), "2026-09-01", "2026-09-30");
  assert.notEqual(
    helperPayoutPublicationSnapshotHash(original),
    helperPayoutPublicationSnapshotHash(changed)
  );
});

test("Helper notification publication is immutable and targets DropX One worker profiles", () => {
  const migration = publicationMigration;
  assert.match(migration, /create table if not exists public\.helper_payout_publications/i);
  assert.match(migration, /helper_payout_publications_company_id_id_uidx[\s\S]*?\(company_id, id\)/i);
  assert.match(migration, /guard_helper_payout_publication_immutable/i);
  assert.match(migration, /create or replace function public\.helper_publish_payout_notifications/i);
  assert.match(migration, /p_company, 'worker', item_subject,[\s\S]*?'workforce_payout_review'/i);
  assert.match(migration, /elsif new\.recipient_profile_type = 'worker'[\s\S]*?from public\.helpers helper/i);
});

test("Helper publication migration atomically creates an App-only worker notification", async () => {
  const db = new PGlite();
  await db.exec(`
    do $$ begin create role anon; create role authenticated; create role service_role; end $$;
    create schema auth;
    create table auth.users(id uuid primary key);
    create table public.companies(id uuid primary key);
    create table public.helpers(
      id uuid primary key, company_id uuid not null, full_name text, dropx_id text,
      mobile text, mobile_country_code text, is_active boolean, onboarding_status text
    );
    create table public.biometric_enrolments(
      id uuid primary key default gen_random_uuid(), company_id uuid not null
    );
    create table public.stations(
      id uuid primary key, company_id uuid not null, is_active boolean
    );
    create table public.workforce(
      id uuid primary key, company_id uuid not null, dropx_id text, full_name text
    );
    create table public.workforce_payout_review_submissions(
      id uuid primary key default gen_random_uuid(), company_id uuid not null,
      subject_type text not null, subject_id uuid not null, location_id uuid not null,
      period_start date not null, period_end date not null, status text not null,
      calculation_snapshot jsonb not null, submitted_by uuid, submitted_at timestamptz, updated_at timestamptz,
      unique(company_id,subject_type,subject_id,location_id,period_start,period_end)
    );
    create table public.helper_payment_allocations(
      id uuid primary key default gen_random_uuid(), company_id uuid not null,
      helper_id uuid not null, station_id uuid not null, effective_from date not null,
      effective_to date, status text not null default 'active'
    );
    create table public.helper_payout_attendance_values(
      id uuid primary key default gen_random_uuid(), company_id uuid not null,
      helper_id uuid not null, station_id uuid not null, effective_from date not null,
      effective_to date not null
    );
    create table public.helper_additional_payment_values(
      id uuid primary key default gen_random_uuid(), company_id uuid not null,
      helper_id uuid not null, station_id uuid not null, effective_from date not null,
      effective_to date not null
    );
    create table public.helper_payout_deduction_values(
      id uuid primary key default gen_random_uuid(), company_id uuid not null,
      helper_id uuid not null, station_id uuid not null, effective_from date not null,
      effective_to date not null
    );
    create table public.workforce_payout_dependency_revisions(
      company_id uuid primary key, revision bigint not null default 0
    );
    create table public.workforce_payout_period_dependency_revisions(
      company_id uuid not null, period_month date not null, revision bigint not null default 0,
      primary key(company_id,period_month)
    );
    create function public.lock_workforce_payment_allocation_company(uuid)
      returns void language plpgsql as $$ begin return; end $$;
    create function public.workforce_touch_payout_dependency_from_new_rows()
      returns trigger language plpgsql as $$
      declare company uuid; begin
        for company in select distinct company_id from payout_dependency_new_rows loop
          insert into public.workforce_payout_dependency_revisions(company_id,revision)
          values(company,1) on conflict(company_id) do update
          set revision=public.workforce_payout_dependency_revisions.revision+1;
        end loop; return null;
      end $$;
    create function public.workforce_touch_payout_dependency_from_old_rows()
      returns trigger language plpgsql as $$
      declare company uuid; begin
        for company in select distinct company_id from payout_dependency_old_rows loop
          insert into public.workforce_payout_dependency_revisions(company_id,revision)
          values(company,1) on conflict(company_id) do update
          set revision=public.workforce_payout_dependency_revisions.revision+1;
        end loop; return null;
      end $$;
    create function public.workforce_touch_payout_dependency_from_changed_rows()
      returns trigger language plpgsql as $$
      declare company uuid; begin
        for company in select distinct company_id from (
          select company_id from payout_dependency_old_rows
          union select company_id from payout_dependency_new_rows
        ) changed loop
          insert into public.workforce_payout_dependency_revisions(company_id,revision)
          values(company,1) on conflict(company_id) do update
          set revision=public.workforce_payout_dependency_revisions.revision+1;
        end loop; return null;
      end $$;
    create function public.workforce_touch_all_payout_dependency_revisions()
      returns trigger language plpgsql as $$ begin
        update public.workforce_payout_dependency_revisions set revision=revision+1;
        return null;
      end $$;
    create table public.whatsapp_settings(company_id uuid not null, id boolean not null, is_enabled boolean);
    create table public.whatsapp_profiles(
      id uuid primary key, company_id uuid not null, is_active boolean,
      phone_number_id text, default_country_code text
    );
    create table public.whatsapp_template_cache(
      company_id uuid not null, whatsapp_profile_id uuid, template_id text,
      name text, language text, status text, components jsonb
    );
    create table public.whatsapp_notification_configs(
      id uuid primary key, company_id uuid not null, event_code text not null,
      is_enabled boolean not null, app_notification_enabled boolean not null,
      whatsapp_profile_id uuid, template_id text, template_name text,
      template_language text, variable_mappings jsonb, updated_at timestamptz not null
    );
    create table public.mob_app_notification_campaigns(
      id uuid primary key, company_id uuid not null, event_code text not null,
      campaign_code text not null, created_by uuid, created_at timestamptz
    );
    create table public.mob_app_notifications(
      id uuid primary key default gen_random_uuid(), company_id uuid not null,
      recipient_profile_type text not null, recipient_account_id uuid not null,
      event_code text not null, title text not null, body text not null,
      route text, data jsonb not null default '{}'::jsonb, source_key text not null,
      created_by uuid, created_at timestamptz not null default now(), campaign_id uuid,
      push_status text, unique(company_id,event_code,source_key,recipient_account_id)
    );
    create function public.mob_app_assign_payout_campaign() returns trigger
      language plpgsql as $$ begin return new; end $$;
    create trigger mob_app_notifications_10_assign_payout_campaign
      before insert on public.mob_app_notifications
      for each row execute function public.mob_app_assign_payout_campaign();
  `);
  await db.exec(publicationMigration);

  const company = "30000000-0000-4000-8000-000000000001";
  const actor = "40000000-0000-4000-8000-000000000001";
  const config = "50000000-0000-4000-8000-000000000001";
  const secondStationId = "20000000-0000-4000-8000-000000000002";
  const legacyHelperId = "10000000-0000-4000-8000-000000000002";
  const updatedAt = "2026-10-10T12:00:00.000Z";
  await db.query("insert into auth.users(id) values ($1)", [actor]);
  await db.query("insert into public.companies(id) values ($1)", [company]);
  await db.query(
    "insert into public.helpers(id,company_id,full_name,dropx_id,mobile,mobile_country_code,is_active,onboarding_status) values ($1,$2,'Helper Person','H1001','9876543210','91',true,'active')",
    [helperId, company]
  );
  await db.query("insert into public.stations(id,company_id,is_active) values ($1,$2,true),($3,$2,true)", [stationId, company, secondStationId]);
  await db.query(
    "insert into public.whatsapp_notification_configs(id,company_id,event_code,is_enabled,app_notification_enabled,variable_mappings,updated_at) values ($1,$2,'workforce_payout_review',false,true,'{}'::jsonb,$3)",
    [config, company, updatedAt]
  );

  const snapshot = buildHelperPayoutPublicationSnapshot(helperRow(), "2026-09-01", "2026-09-30");
  const notificationSnapshot = {
    schema_version: "1",
    event_code: "workforce_payout_review",
    app_notification_enabled: true,
    whatsapp_notification_enabled: false,
    resolved_values: {
      deduction_amount: "Rs 0", dropx_id: "H1001", full_name: "Helper Person",
      gross_amount: "Rs 3,600", net_amount: "Rs 3,600", payment_label: "Payment",
      payout_period: "01 Sep 2026 to 30 Sep 2026",
      payout_url: "https://one.dropxlogistics.com/payments?tab=payouts&payoutMonth=2026-09&id=H1001",
      review_deadline: "31 Dec 2099", station_code: "HO_MJR", work_days: "12"
    }
  };
  const items = [{
    subject_type: "helper",
    subject_id: helperId,
    location_id: stationId,
    expected_status: "ready",
    calculation_snapshot: snapshot,
    snapshot_hash: helperPayoutPublicationSnapshotHash(snapshot),
    notification_config_snapshot: notificationSnapshot,
    notification_primary: true
  }];
  const publish = async (publicationItems) => {
    const identities = publicationItems.map((item) => ({
      helper_id: item.subject_id,
      station_id: item.location_id
    }));
    const dependency = await db.query(
      "select * from public.helper_payout_dependency_state($1,'2026-09-01','2026-09-30',$2::jsonb)",
      [company, JSON.stringify(identities)]
    );
    const stateByIdentity = new Map(dependency.rows.map((row) => [
      `${row.helper_id}|${row.station_id}`,
      row
    ]));
    const versionedItems = publicationItems.map((item) => {
      const state = stateByIdentity.get(`${item.subject_id}|${item.location_id}`);
      return {
        ...item,
        expected_dependency_hash: state.payout_dependency_hash,
        expected_source_change_id: String(state.payout_source_change_id)
      };
    });
    return db.query(
      "select public.helper_publish_payout_notifications($1,$2,'2026-09-01','2026-09-30',$3::jsonb,null,'2099-12-31T00:00:00Z',now(),$4,$5) as result",
      [company, actor, JSON.stringify(versionedItems), config, updatedAt]
    );
  };
  const published = await publish(items);
  assert.equal(published.rows[0].result.published, 1);
  assert.equal(published.rows[0].result.whatsapp_publication_ids.length, 0);
  assert.equal(published.rows[0].result.app_notification_ids.length, 1);

  const notification = await db.query("select recipient_profile_type,data,campaign_id from public.mob_app_notifications");
  assert.equal(notification.rows[0].recipient_profile_type, "worker");
  assert.equal(notification.rows[0].data.dropxId, "H1001");
  assert.ok(notification.rows[0].campaign_id);
  const stored = await db.query("select id,notification_status from public.helper_payout_publications");
  assert.equal(stored.rows[0].notification_status, "disabled");
  await assert.rejects(
    db.query("update public.helper_payout_publications set snapshot='{}'::jsonb where id=$1", [stored.rows[0].id]),
    /immutable/i
  );

  await assert.rejects(publish(items), /publication state changed/i);

  const revisedSnapshot = buildHelperPayoutPublicationSnapshot(helperRow({
    grossPayment: 3700,
    netAmount: 3700
  }), "2026-09-01", "2026-09-30");
  const revised = await publish([{ ...items[0],
    calculation_snapshot: revisedSnapshot,
    snapshot_hash: helperPayoutPublicationSnapshotHash(revisedSnapshot)
  }]);
  assert.equal(revised.rows[0].result.published, 1);
  let review = await db.query("select status from public.workforce_payout_review_submissions where subject_id=$1", [helperId]);
  assert.deepEqual(review.rows.map((row) => row.status), ["under_review"]);

  await db.query("update public.workforce_payout_review_submissions set status='approved' where subject_id=$1", [helperId]);
  const approvedSnapshot = buildHelperPayoutPublicationSnapshot(helperRow({
    grossPayment: 3800,
    netAmount: 3800
  }), "2026-09-01", "2026-09-30");
  await publish([{ ...items[0],
    calculation_snapshot: approvedSnapshot,
    snapshot_hash: helperPayoutPublicationSnapshotHash(approvedSnapshot)
  }]);
  review = await db.query("select status from public.workforce_payout_review_submissions where subject_id=$1", [helperId]);
  assert.deepEqual(review.rows.map((row) => row.status), ["approved"]);

  const changedPrimary = buildHelperPayoutPublicationSnapshot(helperRow({
    grossPayment: 3900,
    netAmount: 3900
  }), "2026-09-01", "2026-09-30");
  const newLocation = buildHelperPayoutPublicationSnapshot(helperRow({
    id: "helper-allocation-2",
    locationId: secondStationId,
    baseAmount: 1000,
    grossPayment: 1000,
    netAmount: 1000
  }), "2026-09-01", "2026-09-30");
  const locationCohort = [
    { ...items[0], calculation_snapshot: changedPrimary, snapshot_hash: helperPayoutPublicationSnapshotHash(changedPrimary) },
    { ...items[0], location_id: secondStationId, calculation_snapshot: newLocation, snapshot_hash: helperPayoutPublicationSnapshotHash(newLocation), notification_primary: false }
  ];
  await publish(locationCohort);
  const changedAgain = buildHelperPayoutPublicationSnapshot(helperRow({
    grossPayment: 4000,
    netAmount: 4000
  }), "2026-09-01", "2026-09-30");
  await publish([
    { ...locationCohort[0], calculation_snapshot: changedAgain, snapshot_hash: helperPayoutPublicationSnapshotHash(changedAgain) },
    locationCohort[1]
  ]);
  const locationRevisions = await db.query(
    "select station_id,max(revision)::integer revision from public.helper_payout_publications where helper_id=$1 group by station_id order by station_id",
    [helperId]
  );
  assert.deepEqual(locationRevisions.rows.map((row) => row.revision), [5, 2]);

  await db.query(
    "insert into public.helpers(id,company_id,full_name,dropx_id,mobile,mobile_country_code,is_active,onboarding_status) values ($1,$2,'Legacy Helper','H1002','9876543211','91',true,'active')",
    [legacyHelperId, company]
  );
  const legacySnapshot = buildHelperPayoutPublicationSnapshot(helperRow({
    reviewSubjectId: legacyHelperId,
    dropxId: "H1002"
  }), "2026-09-01", "2026-09-30");
  await db.query(
    "insert into public.workforce_payout_review_submissions(company_id,subject_type,subject_id,location_id,period_start,period_end,status,calculation_snapshot) values ($1,'helper',$2,$3,'2026-09-01','2026-09-30','under_review',$4::jsonb)",
    [company, legacyHelperId, stationId, JSON.stringify(legacySnapshot)]
  );
  const legacyPublished = await publish([{ ...items[0],
    subject_id: legacyHelperId,
    calculation_snapshot: legacySnapshot,
    snapshot_hash: helperPayoutPublicationSnapshotHash(legacySnapshot)
  }]);
  assert.equal(legacyPublished.rows[0].result.published, 1);
  const legacyStored = await db.query("select revision from public.helper_payout_publications where helper_id=$1", [legacyHelperId]);
  assert.deepEqual(legacyStored.rows.map((row) => row.revision), [1]);
  await db.close();
});

test("payment-settings access exposes Helper setup without broadening Workforce provider mapping", () => {
  const page = readFileSync(new URL("../app/provider-mapping/direct-pay/page.tsx", import.meta.url), "utf8");
  const action = readFileSync(new URL("../app/provider-mapping/direct-pay/actions.ts", import.meta.url), "utf8");
  const hub = readFileSync(new URL("../app/settings/workforce-payment/page.tsx", import.meta.url), "utf8");

  assert.match(page, /audience === "helpers" && searchParams\.source === "payment-settings"/);
  assert.match(page, /accessPageCode = paymentSettingsEntry \? "payment_settings" : pageCode/);
  assert.match(action, /if \(permissionScope === "payment_settings"\)[\s\S]*?audience !== "helpers"/);
  assert.match(action, /hasPermission\(authorization, "payment_settings", "edit"\)/);
  assert.match(action, /else if \(!canEditProviderMappings\(authorization\)\)/);
  assert.match(hub, /Helper Payment Setup/);
  assert.match(hub, /audience=helpers&source=payment-settings/);
});

test("Helper payout publications are included in WhatsApp notification history", () => {
  const historyPage = readFileSync(new URL("../app/notifications/history/page.tsx", import.meta.url), "utf8");
  assert.match(historyPage, /from\("helper_payout_publications"\)/);
  assert.match(historyPage, /\.eq\("company_id", companyId\)/);
  assert.match(historyPage, /\.\.\.\(helperPayoutPublications\.data \?\? \[\]\)/);
});

test("Helper publication reloads amounts and the full location set before freezing", () => {
  const route = readFileSync(new URL("../app/api/payments/workforce-payouts/send-review/route.ts", import.meta.url), "utf8");
  const payoutPage = readFileSync(new URL("../app/payments/workforce-payouts/page.tsx", import.meta.url), "utf8");
  assert.match(route, /loadHelperPayoutRows\(companyId, authorization, periodStart, periodEnd\)/);
  assert.match(route, /isWorkforcePayoutCalculationPublishable\(row\.status\)/);
  assert.match(route, /buildHelperPayoutPublicationSnapshot\(row, periodStart, periodEnd\)/);
  assert.match(route, /helperPayoutPublicationSnapshotHash\(snapshot\) !== item\.token!\.publicationSnapshotHash/);
  assert.match(route, /workforcePayoutLocationSetHash\(currentLocations\) !== \[\.\.\.expectedLocationHashes\]\[0\]/);
  assert.match(route, /helperPublicationReplayState/);
  assert.match(publicationMigration, /helper_has_snapshot_change/);
  assert.match(publicationMigration, /existing_review_status = 'approved'/);
  assert.match(payoutPage, /snapshot_hash,payout_dependency_hash,payout_source_change_id/);
  assert.match(payoutPage, /rpc\("helper_payout_dependency_state"/);
  assert.match(payoutPage, /publication\.dependencyHash === dependency\?\.dependencyHash/);
  assert.match(payoutPage, /publication\.sourceChangeId === dependency\?\.sourceChangeId/);
  assert.match(payoutPage, /Republish required/);
});
