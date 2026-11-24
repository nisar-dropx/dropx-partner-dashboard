import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDsStoreMeta,
  changeDsScope,
  dsRegionKey,
  dsScopeOptions,
  emptyDsScope,
  scopedDsStationCodes
} from "./ds-scope.ts";

const stores = buildDsStoreMeta([
  { code: "TCC3", name: "Adayar", city: "Chennai", state: "TN" },
  { code: "TCD4", name: "Nesapakkam", city: "Chennai", state: "TN" },
  { code: "TTA5", name: "Moosapet", city: "Hyderabad", state: "TS" },
  { code: "TZC4", name: "Cooperganj", city: "Kanpur", state: "UP" }
]);

const managers = [
  { value: "city:a", label: "Asha (City)", stations: ["TCC3", "TCD4"] },
  { value: "rm:b", label: "Bala (Regional)", stations: ["TCC3", "TCD4", "TTA5"] },
  { value: "city:c", label: "Chetan (City)", stations: ["TZC4"] }
];

test("region keys use city · state", () => {
  assert.equal(dsRegionKey("Chennai", "TN"), "Chennai · TN");
  assert.equal(dsRegionKey("Hyderabad", null), "Hyderabad");
  assert.equal(dsRegionKey(null, null), "Unmapped");
});

test("Chennai region narrows stores and city managers", () => {
  const scope = { ...emptyDsScope(), regions: ["Chennai · TN"] };
  assert.deepEqual(scopedDsStationCodes(stores, managers, scope), ["TCC3", "TCD4"]);
  const options = dsScopeOptions(stores, managers, scope);
  assert.deepEqual(options.clusters.map((c) => c.value), ["city:a", "rm:b"]);
  assert.deepEqual(options.stations, ["TCC3", "TCD4"]);
});

test("city manager filter intersects region without inventing stores", () => {
  const next = changeDsScope(stores, managers, { regions: ["Chennai · TN"], clusters: [], stations: [] }, "clusters", ["city:a"]);
  assert.deepEqual(scopedDsStationCodes(stores, managers, next), ["TCC3", "TCD4"]);
  const narrowed = changeDsScope(stores, managers, next, "stations", ["TCC3"]);
  assert.deepEqual(scopedDsStationCodes(stores, managers, narrowed), ["TCC3"]);
});

test("incompatible region clears child manager and store selections", () => {
  const prior = { regions: ["Chennai · TN"], clusters: ["city:a"], stations: ["TCC3"] };
  const next = changeDsScope(stores, managers, prior, "regions", ["Kanpur · UP"]);
  assert.deepEqual(next, { regions: ["Kanpur · UP"], clusters: [], stations: [] });
  assert.deepEqual(scopedDsStationCodes(stores, managers, next), ["TZC4"]);
});
