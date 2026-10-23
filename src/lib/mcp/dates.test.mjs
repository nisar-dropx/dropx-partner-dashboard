import assert from "node:assert/strict";
import test from "node:test";
import { intersectStationCodes, parseIsoDate, parseStationCodes } from "./dates.ts";

test("parseIsoDate accepts valid calendar dates only", () => {
  assert.equal(parseIsoDate("2026-10-23"), "2026-10-23");
  assert.equal(parseIsoDate("2026-02-30"), null);
  assert.equal(parseIsoDate("23-10-2026"), null);
  assert.equal(parseIsoDate(""), null);
});

test("parseStationCodes normalizes and dedupes", () => {
  assert.deepEqual(parseStationCodes(["gdrd", "GDRD", " bom "]), ["GDRD", "BOM"]);
  assert.deepEqual(parseStationCodes("gdrd,bom bom"), ["GDRD", "BOM"]);
});

test("intersectStationCodes blocks out-of-scope stations", () => {
  const result = intersectStationCodes(["GDRD", "BLR"], ["GDRD", "HYD"]);
  assert.deepEqual(result.allowed, ["GDRD"]);
  assert.deepEqual(result.missing, ["HYD"]);
});

test("intersectStationCodes with empty request returns all permitted", () => {
  const result = intersectStationCodes(["GDRD", "BLR"], []);
  assert.deepEqual(result.allowed.sort(), ["BLR", "GDRD"]);
  assert.deepEqual(result.missing, []);
});
