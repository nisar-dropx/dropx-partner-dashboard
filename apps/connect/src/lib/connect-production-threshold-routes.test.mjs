import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const earningsRoute = readFileSync(new URL("../../app/api/connect/earnings/route.ts", import.meta.url), "utf8");
const workforcePaymentsRoute = readFileSync(new URL("../../app/api/connect/workforce-payments/route.ts", import.meta.url), "utf8");

test("both Connect payment endpoints load effective and method threshold configuration", () => {
  for (const source of [earningsRoute, workforcePaymentsRoute]) {
    assert.match(source, /allocateCombinedProductionThresholds/);
    assert.match(source, /payment_values,production_threshold_config/);
    assert.match(source, /payment_methods\(id,name,production_threshold_config/);
    assert.match(source, /thresholdConfig:mapping\.production_threshold_config/);
    assert.match(source, /methodThresholdConfig:method\?\.production_threshold_config/);
    assert.match(source, /workforceId:String\(workforce\?\.id\?\?account\.id\)/);
  }
});

test("production-configured Connect earnings never use imported totals or rate-card fallback", () => {
  assert.match(earningsRoute, /productionConfigured\?productionAmount:card\?/);
  assert.match(workforcePaymentsRoute, /productionConfigured\s*\?\s*mappedProductionAmount\s*:\s*personalAmounts\.get/);
  assert.doesNotMatch(workforcePaymentsRoute, /mappedProductionAmount\(mapping,/);
});

test("Connect production inputs carry payment-field order into the shared allocator", () => {
  for (const source of [earningsRoute, workforcePaymentsRoute]) {
    assert.match(source, /componentOrder:rule\.order/);
    assert.match(source, /reportedUnits:/);
    assert.match(source, /rate:rule\.rate/);
  }
});
