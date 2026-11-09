import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("./payout-dispute-finance-access.ts", import.meta.url), "utf8");
function load({ memberships = [], roles = [], grant = true, error = null } = {}) {
  const calls = [];
  const db = {
    from(table) {
      const result = { data: table === "user_roles" ? roles : memberships, error };
      const query = { select() { return query; }, eq(...args) { calls.push([table, ...args]); return query; },
        in() { return query; }, then(resolve) { return Promise.resolve(result).then(resolve); } };
      return query;
    },
    async rpc() { return { data: grant, error }; }
  };
  const mod = { exports: {} };
  new Function("require", "exports", ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText)((id) => id === "server-only" ? {} : { supabaseAdmin: db }, mod.exports);
  return { ...mod.exports, calls };
}
const auth = { companyId: "company", userId: "actor" };
const membership = { role_id: "finance", location_scope_ids: ["KTUO"], has_all_location_access: false };
const role = { id: "finance", code: "OPERATIONS_FINMGR", location_access_mode: "selected_locations" };

test("existing Finance membership enables only its stations and queries the authenticated identity", async () => {
  const api = load({ memberships: [membership], roles: [role] });
  const access = await api.loadDisputeFinanceAccess(auth);
  assert.deepEqual(api.disputeFinalRoleIds(["owner"], access, "KTUO"), ["owner", "finance"]);
  assert.deepEqual(api.disputeFinalRoleIds(["owner"], access, "OTHER"), ["owner"]);
  assert.deepEqual(api.disputeFinalRoleIds(["owner"], access, ""), ["owner"]);
  assert.ok(api.calls.some((call) => call[1] === "user_id" && call[2] === "actor"));
  assert.ok(api.calls.some((call) => call[1] === "company_id" && call[2] === "company"));
  assert.ok(api.calls.some((call) => call[1] === "product_code" && call[2] === "operations"));
  assert.ok(api.calls.some((call) => call[1] === "is_active" && call[2] === true));
});
test("no membership, wrong role, missing grant, errors and read-only fail closed", async () => {
  for (const fixture of [{}, { memberships: [membership], roles: [{ ...role, code: "OWNER" }] },
    { memberships: [membership], roles: [role], grant: false },
    { memberships: [membership], roles: [role], error: { message: "unavailable" } }]) {
    const api = load(fixture);
    assert.deepEqual((await api.loadDisputeFinanceAccess(auth)).roleIds, []);
  }
  const api = load({ memberships: [membership], roles: [role] });
  assert.deepEqual((await api.loadDisputeFinanceAccess({ ...auth, readOnly: true })).roleIds, []);
});
test("all-location membership retains its existing scope", async () => {
  const api = load({ memberships: [{ ...membership, has_all_location_access: true }], roles: [role] });
  assert.deepEqual(api.disputeFinalRoleIds([], await api.loadDisputeFinanceAccess(auth), "OTHER"), ["finance"]);
});
test("both the desk and final server actions use the shared scoped access", () => {
  const action = readFileSync(new URL("./payout-review-actions.ts", import.meta.url), "utf8");
  const desk = readFileSync(new URL("../components/payout-review-desk.tsx", import.meta.url), "utf8");
  assert.match(action, /!ops && \["approve_final", "reject_final", "send_back", "return_review"\]\.includes\(action\)/);
  assert.match(action, /p_actor_role_ids: actorRoleIds/);
  assert.match(action, /p_locations: auth.hasAllLocationAccess/);
  assert.match(desk, /stage === "final" && financeAccess/);
  assert.match(desk, /sameInitialActor/);
});
