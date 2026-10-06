import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./workforce-payout-table.tsx", import.meta.url), "utf8");

test("payout breakup identifies an aggregate attendance value by quantity and effective range", () => {
  assert.match(source, /Uploaded attendance range/);
  assert.match(source, /range\.quantity/);
  assert.match(source, /range\.effectiveFrom/);
  assert.match(source, /range\.effectiveTo/);
});
