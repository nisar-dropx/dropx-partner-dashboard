import assert from "node:assert/strict";
import test from "node:test";

import {
  decodePayoutReviewReason,
  payoutNotificationStatusLabel,
  visiblePayoutDisputeEvents
} from "./payout-review-display.ts";

test("decodes dispute areas and omits the duplicated opening event", () => {
  const stored = "Dispute areas: Work Days, Delivery\n\nThe delivery total is low.";
  assert.deepEqual(decodePayoutReviewReason(stored), {
    areas: ["Work Days", "Delivery"],
    reason: "The delivery total is low."
  });
  assert.deepEqual(visiblePayoutDisputeEvents([
    { id: "opening", message: stored },
    { id: "reply", message: "We are checking it." }
  ], stored), [{ id: "reply", message: "We are checking it." }]);
});

test("uses operationally accurate WhatsApp publication labels", () => {
  assert.equal(payoutNotificationStatusLabel("sent"), "Accepted by WhatsApp");
  assert.equal(payoutNotificationStatusLabel("superseded"), "Included in the worker's combined notification");
  assert.equal(payoutNotificationStatusLabel("pending"), "Queued for WhatsApp");
});
