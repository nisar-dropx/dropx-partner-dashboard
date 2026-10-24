import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const module = { exports: {} };
const code = ts.transpileModule(readFileSync(new URL("./adhoc-vehicle-policy.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
new Function("exports", "module", code)(module.exports, module);
const {
  evaluateAdhocOutOnRoad,
  isBreakdownVehicleReason,
  normalizeAdhocVehicleNo,
  usesAdhocVehicleDropdown,
} = module.exports;

test("normalizeAdhocVehicleNo strips spaces and uppercases", () => {
  assert.equal(normalizeAdhocVehicleNo(" kl 01 ab 1234 "), "KL01AB1234");
});

test("breakdown vehicle uses plate path, not dropdown", () => {
  assert.equal(isBreakdownVehicleReason({ reason_key: "breakdown_vehicle" }), true);
  assert.equal(usesAdhocVehicleDropdown({ reason_key: "breakdown_vehicle", source_code: "OWN" }), false);
  assert.equal(usesAdhocVehicleDropdown({ reason_key: "company_breakdown", source_code: "OWN" }), true);
  assert.equal(usesAdhocVehicleDropdown({ reason_key: "high_volume", source_code: null }), false);
  assert.equal(usesAdhocVehicleDropdown({ reason_key: "connection_vehicle", source_code: null }), false);
});

test("out-on-road accepts in_transit, GPS km, or fleet breakdown status", () => {
  assert.equal(evaluateAdhocOutOnRoad({ status: "active", locationType: "in_transit" }).ok, true);
  assert.equal(evaluateAdhocOutOnRoad({ status: "active", locationType: "station", gpsKm: 12 }).ok, true);
  assert.equal(evaluateAdhocOutOnRoad({ status: "breakdown", locationType: "workshop", gpsKm: 0 }).ok, true);
  assert.equal(evaluateAdhocOutOnRoad({ status: "under_service", locationType: "station" }).evidence, "fleet_status");
});

test("out-on-road rejects parked active vans without GPS", () => {
  const parked = evaluateAdhocOutOnRoad({ status: "active", locationType: "station", gpsKm: 0 });
  assert.equal(parked.ok, false);
  assert.match(parked.error || "", /out on road/i);
  assert.equal(evaluateAdhocOutOnRoad({ status: "active", locationType: "workshop", unavailable: true }).ok, false);
});
