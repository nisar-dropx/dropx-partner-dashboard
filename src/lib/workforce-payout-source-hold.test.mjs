import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeWorkforcePayoutSourceIdentity,
  workforcePayoutSourceIdentityKey
} from "./workforce-payout-source-hold.ts";

test("source payout identity normalizes provider and member spelling without losing station scope", () => {
  const identity = normalizeWorkforcePayoutSourceIdentity({
    stationId: " 71AAB17D-8E63-4EE1-B186-C1F927DF7E5E ",
    providerIdentity: " Amazon - EDSP ",
    providerMemberId: " 37-11 400 629 "
  });
  assert.deepEqual(identity, {
    stationId: "71aab17d-8e63-4ee1-b186-c1f927df7e5e",
    providerIdentity: "AMAZONEDSP",
    providerMemberId: "3711400629"
  });
  assert.equal(
    workforcePayoutSourceIdentityKey(identity),
    "71aab17d-8e63-4ee1-b186-c1f927df7e5e|AMAZONEDSP|3711400629"
  );
});

test("source payout identity rejects incomplete report-only targets", () => {
  assert.equal(normalizeWorkforcePayoutSourceIdentity(undefined), null);
  assert.equal(normalizeWorkforcePayoutSourceIdentity({
    stationId: "station",
    providerIdentity: "",
    providerMemberId: "member"
  }), null);
  assert.equal(workforcePayoutSourceIdentityKey({
    stationId: "",
    providerIdentity: "Amazon",
    providerMemberId: "member"
  }), "");
});
