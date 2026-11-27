import test from "node:test";
import assert from "node:assert/strict";
import { mergeThingRows, normalizeThing, panelMetricList } from "./things.mjs";

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

test("normalizeThing reads parameters[] live metrics like Datoms panel", () => {
  const thing = normalizeThing({
    id: 41225,
    name: "TTB3 Chiller Compressor",
    site_name: "TTB3",
    online: true,
    parameters: [
      { key: "mc_st", name: "Machine Status", unit: "", value: "1", type: "status" },
      { key: "mvol", name: "Avg L-N Voltage", unit: "V", value: "240.6" },
      { key: "mt_power", name: "Total Active Power", unit: "kW", value: "2.71" }
    ]
  });
  assert.ok(thing);
  assert.equal(thing.status.condensingUnit, "On");
  const panel = panelMetricList(thing.metrics, { limit: 4 });
  assert.equal(panel[0].key, "mvol");
  assert.equal(panel[0].label, "Avg L-N Voltage");
  assert.equal(panel[0].value, "240.6");
});

test("mergeThingRows prefers data values but keeps list labels", () => {
  const merged = mergeThingRows(
    [{
      id: "1",
      name: "TTB3 Chiller",
      site_name: "TTB3",
      parameters: [{ key: "mvol", name: "Avg L-N Voltage", unit: "V", value: "230" }]
    }],
    [{
      id: "1",
      total_active_power: 2.5,
      parameters: [{ key: "mvol", name: "mvol", unit: "", value: "241" }]
    }]
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].total_active_power, 2.5);
  assert.equal(merged[0].name, "TTB3 Chiller");
  assert.equal(merged[0].parameters[0].name, "Avg L-N Voltage");
  assert.equal(merged[0].parameters[0].value, "241");
});
