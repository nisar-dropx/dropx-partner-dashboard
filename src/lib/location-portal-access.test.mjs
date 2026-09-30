import assert from "node:assert/strict";
import test from "node:test";
import { applyBulkPortalAccess, normalizePortalCodes, portalAccessChanged } from "./location-portal-access.ts";

test("portal codes are normalized for stable dirty checks", () => {
  assert.deepEqual(normalizePortalCodes(["Workforce", "people", "people"]), ["people", "workforce"]);
  assert.equal(portalAccessChanged(["people", "workforce"], ["workforce", "people"]), false);
  assert.equal(portalAccessChanged(["people"], ["people", "recruit"]), true);
});

test("bulk access changes only the selected locations", () => {
  const draft = {
    a: ["people"],
    b: ["operations"],
    c: ["recruit"]
  };

  const enabled = applyBulkPortalAccess(draft, ["a", "b"], "workforce", true);
  assert.deepEqual(enabled.a, ["people", "workforce"]);
  assert.deepEqual(enabled.b, ["operations", "workforce"]);
  assert.deepEqual(enabled.c, ["recruit"]);

  const disabled = applyBulkPortalAccess(enabled, ["a"], "people", false);
  assert.deepEqual(disabled.a, ["workforce"]);
  assert.deepEqual(draft.a, ["people"], "the original draft remains unchanged");
});
