import test from "node:test";
import assert from "node:assert/strict";
import {
  clusterMayAct,
  lifecycleLabel,
  lossesDeepLink,
  slpMayAct,
  stationMayAct,
} from "./nl-loss-lifecycle-policy.ts";

test("station actors may only clarify", () => {
  assert.equal(stationMayAct("clarify"), true);
  assert.equal(stationMayAct("propose"), false);
  assert.equal(stationMayAct("approve"), false);
});

test("cluster and SLP action sets stay distinct", () => {
  assert.equal(clusterMayAct("propose"), true);
  assert.equal(clusterMayAct("approve"), false);
  assert.equal(slpMayAct("approve"), true);
  assert.equal(slpMayAct("propose"), false);
});

test("deep links stay on existing Losses routes", () => {
  assert.equal(
    lossesDeepLink({
      report: "slp",
      month: "2026-10",
      station: "BLR1",
      lifecycle: "cluster_validation_pending",
    }),
    "/team-ops/losses/slp?month=2026-10&station=BLR1&lifecycle=cluster_validation_pending",
  );
  assert.equal(lifecycleLabel("slp_final_confirmation_pending"), "Awaiting SLP confirmation");
});
