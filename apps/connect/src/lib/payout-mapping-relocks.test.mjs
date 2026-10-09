import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  loadPayoutMappingRevisionState,
  payoutMappingPeriodKey,
  payoutMappingPublicationState,
  payoutMappingRevisionState,
} from "./payout-mapping-relocks.ts";

const worker = "0d87be1e-b759-4e39-9e7f-b7dfbd2c1741";
const stationA = "fb63b3b3-5a9a-4482-97a0-e48b42ffba94";
const stationB = "8bf79e1e-3e9b-4867-9a93-cb326cd8dd9f";
const relock = "0b5ed6eb-fbf1-4707-8300-a07569fe87e2";

test("mapping revision state uses the exact-period RPC projection", () => {
  const state = payoutMappingRevisionState([
    {
      period_start: "2026-09-01",
      period_end: "2026-09-30",
      revision_pending: true,
      active_station_ids: [stationB, stationB],
      mapping_relock_id: relock,
    },
    {
      period_start: "2026-08-01",
      period_end: "2026-08-31",
      revision_pending: false,
      active_station_ids: null,
    },
  ]);

  assert.equal(payoutMappingPeriodKey("2026-09-01", "2026-09-30"), "2026-09-01|2026-09-30");
  assert.deepEqual([...state.openPeriodKeys], ["2026-09-01|2026-09-30"]);
  assert.deepEqual([...state.activeStationIdsByPeriod.get("2026-09-01|2026-09-30")], [stationB]);
  assert.equal(state.mappingRelockIdsByPeriod.get("2026-09-01|2026-09-30"), relock);
  assert.deepEqual(payoutMappingPublicationState(state, "2026-09-01", "2026-09-30", stationA, relock), {
    revisionPending: true,
    visible: false,
  });
  assert.deepEqual(payoutMappingPublicationState(state, "2026-09-01", "2026-09-30", stationB, relock), {
    revisionPending: true,
    visible: true,
  });
  assert.deepEqual(payoutMappingPublicationState(state, "2026-08-01", "2026-08-31", stationA, null), {
    revisionPending: false,
    visible: true,
  });
});

test("affected workers with no active location fail closed after relock", () => {
  const state = payoutMappingRevisionState([{
    period_start: "2026-09-01",
    period_end: "2026-09-30",
    revision_pending: false,
    active_station_ids: [],
    mapping_relock_id: relock,
  }]);

  assert.equal(payoutMappingPublicationState(state, "2026-09-01", "2026-09-30", stationA, relock).visible, false);
});

test("invalid periods never acquire revision or station restrictions", () => {
  const state = payoutMappingRevisionState([]);
  assert.equal(payoutMappingPeriodKey("2026-09-01", ""), "");
  assert.deepEqual(payoutMappingPublicationState(state, "2026-09-01", "", stationA, null), {
    revisionPending: false,
    visible: true,
  });
});

test("an existing new owner receives the source unlock's pending state from the RPC", async () => {
  const calls = [];
  const db = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      return {
        error: null,
        data: [{
          period_start: "2026-09-01",
          period_end: "2026-09-30",
          revision_pending: true,
          active_station_ids: [stationB],
          mapping_relock_id: relock,
        }],
      };
    },
  };

  const state = await loadPayoutMappingRevisionState(db, "company-a", worker);
  assert.deepEqual(calls, [{
    name: "workforce_payout_mapping_revision_state",
    args: { p_company_id: "company-a", p_workforce_id: worker },
  }]);
  assert.deepEqual(payoutMappingPublicationState(state, "2026-09-01", "2026-09-30", stationB, relock), {
    revisionPending: true,
    visible: true,
  });
  assert.equal(payoutMappingPublicationState(state, "2026-09-01", "2026-09-30", stationA, relock).visible, false);
});

test("a same-station publication read before relock commit is hidden by lineage", () => {
  const state = payoutMappingRevisionState([{
    period_start: "2026-09-01",
    period_end: "2026-09-30",
    revision_pending: false,
    active_station_ids: [stationA],
    mapping_relock_id: relock,
  }]);

  assert.equal(
    payoutMappingPublicationState(state, "2026-09-01", "2026-09-30", stationA, null).visible,
    false,
    "the pre-relock publication must not survive a same-station relock race",
  );
  assert.equal(
    payoutMappingPublicationState(state, "2026-09-01", "2026-09-30", stationA, relock).visible,
    true,
    "the relock publication and later refreshes inheriting its lineage remain visible",
  );
  assert.equal(
    payoutMappingPublicationState(
      state,
      "2026-09-01",
      "2026-09-30",
      stationA,
      "33e355b8-c2f0-4707-921c-ec40612a8e18",
    ).visible,
    false,
  );
});

test("DropX One loader and dispute endpoint enforce the same mapping revision state", () => {
  const helper = readFileSync(new URL("./payout-mapping-relocks.ts", import.meta.url), "utf8");
  const loader = readFileSync(new URL("./associate-payouts.ts", import.meta.url), "utf8");
  const disputeRoute = readFileSync(new URL("../../app/api/connect/payout-review/route.ts", import.meta.url), "utf8");

  assert.match(helper, /rpc\("workforce_payout_mapping_revision_state", \{[\s\S]+p_company_id: companyId,[\s\S]+p_workforce_id: workforceId/);
  assert.doesNotMatch(helper, /from\("workforce_payout_mapping_unlocks"\)|from\("workforce_payout_mapping_relocks"\)/);
  assert.match(loader, /if \(!mappingRevision\.visible\) continue;/);
  assert.match(loader, /revisionPending: mappingRevision\.revisionPending/);
  assert.match(loader, /publication\.mapping_relock_id/);
  assert.match(loader, /publication\?\.mapping_relock_id/);
  assert.match(disputeRoute, /revision,mapping_relock_id/);
  assert.match(disputeRoute, /publication\.data\.mapping_relock_id/);
  assert.match(disputeRoute, /if\(mappingRevision\.revisionPending\)throw new Error/);
  assert.match(disputeRoute, /if\(!mappingRevision\.visible\)throw new Error/);
  assert.ok(disputeRoute.indexOf("mappingRevision.revisionPending") < disputeRoute.indexOf("workforce_raise_payout_dispute"));
});
