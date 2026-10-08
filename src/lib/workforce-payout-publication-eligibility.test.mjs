import assert from "node:assert/strict";
import test from "node:test";

import {
  isWorkforcePayoutCalculationPublishable,
  isWorkforcePayoutDisplayPublishable
} from "./workforce-payout-publication-eligibility.ts";

test("configured zero payouts remain publishable regardless of amount or attendance", () => {
  for (const status of [
    "Ready for review",
    "No eligible accrual",
    "No eligible attendance",
    "Awaiting production"
  ]) {
    assert.equal(isWorkforcePayoutCalculationPublishable(status), true, status);
    assert.equal(isWorkforcePayoutDisplayPublishable(status), true, status);
  }
  assert.equal(isWorkforcePayoutDisplayPublishable("Returned"), true);
});

test("incomplete, unmapped and already published payouts remain blocked", () => {
  for (const status of [
    "Configuration incomplete",
    "Payment method not allocated",
    "ID not mapped",
    "Mapping conflict",
    "Under Review",
    "Payment published",
    "Notification queued"
  ]) {
    assert.equal(isWorkforcePayoutCalculationPublishable(status), false, status);
    assert.equal(isWorkforcePayoutDisplayPublishable(status), false, status);
  }
});
