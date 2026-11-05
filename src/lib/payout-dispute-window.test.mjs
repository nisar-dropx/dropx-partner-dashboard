import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PAYOUT_DISPUTE_HOURS, payoutDisputeHours, payoutDisputeDeadline } from "./payout-dispute-window.ts";
import { payoutReviewState } from "../../apps/connect/src/lib/payout-dispute.ts";

test("48-hour default, presets and custom whole hours preserve exact elapsed time", () => {
  assert.equal(DEFAULT_PAYOUT_DISPUTE_HOURS, 48);
  const start = Date.parse("2026-11-30T18:45:12.345Z");
  for (const hours of [1, 12, 24, 36, 48, 720]) {
    assert.equal(payoutDisputeHours(String(hours)), hours);
    const deadline = payoutDisputeDeadline(hours, start);
    assert.equal(Date.parse(deadline) - start, hours * 3600000);
    const input = { hasPublication: true, runStatus: "review", reviewUntil: deadline };
    assert.equal(payoutReviewState(input, Date.parse(deadline) - 1), "open");
    assert.equal(payoutReviewState(input, Date.parse(deadline)), "expired");
  }
});

test("invalid hours cannot produce a deadline", () => {
  for (const input of [undefined, null, true, false, [], {}, "", " ", "1.5", "1e2", 0, -1, 1.5, 721, Infinity, NaN, "24x"]) {
    assert.throws(() => payoutDisputeHours(input), /whole number/);
  }
});
