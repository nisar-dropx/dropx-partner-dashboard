import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeUrl = new URL("./route.ts", import.meta.url);

test("Flipkart production upload replaces the cycle and refreshes payout inputs", async () => {
  const route = await readFile(routeUrl, "utf8");

  assert.match(route, /parseFlipkartProductionMatrix/);
  assert.match(route, /masterData\.parser_type === "flipkart_production"/);
  assert.match(route, /Load Flipkart provider/);
  assert.match(route, /\[provider\.code, provider\.name\][\s\S]{0,180}"FLIPKART"/);
  assert.match(route, /Load permitted historical Flipkart locations/);
  assert.match(route, /permittedStationIds\.has\(location\.id\)/);
  assert.match(route, /Load Flipkart vendor identity/);
  assert.match(route, /const expectedVendorNames = \[companyVendor\.data\.code, companyVendor\.data\.name\]/);
  assert.match(route, /expectedVendorNames,/);
  assert.match(route, /rejectInvalidRows: true/);
  assert.match(route, /requireBothSheetTypes: true/);
  assert.match(route, /requireCompleteCycle: true/);
  assert.match(route, /"replace_flipkart_production_cycle"/);
  assert.match(route, /Apply configured Flipkart payment mappings/);
  assert.match(route, /applyProviderPaymentMappings\(companyId, flipkartFacts, "flipkart", \{/);
  assert.match(route, /replacementScope: \{/);
  assert.match(route, /fromDate: production\.cycle\.startDate/);
  assert.match(route, /stationCodes: uploadedStationCodes/);
  assert.match(route, /toDate: production\.cycle\.endDate/);
  assert.match(route, /strict: true/);
  assert.match(route, /if \(strict\) throw new Error\(`\$\{step\}: \$\{readableError\(error\)\}`\)/);
  assert.match(route, /loadAmazonMappingAttendance\([\s\S]*?mappingScope,\s*replacementScope,\s*strict/);
  assert.match(route, /retainRowsOutsideReportImportReplacement\(existingShipments\.data \?\? \[\], replacementScope\)/);
  assert.match(route, /mapping_status: row\.mapping_status \?\? "Unmapped"/);
  assert.match(route, /da_total_pay: row\.da_total_pay \?\? 0/);
  assert.match(route, /p_cycle_from: production\.cycle\.startDate/);
  assert.match(route, /p_cycle_to: production\.cycle\.endDate/);
  assert.match(route, /total_delivery: row\.delivery/);
  assert.match(route, /c_return: row\.customerReturn/);
  assert.match(route, /total_activity: row\.totalActivity/);
  assert.match(route, /report_from: production\.cycle\.startDate/);
  assert.match(route, /report_to: production\.cycle\.endDate/);
  assert.match(route, /Check existing Flipkart cycle coverage/);
  assert.match(route, /omits Flipkart station/);
  assert.match(route, /no production was changed/);
  assert.match(route, /const stationCodes = uploadedStationCodes/);
  assert.match(route, /row\.sheetTypes\.includes\(sheetType\)/);
  assert.doesNotMatch(route, /Recalculate Flipkart CPS totals/);
});

test("Flipkart source rows retain audit outcomes while zero production remains valid", async () => {
  const route = await readFile(routeUrl, "utf8");

  assert.match(route, /Save Flipkart import audit rows/);
  assert.match(route, /Superseded duplicate row; the newest sheet_update_date_time was used/);
  assert.match(route, /invalid row/);
  assert.doesNotMatch(route, /row\.totalActivity\s*>\s*0/);
});
