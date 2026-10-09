import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PAYMENT_RECOVERY_IMPORT_HEADERS } from "./payment-recovery-import.ts";

function source(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const importSource = source("./payment-recovery-import.ts");
const bulkUploadRoute = source("../app/api/payments/recoveries/bulk-upload/route.ts");
const bulkUploadComponent = source("../components/payment-recovery-bulk-upload.tsx");
const eligiblePayoutsRoute = source("../app/api/payments/recoveries/eligible-payouts/route.ts");
const configureRoute = source("../app/api/payments/recoveries/configure/route.ts");
const configurator = source("../components/payment-recovery-configurator.tsx");
const registerPage = source("../app/payments/recoveries/page.tsx");
const registerComponent = source("../components/payment-recovery-register.tsx");

test("the recovery workbook keeps the exact TID-level VALUE header contract", () => {
  assert.deepEqual([...PAYMENT_RECOVERY_IMPORT_HEADERS], [
    "TID",
    "LOCATION",
    "DEBIT_MONTH",
    "VALUE",
    "PROVIDER_REFERENCE",
    "REASON",
    "REMARK"
  ]);
  assert.equal(PAYMENT_RECOVERY_IMPORT_HEADERS.filter((header) => header === "VALUE").length, 1);
  assert.doesNotMatch(PAYMENT_RECOVERY_IMPORT_HEADERS.join("\n"), /PROVIDER_CODE|DEBIT_AMOUNT|RECOVERY_METHOD|RECOVERY_IDS/);
  assert.match(importSource, /value:\s*number\s*\|\s*null/);
});

test("bulk upload carries VALUE only and leaves method and IDs for post-upload configuration", () => {
  const rowsPayload = bulkUploadRoute.match(
    /p_rows:\s*parsed\.rows\.map\(\(row\)\s*=>\s*\(\{([\s\S]*?)\}\)\),\s*p_actor_user_id:/
  )?.[1];

  assert.ok(rowsPayload, "expected the payment_recovery_apply_import row payload");
  assert.match(rowsPayload, /value:\s*row\.value/);
  assert.doesNotMatch(rowsPayload, /recovery_method|recovery_ids|dropx_ids/i);
  assert.doesNotMatch(bulkUploadRoute, /RECOVERY_METHOD|RECOVERY_IDS/);
  assert.match(bulkUploadComponent, /select either payout deduction or post-invoice provider dispute from each row/i);
  assert.match(bulkUploadComponent, /<th>Value<\/th>/);
});

test("eligible payouts delegate to the unified RPC with company and location scope", () => {
  assert.match(
    eligiblePayoutsRoute,
    /rpc\(["']payment_recovery_available_payout_months["'],\s*\{[\s\S]*?p_company_id:\s*companyId,[\s\S]*?p_allowed_location_ids:\s*companyWide\s*\?\s*null\s*:\s*authorization\.locationScopeIds[\s\S]*?\}\)/
  );
  assert.match(
    eligiblePayoutsRoute,
    /rpc\(["']payment_recovery_eligible_payout_targets["'],\s*\{[\s\S]*?p_company_id:\s*companyId,[\s\S]*?p_payout_month:\s*`\$\{requestedMonth\}-01`,[\s\S]*?p_allowed_location_ids:\s*companyWide\s*\?\s*null\s*:\s*authorization\.locationScopeIds[\s\S]*?\}\)/
  );
  assert.match(
    eligiblePayoutsRoute,
    /companyWide\s*=\s*authorization\.hasAllLocationAccess\s*\|\|\s*isCompanyOwner\(authorization\)/
  );
  assert.equal((eligiblePayoutsRoute.match(/\.rpc\(/g) ?? []).length, 2);
  assert.match(eligiblePayoutsRoute, /readAllRows\([\s\S]*?payment_recovery_eligible_payout_targets/);
  assert.doesNotMatch(eligiblePayoutsRoute, /supabaseAdmin\.from\(/);
  assert.doesNotMatch(eligiblePayoutsRoute, /calendarMonths|Array\.from\(\{\s*length:\s*61/);
});

test("configuration validates method, month and IDs before one atomic RPC", () => {
  assert.match(configureRoute, /method\s*!==\s*["']payout_deduction["']\s*&&\s*method\s*!==\s*["']post_invoice_dispute["']/);
  assert.match(configureRoute, /method\s*===\s*["']payout_deduction["'][\s\S]*?!MONTH_PATTERN\.test\(payoutMonth\)/);
  assert.match(configureRoute, /!dropxIds\.length/);
  assert.match(configureRoute, /dropxIds\.length\s*>\s*50/);
  assert.match(configureRoute, /else if\s*\(payoutMonth\s*\|\|\s*dropxIds\.length\)/);
  assert.match(configureRoute, /new Set\(requestedIds\.map\(normalizeDropxId\)\.filter\(Boolean\)\)/);
  assert.match(
    configureRoute,
    /rpc\(["']payment_recovery_configure_case["'],\s*\{[\s\S]*?p_company_id:\s*args\.companyId,[\s\S]*?p_recovery_case_id:\s*args\.caseId,[\s\S]*?p_recovery_method:\s*args\.method,[\s\S]*?p_payout_month:[\s\S]*?p_dropx_ids:[\s\S]*?p_actor_user_id:\s*args\.authorization\.userId,[\s\S]*?p_allowed_location_ids:\s*args\.companyWide\s*\?\s*null\s*:\s*args\.authorization\.locationScopeIds[\s\S]*?\}\)/
  );
  assert.equal((configureRoute.match(/rpc\(["']payment_recovery_configure_case["']/g) ?? []).length, 1);
  assert.match(configureRoute, /p_workforce_items:\s*args\.workforceItems/);
  assert.match(configureRoute, /workforce_advance_recovery_snapshot_hash/);
  assert.match(configureRoute, /loadWorkforcePayoutRows/);
  assert.match(configureRoute, /from\(["']payment_recovery_cases["']\)[\s\S]*?select\(["']recovery_method["']\)/);
  assert.match(configureRoute, /if\s*\(await recoveryIsConfigured\(companyId, caseId\)\) return applyAndRespond\(\[\]\)/);
  assert.match(configureRoute, /replayIfConfigured/);
  assert.match(configureRoute, /readAllRows\([\s\S]*?payment_recovery_eligible_payout_targets/);
  assert.doesNotMatch(configureRoute, /\.(?:insert|update|upsert|delete)\(/, "configuration writes must remain inside the atomic database RPC");
  assert.match(configurator, /MAX_SELECTED_IDS\s*=\s*50/);
  assert.match(configurator, /selectedIds\.length\s*>=\s*MAX_SELECTED_IDS/);
});

test("the register exposes unconfigured recoveries and consistently labels the amount as VALUE", () => {
  assert.match(
    registerComponent,
    /recoveryMethod:\s*["']payout_deduction["']\s*\|\s*["']post_invoice_dispute["']\s*\|\s*null;/
  );
  assert.match(registerComponent, /\|\s*["']awaiting_configuration["']/);
  assert.match(registerComponent, /awaiting_configuration:\s*["']Awaiting configuration["']/);
  assert.match(registerPage, /recoveryMethod:\s*recovery\.recovery_method[\s\S]*?\?\s*String\(recovery\.recovery_method\)[\s\S]*?:\s*null/);
  assert.match(registerComponent, /<span>Total value<\/span>/);
  assert.match(registerComponent, /<th className=["']payout-money["']>Value<\/th>/);
  assert.match(registerComponent, /["']VALUE["']/);
});
