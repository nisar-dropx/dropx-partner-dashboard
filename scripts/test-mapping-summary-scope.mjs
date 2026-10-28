import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

function load(path, imports = {}) {
  const output = ts.transpileModule(fs.readFileSync(path, "utf8"), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  const module = {exports:{}};
  new Function("require", "module", "exports", output)(name => imports[name], module, module.exports);
  return module.exports;
}
const policy = load("src/lib/workforce-register-policy.ts");
const {includeMappingSummaryStation: included} = load("src/lib/provider-mapping-summary-scope.ts", {"./workforce-register-policy":policy});
assert.equal(included({id:"ho", is_ho:true}), false);
for (const code of ["HO", "DROPX_HO", "HEAD OFFICE"]) {
  assert.equal(included({id:"ho", location_models:{code}}), false);
}
for (const code of ["NOW", "AMAZON_NOW"]) {
  assert.equal(included({id:"now", providers:[{name:"Amazon"}], location_models:[{code}]}), false);
}
for (const code of ["EDSP", "XPT", "AMXL"]) {
  assert.equal(included({id:"delivery", providers:{name:"Amazon"}, location_models:{code}}), true);
}
assert.equal(included({id:"other", providers:null, location_models:null}), true);
const page = fs.readFileSync("src/app/provider-id-mapping/summary/page.tsx", "utf8");
assert.match(page, /allowed\(station.id\) && includeMappingSummaryStation\(station\)/);
assert.match(page, /includedStationIds.has\(mapping.station_id\)/);
assert.match(page, /includedStationCodes.has\(String\(source.station_code/);
console.log("Mapping Summary excludes HO and Amazon Now from stations, mappings and source activity.");
