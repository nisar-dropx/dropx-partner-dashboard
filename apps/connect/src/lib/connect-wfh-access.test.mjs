import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function loadAccess() {
  const mod = { exports: {} };
  const source = readFileSync(new URL("./connect-wfh-access.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  new Function("require", "module", "exports", code)((id) => {
    if (id === "server-only") return {};
    if (id === "./supabase-admin") return { supabaseAdmin: null };
    throw new Error(`Unexpected dependency ${id}`);
  }, mod, mod.exports);
  return mod.exports;
}

const { connectWfhEligible, resolveConnectWfhAccess } = loadAccess();
const policy = {
  is_enabled: true,
  eligible_designation_ids: ["team-lead", "cluster-manager"],
  max_request_days: 2,
  max_monthly_days: 2,
  max_yearly_days: null,
  allow_backdated: true,
  requires_hr_finalization: true,
  designation_rules: {
    "team-lead": { is_enabled: true, max_request_days: 1, max_monthly_days: 2 },
    "station-manager": { is_enabled: false, max_request_days: 2, max_monthly_days: 4 }
  },
  person_exceptions: {
    "person-1": { valid_until: null, max_request_days: 2, max_monthly_days: 4 }
  }
};

test("People WFH master is the sole designation eligibility source", () => {
  assert.equal(connectWfhEligible({ policy, designationId: "team-lead" }), true);
  assert.equal(connectWfhEligible({ policy, designationId: "cluster-manager" }), true);
  assert.equal(connectWfhEligible({ policy, designationId: "station-manager" }), false);
});

test("designation and individual rules return their own configured limits", () => {
  assert.deepEqual(resolveConnectWfhAccess({ policy, designationId: "team-lead" }), {
    source: "designation", max_request_days: 1, max_monthly_days: 2, max_yearly_days: null
  });
  assert.deepEqual(resolveConnectWfhAccess({ policy, designationId: "station-manager", personId: "person-1" }), {
    source: "person_exception", max_request_days: 2, max_monthly_days: 4, max_yearly_days: null
  });
});

test("disabled or unresolved WFH policy never grants the menu", () => {
  assert.equal(connectWfhEligible({ policy: { ...policy, is_enabled: false }, designationId: "team-lead" }), false);
  assert.equal(connectWfhEligible({ policy, designationId: null }), false);
  assert.equal(connectWfhEligible({ policy: null, designationId: "team-lead" }), false);
});
