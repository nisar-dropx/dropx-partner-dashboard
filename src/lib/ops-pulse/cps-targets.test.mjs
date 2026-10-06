import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
const module = { exports: {} };
new Function("module", "exports", ts.transpileModule(readFileSync(new URL("./cps-targets.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(module, module.exports);
const { applyCpsTargets } = module.exports;
const stations = [
  { id: "a", station_code: "A" },
  { id: "x", station_code: "X", parent_station_id: "a", location_models: [{code:"XPT"}] },
  { id: "b", station_code: "B", parent_station_id: "a", location_models: {code:"EDSP"} },
];
const revision = (station_code, target_cps, effective_from = "2026-09-01", is_active = true) => ({ station_code, target_cps, effective_from, is_active });
const day = (station_code, work_date = "2026-09-01") => ({station_code, work_date, target:999});
test("parent target applies equally to the parent and XPT, overriding stale XPT targets", () => {
  const rows = [day("A"), day("X"), day("B")];
  const result = applyCpsTargets(rows, [revision("A", "14"), revision("X", 50), revision("B", 20)], stations);
  assert.deepEqual(result.map(r => r.target), [14, 14, 20]);
  assert.equal(rows[0].target, 999, "input snapshots remain immutable");
});
test("effective revisions preserve history and ignore inactive or future revisions", () => {
  const rows = [day("X", "2026-08-31"), day("X"), day("X", "2026-09-16"), day("X", "2026-09-30")];
  const result = applyCpsTargets(rows, [revision("A", 14), revision("A", 12, "2026-09-16"), revision("A", 1, "2026-09-20", false), revision("A", 20, "2026-10-01")], stations);
  assert.deepEqual(result.map(r => r.target), [null, 14, 12, 12]);
});
test("missing parent targets stay unconfigured; targets cannot create unauthorized financial rows", () => {
  const result = applyCpsTargets([day("X")], [revision("X", 50)], stations);
  assert.deepEqual(result, [{...day("X"),target:null}]);
});
