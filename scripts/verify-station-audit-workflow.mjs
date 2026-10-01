import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync("src/lib/ops-pulse/station-audits.ts", "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const mod = { exports: {} };
const mocks = {
  "server-only": {},
  "node:crypto": { randomUUID: () => "test-id" },
  "@/lib/supabase-admin": { supabaseAdmin: {} }
};
new Function("require", "module", "exports", js)(id => {
  assert.ok(id in mocks, `unexpected dependency: ${id}`);
  return mocks[id];
}, mod, mod.exports);

const settings = {
  company_id: "company",
  scheduler_role_ids: ["cluster-manager"],
  responder_role_ids: ["station-manager"],
  excluded_location_model_ids: ["now-model"],
  excluded_location_ids: ["excluded-station"],
  exclude_head_office: true
};
const manager = { isMasterOwner: false, isMasterCompany: false, effectiveRoleIds: ["cluster-manager"], permissions: { station_audits: { canAdd: true, canEdit: true } } };
const station = { ...manager, effectiveRoleIds: ["station-manager"] };
assert.equal(mod.exports.canManageStationAudits(manager, settings), true, "configured manager role can run audits");
assert.equal(mod.exports.canManageStationAudits(station, settings), false, "station role cannot run audits");
assert.equal(mod.exports.canManageStationAudits({ ...station, isMasterCompany: true }, settings), false, "master-company membership alone does not expose surprise-audit controls");
assert.equal(mod.exports.canRespondToStationAudits(station, settings), true, "configured station role can respond");
assert.equal(mod.exports.isStationAuditEligible({ id: "station", location_model_id: "standard", is_ho: false }, settings), true);
assert.equal(mod.exports.isStationAuditEligible({ id: "station", location_model_id: "now-model", is_ho: false }, settings), false, "excluded model is not auditable");
assert.equal(mod.exports.isStationAuditEligible({ id: "station", location_model_id: "standard", is_ho: true }, settings), false, "head office is not auditable");
assert.equal(mod.exports.isStationAuditEligible({ id: "excluded-station", location_model_id: "standard", is_ho: false }, settings), false, "station exclusion is applied");

const workspace = fs.readFileSync("src/app/ops-pulse/audits/audit-workspace.tsx", "utf8");
const actions = fs.readFileSync("src/app/ops-pulse/audits/actions.ts", "utf8");
const config = fs.readFileSync("vercel.json", "utf8");
assert.doesNotMatch(workspace, /Generate programme slots|generateStationAuditProgramme/);
assert.match(workspace, /Surprise audits are never shown before completion/);
assert.match(actions, /audit\.status_code !== "awaiting_station_response"/);
assert.match(actions, /canRespondToStationAudits/);
assert.doesNotMatch(config, /station-audits/);
console.log("Station audit workflow passed: configured manager and response roles, HO/model exclusions, surprise-audit privacy and no automatic generation.");
