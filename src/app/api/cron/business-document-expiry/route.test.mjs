import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const routeSource = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const source = readFileSync(new URL("../../../../lib/business-document-expiry-email.ts", import.meta.url), "utf8");

function fixture({ managerId = "manager-1", settingsError = null } = {}) {
  const calls = [];
  const supabaseAdmin = {
    from(table) {
      const filters = [];
      return {
        select(columns) {
          calls.push({ columns, table });
          return this;
        },
        eq(column, value) {
          filters.push([column, value]);
          return this;
        },
        maybeSingle() {
          if (table === "business_document_settings") {
            return Promise.resolve({
              data: settingsError ? null : { compliance_manager_user_id: managerId },
              error: settingsError ? { message: settingsError } : null
            });
          }
          if (table === "profiles") {
            return Promise.resolve({ data: { email: "Manager@Example.com" }, error: null });
          }
          throw new Error(`Unexpected table: ${table}`);
        },
        filters
      };
    }
  };
  const mocks = {
    "@/lib/supabase-admin": { supabaseAdmin }
  };
  const module = { exports: {} };
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  new Function("require", "exports", "module", compiled)((name) => mocks[name], module.exports, module);
  return { ...module.exports, calls };
}

test("compliance manager email uses an unambiguous two-step lookup", async () => {
  const route = fixture();

  const result = await route.loadComplianceManagerEmail("company-1");

  assert.deepEqual(result, { email: "manager@example.com", error: null });
  assert.deepEqual(route.calls, [
    { table: "business_document_settings", columns: "compliance_manager_user_id" },
    { table: "profiles", columns: "email" }
  ]);
  assert.doesNotMatch(routeSource, /profiles\s*\(email\)/);
  assert.match(routeSource, /loadComplianceManagerEmail\(company\.id\)/);
});

test("manager lookup reports settings failures instead of silently attempting email", async () => {
  const route = fixture({ settingsError: "settings unavailable" });

  const result = await route.loadComplianceManagerEmail("company-1");

  assert.deepEqual(result, { email: null, error: "settings unavailable" });
  assert.deepEqual(route.calls, [
    { table: "business_document_settings", columns: "compliance_manager_user_id" }
  ]);
});

test("manager lookup permits templates with custom recipients when no manager is configured", async () => {
  const route = fixture({ managerId: null });

  const result = await route.loadComplianceManagerEmail("company-1");

  assert.deepEqual(result, { email: null, error: null });
  assert.deepEqual(route.calls, [
    { table: "business_document_settings", columns: "compliance_manager_user_id" }
  ]);
});

test("only the partner dashboard owns the Vercel cron", () => {
  const route = fixture();

  assert.equal(route.isBusinessDocumentCronOwner(new Request("https://dashboard.dropxlogistics.com/api/cron/business-document-expiry"), true), true);
  assert.equal(route.isBusinessDocumentCronOwner(new Request("https://dropx-partner-dashboard-abc-dropx1.vercel.app/api/cron/business-document-expiry"), true), true);
  assert.equal(route.isBusinessDocumentCronOwner(new Request("https://dropx-fleet-abc-dropx1.vercel.app/api/cron/business-document-expiry"), true), false);
  assert.equal(route.isBusinessDocumentCronOwner(new Request("http://localhost:3000/api/cron/business-document-expiry"), false), true);
});

