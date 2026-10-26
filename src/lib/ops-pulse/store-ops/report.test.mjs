import assert from "node:assert/strict";
import test from "node:test";
import { resolveStoreOwnerLabel } from "./owner-label.ts";

test("resolveStoreOwnerLabel keeps real people names", () => {
  assert.equal(
    resolveStoreOwnerLabel("R DHARUN RAJ", ["TCC3", "TTA5"]),
    "R DHARUN RAJ",
  );
  assert.equal(resolveStoreOwnerLabel("", ["TCC3"]), "—");
  assert.equal(resolveStoreOwnerLabel(null, ["TCC3"]), "—");
});

test("resolveStoreOwnerLabel marks shared store logins named after station codes", () => {
  assert.equal(
    resolveStoreOwnerLabel("TCC3", ["TCC3", "TTA5", "TTB3"]),
    "Store login · TCC3",
  );
  assert.equal(
    resolveStoreOwnerLabel("tta5", ["TTA5"]),
    "Store login · tta5",
  );
});
