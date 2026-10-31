import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function loadBinding() {
  const mod = { exports: {} };
  const source = readFileSync(new URL("./connect-device-binding.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  new Function("require", "module", "exports", code)((id) => {
    if (id === "@/lib/connect-auth") return {};
    if (id === "@/lib/supabase-admin") return { supabaseAdmin: null };
    throw new Error(`Unexpected dependency ${id}`);
  }, mod, mod.exports);
  return mod.exports;
}

const { filterAccountsForDeviceBinding } = loadBinding();
const account = (id, companyId) => ({ id, companyId, profileType: "employee", name: id });

test("device binding stays off when no company has enabled the rule", () => {
  const accounts = [account("a1", "c1"), account("a2", "c2")];
  assert.deepEqual(filterAccountsForDeviceBinding(accounts, [
    { company_id: "c1", dropx_one_device_binding_enabled: false },
    { company_id: "c2", dropx_one_device_binding_enabled: null }
  ]), []);
  assert.deepEqual(filterAccountsForDeviceBinding(accounts, []), []);
});

test("device binding only gates accounts for companies that turned the rule on", () => {
  const accounts = [account("a1", "c1"), account("a2", "c2"), account("a3", "c1")];
  assert.deepEqual(
    filterAccountsForDeviceBinding(accounts, [
      { company_id: "c1", dropx_one_device_binding_enabled: true },
      { company_id: "c2", dropx_one_device_binding_enabled: false }
    ]).map((row) => row.id),
    ["a1", "a3"]
  );
});
