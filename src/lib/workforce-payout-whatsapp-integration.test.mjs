import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

function bracedBlocksAfter(source, pattern) {
  const blocks = [];
  for (const match of source.matchAll(pattern)) {
    const open = source.indexOf("{", match.index + match[0].length);
    if (open < 0) continue;
    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      if (source[index] === "}") depth -= 1;
      if (depth === 0) {
        blocks.push(source.slice(open + 1, index));
        break;
      }
    }
  }
  return blocks;
}

test("payout notification settings use payment_settings and the dedicated event code", () => {
  const page = read("../app/settings/workforce-payment/payout-notification/page.tsx");
  const actions = read("../app/settings/workforce-payment/payout-notification/actions.ts");
  const form = read("../app/settings/workforce-payment/payout-notification/payout-notification-form.tsx");
  const hub = read("../app/settings/workforce-payment/page.tsx");
  assert.match(page, /requirePagePermission\("payment_settings", "access"\)/);
  assert.match(actions, /requirePagePermissionOrThrow\("payment_settings", "edit"\)/);
  assert.match(actions, /from\("whatsapp_notification_configs"\)\.upsert/);
  assert.match(actions, /WORKFORCE_PAYOUT_WHATSAPP_EVENT/);
  assert.match(hub, /\/settings\/workforce-payment\/payout-notification/);
  assert.match(page, /app_notification_enabled/);
  assert.match(form, /name="app_notification_enabled"/);
  assert.match(form, /name="is_enabled"/);
  assert.match(actions, /const appNotificationEnabled = formData\.get\("app_notification_enabled"\) === "on"/);
  assert.match(actions, /app_notification_enabled: appNotificationEnabled/);
  assert.match(form, /required=\{enabled\}/);
  assert.match(form, /disabled=\{!canEdit \|\| !enabled\}/);
  assert.match(actions, /if \(isEnabled && profileId && templateId\)/);
  assert.doesNotMatch(
    actions,
    /if\s*\(\s*appNotificationEnabled[\s\S]{0,160}(?:profileId|templateId|whatsapp_settings)/,
    "App notification must be saveable without a WhatsApp sender, template, or global WhatsApp setting."
  );
});

test("Android App notifications are data-only so background taps retain the payout route", () => {
  const push = read("./firebase-push.ts");
  assert.match(push, /dropxTitle: notification\.title/);
  assert.match(push, /dropxBody: notification\.body/);
  assert.match(push, /if \(row\.platform === "ios"\) \{[\s\S]*message\.notification =/);
  assert.match(push, /else \{[\s\S]*message\.android = \{ priority: "high" \}/);
  assert.doesNotMatch(push, /message\.android\s*=\s*\{[\s\S]{0,160}notification:/);
});

test("App-only payout publication does not require Meta readiness or a mobile number", () => {
  const publisher = read("../app/api/payments/workforce-payouts/send-review/route.ts");
  assert.match(publisher, /const whatsappNotificationEnabled = Boolean\(config\.data\.is_enabled\)/);
  assert.match(publisher, /const appNotificationEnabled = Boolean\(config\.data\.app_notification_enabled\)/);
  assert.match(publisher, /if\s*\(\s*!whatsappNotificationEnabled\s*&&\s*!appNotificationEnabled\s*\)/);

  const whatsAppBlocks = bracedBlocksAfter(
    publisher,
    /if\s*\(whatsappNotificationEnabled(?:\s*&&\s*activeProfile\s*&&\s*approvedTemplate)?\)\s*/g
  );
  assert.ok(
    whatsAppBlocks.some((block) => block.includes('from("whatsapp_settings")')),
    "Meta/global WhatsApp readiness must only be loaded for the WhatsApp channel."
  );
  assert.ok(
    whatsAppBlocks.some((block) => block.includes("normalizeWorkforceWhatsAppRecipient")),
    "Mobile-number validation must only run for the WhatsApp channel."
  );

  assert.match(publisher, /const values = workforcePayoutWhatsAppValues\(/);
  assert.match(publisher, /resolved_values: values/);
  assert.match(publisher, /app_notification_enabled: appNotificationEnabled/);
  assert.match(publisher, /whatsapp_notification_enabled: whatsappNotificationEnabled/);
});

test("Workforce publication accepts configured zero payouts without weakening stale-row protection", () => {
  const publisher = read("../app/api/payments/workforce-payouts/send-review/route.ts");
  assert.match(publisher, /loadStablePayoutWorksheet\(\{[\s\S]*?loadRows:\s*\(\)\s*=>\s*loadWorkforcePayoutRows[\s\S]*?loadDependency:\s*\(\)\s*=>\s*workforcePayoutDependencyHash/);
  assert.match(
    publisher,
    /selected\.some\(\(\{\s*row\s*\}\)\s*=>\s*!row\?\.paymentDetailsAvailable\s*\|\|\s*!isWorkforcePayoutCalculationPublishable\(row\?\.status\)\)/,
    "Configured Workforce rows must be gated by shared publishability, not positive amount or attendance."
  );
  assert.match(
    publisher,
    /selected\.some\(\(\{\s*item,\s*row\s*\}\)\s*=>\s*!item\.token\?\.calculationHash[\s\S]*?workforcePayoutCalculationHash\(row!,\s*periodStart,\s*periodEnd\)\s*!==\s*item\.token\.calculationHash/,
    "The freshly loaded selected row must still match the calculation hash signed into its review token."
  );
  assert.match(publisher, /loaded\.rows[\s\S]*?isWorkforcePayoutCalculationPublishable\(row\.status\)[\s\S]*?Select every publishable location row/);
  assert.doesNotMatch(
    publisher,
    /selected\.some\(\(\{\s*row\s*\}\)[\s\S]{0,240}(?:gross(?:Payment|Amount)|net(?:Pay|Amount)|workDays|attendance)\s*(?:>|===?)\s*0/,
    "Zero amount, work days, and attendance must not independently block a configured Workforce payout."
  );
});

test("delivery consumes frozen publication configuration and supports targeted processing", () => {
  const worker = read("./payout-review-notifications.ts");
  assert.match(worker, /notification_config_snapshot/);
  assert.match(worker, /frozenNotificationConfig\(publication\.notification_config_snapshot\)/);
  assert.match(worker, /config\.recipient \?\? normalizeWorkforceWhatsAppRecipient/);
  assert.match(worker, /templateResult\.data\.components[\s\S]+config\.template_components/);
  assert.match(worker, /publicationIds\?: string\[\]/);
  assert.match(worker, /concurrently\(queue, targeted \? 12 : 8/);
  assert.match(worker, /was accepted by WhatsApp, but its message audit log could not be saved/);
  assert.match(worker, /workforce_id: publication\.workforce_id/);
  assert.doesNotMatch(worker, /payment_details_available/);
});

test("publication freezes the exact recipient and the atomic RPC validates it", () => {
  const publisher = read("../app/api/payments/workforce-payouts/send-review/route.ts");
  const migration = read("../../supabase/migrations/20261008010000_workforce_payout_app_notifications.sql");
  assert.match(publisher, /normalizeWorkforceWhatsAppRecipient\(person\?\.mobile, person\?\.mobile_country_code\)/);
  assert.match(publisher, /resolved_values: values/);
  assert.match(migration, /item_notification_snapshot\s*->>\s*'recipient'/);
  assert.match(migration, /item_notification_snapshot\s*->\s*'template_components'\s*=\s*template\.components/);
});

test("atomic publication creates one App notification per workforce primary row", () => {
  const migration = read("../../supabase/migrations/20261008010000_workforce_payout_app_notifications.sql");
  assert.match(migration, /add column if not exists app_notification_enabled boolean not null default false/);
  assert.match(
    migration,
    /group by lower\(nullif\(selected ->> 'subject_id', ''\)\)[\s\S]*count\(\*\) filter \(where coalesce\(\(selected ->> 'notification_primary'\)::boolean, false\)\) <> 1/
  );
  assert.equal(
    (migration.match(/insert into public\.mob_app_notifications\s*\(/g) ?? []).length,
    1,
    "The publication transaction should contain one canonical App-notification insert path."
  );
  assert.match(
    migration,
    /if item_notification_primary then[\s\S]*if config_app_enabled then[\s\S]*insert into public\.mob_app_notifications\s*\([\s\S]*end loop;/
  );
  assert.match(
    migration,
    /insert into public\.mob_app_notifications\s*\([\s\S]*event_code[\s\S]*'workforce_payout_review'/
  );
  assert.match(migration, /'workforce'/);
  assert.match(migration, /source_key[\s\S]*publication_id::text/);
  assert.match(migration, /'publication_ids', publication_ids/);
  assert.match(migration, /'whatsapp_publication_ids', whatsapp_publication_ids/);
  assert.match(migration, /'app_notification_ids', app_notification_ids/);
});

test("App notification opens the frozen exact payout month URL", () => {
  const migration = read("../../supabase/migrations/20261008010000_workforce_payout_app_notifications.sql");
  assert.match(
    migration,
    /route[\s\S]*item_notification_snapshot\s*#>>\s*'\{resolved_values,payout_url\}'/
  );
  assert.match(
    migration,
    /'payoutMonth'\s*,\s*to_char\(p_period_(?:start|end),\s*'YYYY-MM'\)/
  );
  assert.match(migration, /if not config_whatsapp_enabled and not config_app_enabled then/);
  assert.match(
    migration,
    /if config_whatsapp_enabled then[\s\S]*A selected Workforce member does not have a valid WhatsApp mobile number[\s\S]*end if;/
  );
});
