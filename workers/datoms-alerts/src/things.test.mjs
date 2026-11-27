import test from "node:test";
import assert from "node:assert/strict";
import { mergeThingRows, normalizeThing } from "./things.mjs";

test("normalizeThing maps station from name and keeps allowlisted assets", () => {
  const thing = normalizeThing({
    id: 41225,
    name: "TTA5 Freezer Compressor-1",
    site_name: "TTA5",
    online: true,
    temperature:  -18.2,
    condensing_unit_status: "On"
  });
  assert.ok(thing);
  assert.equal(thing.stationCode, "TTA5");
  assert.equal(thing.thingId, "41225");
  assert.equal(thing.status.condensingUnit, "On");
});

test("normalizeThing drops unknown stations", () => {
  assert.equal(
    normalizeThing({ id: 1, name: "ZZ99 Freezer", site_name: "ZZ99" }),
    null
  );
});

test("mergeThingRows prefers data metrics", () => {
  const merged = mergeThingRows(
    [{ id: "1", name: "TTB3 Chiller", site_name: "TTB3" }],
    [{ id: "1", total_active_power: 2.5 }]
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].total_active_power, 2.5);
  assert.equal(merged[0].name, "TTB3 Chiller");
});
