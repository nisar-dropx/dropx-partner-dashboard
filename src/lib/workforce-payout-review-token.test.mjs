import assert from "node:assert/strict";
import test from "node:test";

process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-review-token-secret";
const {
  createWorkforcePayoutReviewToken,
  payoutReviewPresentation,
  verifyWorkforcePayoutReviewToken,
  workforcePayoutReviewTokenStatus
} = await import("./workforce-payout-review-token.ts");

const expected = {
  companyId: "00000000-0000-4000-8000-000000000001",
  subjectType: "workforce",
  subjectId: "00000000-0000-4000-8000-000000000002",
  locationId: "00000000-0000-4000-8000-000000000003",
  periodStart: "2026-09-01",
  periodEnd: "2026-09-30"
};

test("review tokens bind a server-calculated ready row to its company, location and period", () => {
  const token = createWorkforcePayoutReviewToken({ ...expected, status: "Ready for review" });
  assert.equal(typeof token, "string");
  assert.equal(verifyWorkforcePayoutReviewToken(token, expected), true);
  assert.equal(workforcePayoutReviewTokenStatus(token, expected), "ready");
  assert.equal(verifyWorkforcePayoutReviewToken(token, { ...expected, locationId: "00000000-0000-4000-8000-000000000004" }), false);
  assert.equal(verifyWorkforcePayoutReviewToken(`${token}x`, expected), false);
});

test("returned rows receive a valid resubmission token", () => {
  const token = createWorkforcePayoutReviewToken({ ...expected, status: "Returned" });
  assert.equal(verifyWorkforcePayoutReviewToken(token, expected), true);
  assert.equal(workforcePayoutReviewTokenStatus(token, expected), "returned");
});

test("persisted review state cannot make a non-ready calculation submit-ready", () => {
  assert.deepEqual(payoutReviewPresentation("Configuration incomplete", "returned"), {
    status: "Returned",
    tokenStatus: null
  });
  assert.deepEqual(payoutReviewPresentation("Ready for review", "returned"), {
    status: "Returned",
    tokenStatus: "Returned"
  });
  assert.deepEqual(payoutReviewPresentation("Ready for review", "under_review"), {
    status: "Under Review",
    tokenStatus: null
  });
});
