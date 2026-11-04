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
  eligibleAdhocVehicles,
  evaluateAdhocOutOnRoad,
  isBreakdownVehicleReason,
  normalizeAdhocVehicleNo,
  usesAdhocVehicleDropdown,
} = module.exports;

test("normalizeAdhocVehicleNo strips spaces and uppercases", () => {
  assert.equal(normalizeAdhocVehicleNo(" kl 01 ab 1234 "), "KL01AB1234");
});

test("breakdown uses Fleet selection; unrelated reasons do not ask for a breakdown vehicle", () => {
  for (const key of ["company_breakdown", "vendor_breakdown", "odcd_breakdown", "breakdown_vehicle"]) {
    assert.equal(isBreakdownVehicleReason({ reason_key: key }), true);
    assert.equal(usesAdhocVehicleDropdown({ reason_key: key, source_code: "OWN" }), true);
  }
  for (const key of ["high_volume", "connection_vehicle"]) {
    assert.equal(isBreakdownVehicleReason({ reason_key: key }), false);
    assert.equal(usesAdhocVehicleDropdown({ reason_key: key, source_code: null }), false);
  }
});

test("Fleet Breakdown is mandatory even with GPS movement, transit or service status", () => {
  for (const status of ["active", "under_service", "on_leave"]) {
    const result = evaluateAdhocOutOnRoad({ status, locationType: "in_transit", gpsKm: 12 });
    assert.equal(result.ok, false);
    assert.match(result.error, /marked Breakdown in Fleet/);
  }
  assert.equal(evaluateAdhocOutOnRoad({ status: "breakdown", locationType: "workshop", gpsKm: 0 }).evidence, "fleet_status");
  assert.equal(evaluateAdhocOutOnRoad({ status: "breakdown", unavailable: true }).ok, false);
});

test("all breakdown reasons strictly filter Fleet, source, date and existing replacements", () => {
  for (const reason_key of ["company_breakdown", "vendor_breakdown", "odcd_breakdown", "breakdown_vehicle"]) {
    const rule = { reason_key, source_code: "OWN", required_statuses: [] };
    const vehicle = { id: "eligible", source: "OWN", status: "breakdown", deploymentDate: "2026-10-01", unavailable: false };
    const candidates = [vehicle, ...[{status:"active"}, {status:"under_service"}, {source:"VNV"}, {unavailable:true}, {deploymentDate:"2026-12-01"}].map((patch,i)=>({...vehicle,id:`bad${i}`,...patch}))];
    assert.deepEqual(eligibleAdhocVehicles(rule, candidates, "2026-11-04").map(v=>v.id), ["eligible"]);
  }
  assert.equal(eligibleAdhocVehicles({reason_key:"odcd_absent",source_code:"ODCD",required_statuses:[]}, [{source:"ODCD",status:"active",deploymentDate:"2026-10-01",unavailable:false}], "2026-11-04").length, 1);
});
