import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

test("payout notification settings use payment_settings and the dedicated event code", () => {
  const page = read("../app/settings/workforce-payment/payout-notification/page.tsx");
  const actions = read("../app/settings/workforce-payment/payout-notification/actions.ts");
  const hub = read("../app/settings/workforce-payment/page.tsx");
  assert.match(page, /requirePagePermission\("payment_settings", "access"\)/);
  assert.match(actions, /requirePagePermissionOrThrow\("payment_settings", "edit"\)/);
  assert.match(actions, /from\("whatsapp_notification_configs"\)\.upsert/);
  assert.match(actions, /WORKFORCE_PAYOUT_WHATSAPP_EVENT/);
  assert.match(hub, /\/settings\/workforce-payment\/payout-notification/);
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
  const migration = read("../../supabase/migrations/20261008004000_workforce_payout_notification_publication.sql");
  assert.match(publisher, /normalizeWorkforceWhatsAppRecipient\(person\?\.mobile, person\?\.mobile_country_code\)/);
  assert.match(publisher, /resolved_values: values,\s*recipient/);
  assert.match(migration, /item_notification_snapshot\s*->>\s*'recipient'/);
  assert.match(migration, /item_notification_snapshot\s*->\s*'template_components'\s*=\s*template\.components/);
});
