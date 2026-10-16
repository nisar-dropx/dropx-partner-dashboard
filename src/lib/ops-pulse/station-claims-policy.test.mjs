import assert from "node:assert/strict";
import test from "node:test";
import { claimActions, claimNoteError, validateClaim } from "./station-claims-policy.ts";

test("only a cluster manager who did not raise it decides a claim", () => {
  assert.deepEqual(claimActions({ status: "submitted", raisedBy: "s" }, "cm", true, false), ["approve", "return", "reject"]);
  assert.deepEqual(claimActions({ status: "submitted", raisedBy: "cm" }, "cm", true, true), ["withdraw"]);
  assert.deepEqual(claimActions({ status: "submitted", raisedBy: "s" }, "x", false, true), []);
  assert.deepEqual(claimActions({ status: "returned", raisedBy: "s" }, "s", false, true), ["resubmit", "withdraw"]);
  assert.deepEqual(claimActions({ status: "approved", raisedBy: "s" }, "cm", true, true), []);
});

const ok = { stationId: "00000000-0000-4000-8000-000000000001", reference: "BLR-CASH-01", incidentDate: "2026-10-10", category: "cash_shortage", amount: "800", description: "Cash short at day close", evidenceUrl: "", people: "" };

test("claim validation matches the database", () => {
  assert.equal(validateClaim(ok, "2026-10-16"), "");
  assert.match(validateClaim({ ...ok, incidentDate: "2026-10-17" }, "2026-10-16"), /180 days/);
  assert.match(validateClaim({ ...ok, incidentDate: "2026-01-01" }, "2026-10-16"), /180 days/);
  assert.match(validateClaim({ ...ok, reference: "a b" }, "2026-10-16"), /reference/);
  assert.match(validateClaim({ ...ok, amount: "0" }, "2026-10-16"), /amount/);
  assert.match(validateClaim({ ...ok, evidenceUrl: "http://x" }, "2026-10-16"), /https/);
  assert.match(validateClaim({ ...ok, category: "x" }, "2026-10-16"), /category/);
  assert.match(validateClaim({ ...ok, description: "short" }, "2026-10-16"), /Describe/);
});

test("returning or rejecting needs a reason", () => {
  assert.equal(claimNoteError("approve", ""), "");
  assert.match(claimNoteError("return", "no"), /at least 5/);
});
