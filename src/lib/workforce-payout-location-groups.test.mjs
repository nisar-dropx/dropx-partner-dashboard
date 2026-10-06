import assert from "node:assert/strict";
import test from "node:test";
import { groupPayoutItemsBySubjectLocation, payoutSubjectLocationKey } from "./workforce-payout-location-groups.ts";

test("payout items group by subject and location instead of subject alone", () => {
  const groups = groupPayoutItemsBySubjectLocation(
    [
      { workforceId: "worker-1", locationId: "station-a", amount: 100 },
      { workforceId: "worker-1", locationId: "station-b", amount: 200 },
      { workforceId: "worker-1", locationId: "station-a", amount: 50 }
    ],
    (item) => item.workforceId,
    (item) => item.locationId
  );

  assert.deepEqual(groups.map((group) => [
    group.subjectId,
    group.locationId,
    group.items.reduce((sum, item) => sum + item.amount, 0)
  ]), [
    ["worker-1", "station-a", 150],
    ["worker-1", "station-b", 200]
  ]);
});

test("identity keys cannot collide when IDs contain separators", () => {
  assert.notEqual(
    payoutSubjectLocationKey("worker|station", "a"),
    payoutSubjectLocationKey("worker", "station|a")
  );
});
