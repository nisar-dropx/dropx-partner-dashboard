import test from "node:test";
import assert from "node:assert/strict";
import {
  biometricIdBelongsOnlyToProfile,
  helperBiometricIdVariants,
  normalizeHelperBiometricId,
  uniqueHelperByBiometricId
} from "./helper-payout.ts";

test("normalizes helper biometric ids across device padding variants", () => {
  assert.equal(normalizeHelperBiometricId("00230878"), "230878");
  assert.equal(normalizeHelperBiometricId("000000"), "0");
  assert.deepEqual(helperBiometricIdVariants(["00230878"]), ["00230878", "230878"]);
  assert.deepEqual(helperBiometricIdVariants(["77"]), ["77", "000077", "00000077"]);
});

test("only resolves a biometric id when it belongs to one helper", () => {
  const unique = { id: "helper-1", biometric_id: "00077" };
  const duplicateA = { id: "helper-2", biometric_id: "88" };
  const duplicateB = { id: "helper-3", biometric_id: "000088" };
  const result = uniqueHelperByBiometricId([unique, duplicateA, duplicateB]);

  assert.equal(result.helperByBiometricId.get("77"), unique);
  assert.equal(result.helperByBiometricId.has("88"), false);
  assert.deepEqual(result.duplicateBiometricIds, ["88"]);
});

test("fails closed when another profile owns the Helper biometric id", () => {
  assert.equal(biometricIdBelongsOnlyToProfile("helper-1", "worker", [{ id: "helper-1", source: "worker" }]), true);
  assert.equal(biometricIdBelongsOnlyToProfile("helper-1", "worker", [
    { id: "helper-1", source: "worker" },
    { id: "worker-1", source: "workforce" }
  ]), false);
  assert.equal(biometricIdBelongsOnlyToProfile("helper-1", "worker", [{ id: "helper-2", source: "worker" }]), false);
});
