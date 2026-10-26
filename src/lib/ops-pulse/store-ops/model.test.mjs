import assert from "node:assert/strict";
import test from "node:test";
import { isLocationMailboxRole } from "./location-mailbox.ts";

test("location mailbox roles are OPERATIONS_LOCATION or LOCATION", () => {
  assert.equal(isLocationMailboxRole("OPERATIONS_LOCATION"), true);
  assert.equal(isLocationMailboxRole("LOCATION"), true);
  assert.equal(isLocationMailboxRole("location", []), true);
  assert.equal(isLocationMailboxRole(null, ["OPERATIONS_LOCATION"]), true);
  assert.equal(isLocationMailboxRole("OPERATIONS_SM", ["OPERATIONS_SM"]), false);
  assert.equal(isLocationMailboxRole(null, []), false);
});
