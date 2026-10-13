import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const modal = await readFile(new URL("../../../../../components/workforce-payout-payment-history-button.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../../../../../app/globals.css", import.meta.url), "utf8");

test("Workforce paid history follows effective credit ownership while Helper history stays physical", () => {
  assert.match(route, /audience === "workforce"[\s\S]*?physicalItemsQuery\.neq\("status", "paid"\)/);
  assert.match(route, /from\("workforce_payout_effective_paid_allocations"\)/);
  assert.match(route, /\.eq\("credited_workforce_id", workforceId\)/);
  assert.match(route, /\.eq\("station_id", stationId\)/);
  assert.match(route, /aggregateEffectivePaidHistory/);
  assert.match(route, /audience === "helpers"[\s\S]*?from\("helper_payout_payment_items"\)/);
  assert.match(route, /creditTransfer: null/);
});

test("history response and modal distinguish paid credit from immutable bank evidence", () => {
  assert.match(route, /from\("workforce_payout_payment_credit_transfers"\)/);
  assert.match(route, /\.eq\("source_workforce_id", workforceId\)/);
  assert.match(route, /creditTransfers: transferOutMarkers\.map/);
  assert.match(route, /original,[\s\S]*?credited/);
  assert.match(modal, /Paid credit transferred in/);
  assert.match(modal, /original reference and UTR are unchanged/);
  assert.match(modal, /Paid-credit transfer audit/);
  assert.match(modal, /Credit transferred out/);
  assert.match(modal, /bank payment itself was not changed/);
});

test("payment history bypasses browser and server response caches", () => {
  assert.match(route, /export const dynamic = "force-dynamic"/);
  assert.match(route, /"Cache-Control": "private, no-store"/);
  assert.match(modal, /fetch\(`\/api\/payments\/workforce-payouts\/payment-history\?\$\{query\}`, \{\s*cache: "no-store",\s*signal/);
});

test("payment history returns immutable settlement evidence and location code only", () => {
  assert.match(route, /instruction_amount,settled_amount,status/);
  assert.match(route, /response_debit_account_no,response_value_date,response_credit_account_no,response_ifsc/);
  assert.match(route, /response_ifsc,location_code_snapshot,bank_processing_remarks/);
  assert.match(route, /bank_processing_remarks,finalization_remarks,response_import_id/);
  assert.match(route, /instruction_amount_snapshot,settled_amount_snapshot/);
  assert.match(route, /select\("id,bank_id,status,debit_account_no_snapshot,value_date,generated_at"\)/);
  assert.match(route, /maskedDebitAccount: maskedAccount\(debitAccount\)/);
  assert.match(route, /creditAccount = text\(item\.response_credit_account_no\)[\s\S]*?text\(item\.bank_account_no_snapshot\)/);
  assert.match(route, /creditIfsc = text\(item\.response_ifsc\) \|\| text\(item\.ifsc_snapshot\)/);
  assert.match(route, /valueDate: text\(item\.response_value_date\) \|\| text\(batch\?\.value_date\)/);
  assert.match(route, /status: paid && amount \+ 0\.0001 < safeInstruction \? "partially_paid"/);
  assert.match(route, /\.select\("id,station_code"\)/);
  assert.match(route, /locationCode: item\.locationCodeSnapshot \|\| location \|\| ""/);
  assert.doesNotMatch(route, /station_name|locationName/);
});

test("payment history is viewable within the signed-in account location scope", () => {
  assert.match(route, /hasPermission\(authorization, pageCode, "access"\)/);
  assert.doesNotMatch(route, /hasPermission\(authorization, pageCode, "edit"\)/);
  assert.doesNotMatch(route, /hasPermission\(authorization, "payment_process", "edit"\)/);
  assert.match(route, /!authorization\.hasAllLocationAccess && !authorization\.locationScopeIds\.some\([\s\S]*?=== stationId\)/);
  assert.match(route, /outside your account access/);
  assert.match(route, /authorization\.hasAllLocationAccess[\s\S]*?\? holdQuery[\s\S]*?: Promise\.resolve\(\{ data: \[\], error: null \}\)/);
  assert.match(route, /Do not disclose their remarks to a location-scoped viewer/);
});

test("read-only payment history hides every payment mutation and download action", () => {
  assert.match(modal, /canManageStatus && entry\.redownloadable[\s\S]*?Download again/);
  assert.match(modal, /\{canManageStatus \? <td>[\s\S]*?>Finalize<\/button>[\s\S]*?Payment Failed[\s\S]*?Payment Cancelled/);
  assert.doesNotMatch(modal, /Mark on hold|Release hold/);
});

test("bank payment history uses the full desktop width without displaying a separate version label", () => {
  assert.match(modal, /bank-payment-history-modal/);
  assert.match(modal, /\{entry\.referenceNo\}/);
  assert.doesNotMatch(modal, /<small>Version \{entry\.version\}<\/small>/);
  assert.match(styles, /\.modal-panel\.payment-history-modal\.bank-payment-history-modal\s*\{\s*width:\s*min\(1540px,\s*calc\(100vw - 32px\)\);\s*\}/);
});
