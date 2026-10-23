import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

test("App-only and silent payout publication do not require Meta readiness or a mobile number", () => {
  const publisher = read("../app/api/payments/workforce-payouts/send-review/route.ts");
  assert.match(publisher, /typeof body\?\.sendWhatsAppNotification !== ["']boolean["']/);
  assert.match(publisher, /const sendWhatsAppNotification = body\?\.sendWhatsAppNotification === true/);
  assert.match(publisher, /notificationPreflight\([\s\S]*?sendWhatsAppNotification/);
  assert.match(publisher, /const whatsappNotificationEnabled = sendWhatsAppNotification && Boolean\(config\.data\.is_enabled\)/);
  assert.match(publisher, /const appNotificationEnabled = Boolean\(config\.data\.app_notification_enabled\)/);
  assert.doesNotMatch(publisher, /if\s*\(\s*!whatsappNotificationEnabled\s*&&\s*!appNotificationEnabled\s*\)/);
  assert.match(
    publisher,
    /if\s*\(sendWhatsAppNotification\s*&&\s*!config\.data\.is_enabled\)[\s\S]*?WhatsApp/i,
    "Checking WhatsApp must fail clearly when the saved WhatsApp payout channel is disabled."
  );

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

test("payout publication RPCs honor the frozen per-request WhatsApp choice", () => {
  const migrationDirectory = fileURLToPath(new URL("../../supabase/migrations/", import.meta.url));
  const migrations = fs.readdirSync(migrationDirectory)
    .filter((filename) => filename.startsWith("20261023") && filename.endsWith(".sql"))
    .sort()
    .reverse()
    .map((filename) => ({ filename, sql: fs.readFileSync(path.join(migrationDirectory, filename), "utf8") }));
  const migration = migrations.find(({ sql }) =>
    /create or replace function public\.workforce_publish_payout_notifications/i.test(sql)
    && /create or replace function public\.helper_publish_payout_notifications/i.test(sql)
    && /whatsapp_notification_enabled/i.test(sql)
  );

  assert.ok(migration, "A migration must update both Workforce and Helper publication RPCs atomically.");
  assert.match(
    migration.sql,
    /notification_config_snapshot[\s\S]*?whatsapp_notification_enabled[\s\S]*?config_whatsapp_enabled/i,
    "The effective WhatsApp channel must be derived from the frozen publication choice."
  );
  assert.match(
    migration.sql,
    /config_whatsapp_enabled[\s\S]*?(?:and|&&)[\s\S]*?(?:requested|item|snapshot)[\s\S]*?whatsapp/i,
    "Saved WhatsApp configuration and the explicit request choice must both be true before WhatsApp is queued."
  );
  assert.doesNotMatch(
    migration.sql,
    /if\s+not\s+config_whatsapp_enabled\s+and\s+not\s+config_app_enabled\s+then/i,
    "Publishing without WhatsApp or App notification must remain valid."
  );
  assert.match(migration.sql, /if\s+config_whatsapp_enabled\s+then[\s\S]*?whatsapp_profile_id/i);
});

test("Workforce publication accepts configured zero payouts and verifies signed snapshots without a full worksheet reload", () => {
  const publisher = read("../app/api/payments/workforce-payouts/send-review/route.ts");
  const revalidator = read("./workforce-payout-publication-revalidation.ts");
  assert.doesNotMatch(publisher, /loadStablePayoutWorksheet|loadWorkforcePayoutRows|workforcePayoutDependencyHash/);
  assert.match(
    publisher,
    /verifiedPublicationSnapshot\(item\.calculation_snapshot,[\s\S]*?publicationSnapshotHash/,
    "The submitted snapshot must be checked against the hash signed into the review token."
  );
  assert.match(
    publisher,
    /workforcePayoutPublicationSnapshotHash\(snapshot as PublicationSnapshot\)\s*!==\s*expected\.snapshotHash/,
    "A modified browser snapshot must be rejected before publication."
  );
  assert.match(publisher, /workforcePayoutLocationSetHash\(submittedLocations\)[\s\S]*?Select every publishable location row/);
  assert.doesNotMatch(
    publisher,
    /selected\.some\([\s\S]{0,240}(?:gross(?:Payment|Amount)|net(?:Pay|Amount)|workDays|attendance)\s*(?:>|===?)\s*0/,
    "Zero amount, work days, and attendance must not independently block a configured Workforce payout."
  );
  assert.match(
    publisher,
    /const revalidatePublicationEntries = async \(\) => \{[\s\S]*?revalidateWorkforcePayoutPublicationSelections/,
    "The bounded refresh helper must recalculate only the selected Workforce IDs."
  );
  assert.match(
    publisher,
    /result\.error\.message\.includes\(PAYOUT_DEPENDENCY_CHANGED\)[\s\S]*?await revalidatePublicationEntries\(\)/,
    "An atomic dependency conflict must trigger selected-ID recalculation."
  );
  assert.match(revalidator, /loadWorkforcePayoutRows\([\s\S]*?\{ workforceIds \}/);
  assert.match(revalidator, /maxAttempts:\s*3/);
});

test("payout notification publication fails closed to the caller's location scope for Workforce and Helpers", () => {
  const publisher = read("../app/api/payments/workforce-payouts/send-review/route.ts");
  const workforceMigration = read("../../supabase/migrations/20261008010000_workforce_payout_app_notifications.sql");
  const helperMigration = read("../../supabase/migrations/20261010200000_helper_payout_publication_notifications.sql");
  const scopeCheck = publisher.indexOf("allowedLocationIds && normalized.some");
  const helperBranch = publisher.indexOf('subjectTypes.has("helper")');

  assert.match(
    publisher,
    /const allowedLocationScope = authorization\.hasAllLocationAccess[\s\S]*?authorization\.locationScopeIds[\s\S]*?\.filter\(\(locationId\) => UUID\.test\(locationId\)\)/,
    "The route must normalize valid account locations and use an empty scoped list as deny-all."
  );
  assert.ok(scopeCheck >= 0 && scopeCheck < helperBranch, "Every submitted location must be checked before either population is processed.");
  assert.match(publisher, /One or more selected payouts are outside your location scope/);
  assert.equal(publisher.match(/p_locations: allowedLocationScope/g)?.length, 2, "Both publication RPCs must receive the same caller scope.");
  assert.doesNotMatch(publisher, /Send Notification requires all-location access/);
  assert.match(workforceMigration, /p_locations is not null and not \(item_location = any\(p_locations\)\)/);
  assert.match(helperMigration, /p_locations is not null and not \(item_location = any\(p_locations\)\)/);
});

test("a continuously updating full worksheet remains usable but cannot publish before selected-ID revalidation", () => {
  const page = read("../app/payments/workforce-payouts/page.tsx");
  const publisher = read("../app/api/payments/workforce-payouts/send-review/route.ts");
  assert.match(page, /loadStablePayoutWorksheet\(\{[\s\S]*?allowProvisionalOnChurn:\s*true/);
  assert.match(page, /isProvisionalPayoutDependencyHash\(loaded\.dependencyHash\)/);
  assert.match(page, /Every selected payout will be rechecked before its notification is sent/);

  const guard = publisher.indexOf("if (isProvisionalPayoutDependencyHash(expectedDependencyHash))");
  const refresh = publisher.indexOf("await revalidatePublicationEntries()", guard);
  const preflight = publisher.indexOf("await notificationPreflight", guard);
  const atomicPublish = publisher.indexOf('supabaseAdmin.rpc("workforce_publish_payout_notifications"', guard);
  assert.ok(guard >= 0, "The publisher must recognize a provisional worksheet token.");
  assert.ok(refresh > guard, "A provisional worksheet must trigger selected-ID revalidation.");
  assert.ok(preflight > refresh, "Notification values must come from the revalidated selected rows.");
  assert.ok(atomicPublish > preflight, "The atomic publication call must happen only after selected-ID revalidation.");
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
