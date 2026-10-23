import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";

import {
  designationPeopleModuleLabel,
  normalizeDesignationPeopleModule
} from "../../../lib/designation-business-categories.ts";
import {
  designationProfileDestinationAllowed,
  designationProfileDestinationLabel,
  normalizeDesignationProfileDestination
} from "../../../lib/designation-profile-destination.ts";

function actionHarness({
  category = { id: "category-workforce", people_module: "delivery_network" }
} = {}) {
  const calls = [];
  const flashes = [];
  const writes = [];

  const database = {
    from(table) {
      const state = { table, operation: "select" };
      const query = {
        select(...args) {
          calls.push([table, "select", ...args]);
          return query;
        },
        eq(...args) {
          calls.push([table, "eq", ...args]);
          return query;
        },
        in(...args) {
          calls.push([table, "in", ...args]);
          return query;
        },
        insert(payload) {
          state.operation = "insert";
          writes.push({ table, operation: "insert", payload });
          return query;
        },
        update(payload) {
          state.operation = "update";
          writes.push({ table, operation: "update", payload });
          return query;
        },
        maybeSingle: async () => ({ data: category, error: null }),
        then(resolve) {
          if (table === "workforce_categories") {
            return Promise.resolve(resolve({ data: [{ code: "workforce" }], error: null }));
          }
          return Promise.resolve(resolve({ data: state.operation === "select" ? [] : null, error: null }));
        }
      };
      return query;
    }
  };

  const dependencies = {
    "next/headers": { cookies: () => ({ set: (_key, value) => flashes.push(JSON.parse(value)) }) },
    "next/cache": { revalidatePath: () => {} },
    "next/navigation": {
      redirect: () => {
        throw Object.assign(new Error("redirect"), { digest: "NEXT_REDIRECT" });
      }
    },
    "@/lib/authorization": {
      requirePagePermission: async () => ({ companyId: "tenant" })
    },
    "@/lib/company-scope": {
      requireCompanyId: () => "tenant",
      withCompany: (payload, companyId) => ({ ...payload, company_id: companyId })
    },
    "@/lib/designation-business-categories": {
      designationPeopleModuleLabel,
      normalizeDesignationPeopleModule
    },
    "@/lib/designation-categories": {
      normalizeDesignationCategories: (values, fallback = ["employees", "contractors"]) => {
        const normalized = [...values].map((value) => String(value).trim().toLowerCase()).filter(Boolean);
        return normalized.length ? normalized : fallback;
      }
    },
    "@/lib/designation-profile-destination": {
      designationProfileDestinationAllowed,
      designationProfileDestinationLabel,
      normalizeDesignationProfileDestination
    },
    "@/lib/designation-portal-access": { designationPortalOptions: [] },
    "@/lib/dropx-one-pages": { dropxOnePageCodes: new Set(), requiredDropxOnePageCodes: [] },
    "@/lib/profile-field-rules": { normalizeCategoryProfileFieldRules: () => ({}) },
    "@/lib/supabase-admin": { supabaseAdmin: database }
  };

  const source = fs.readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const module = { exports: {} };
  new Function("require", "exports", "module", compiled)(
    (name) => dependencies[name],
    module.exports,
    module
  );
  return { ...module.exports, calls, flashes, writes };
}

function designationForm({
  categoryId = "category-workforce",
  destination = "workforce",
  id = null
} = {}) {
  const formData = new FormData();
  if (id) formData.set("id", id);
  formData.set("code", "da");
  formData.set("name", "Delivery Associate");
  formData.set("designation_category_id", categoryId);
  formData.set("profile_destination", destination);
  formData.set("onboarding_categories", "workforce");
  return formData;
}

test("create validates an active tenant category and persists its compatible destination", async () => {
  const actions = actionHarness();
  await assert.rejects(actions.createDesignation(designationForm()), /redirect/);

  assert.ok(actions.calls.some((call) => call[0] === "designation_categories" && call[1] === "eq" && call[2] === "id" && call[3] === "category-workforce"));
  assert.ok(actions.calls.some((call) => call[0] === "designation_categories" && call[1] === "eq" && call[2] === "company_id" && call[3] === "tenant"));
  assert.ok(actions.calls.some((call) => call[0] === "designation_categories" && call[1] === "eq" && call[2] === "is_active" && call[3] === true));

  const insert = actions.writes.find((write) => write.table === "designations" && write.operation === "insert");
  assert.equal(insert.payload.designation_category_id, "category-workforce");
  assert.equal(insert.payload.profile_destination, "workforce");
  assert.equal(insert.payload.company_id, "tenant");
  assert.deepEqual(actions.flashes.at(-1), { notice: "Designation added." });
});

test("update preserves the existing classification to avoid stale register routing", async () => {
  const actions = actionHarness({ category: { id: "category-hr", people_module: "people_hr" } });
  await assert.rejects(
    actions.updateDesignation(designationForm({ categoryId: "category-hr", destination: "employees", id: "designation-1" })),
    /redirect/
  );

  const update = actions.writes.find((write) => write.table === "designations" && write.operation === "update");
  assert.equal("designation_category_id" in update.payload, false);
  assert.equal("profile_destination" in update.payload, false);
  assert.equal(actions.calls.some((call) => call[0] === "designation_categories"), false);
  assert.ok(actions.calls.some((call) => call[0] === "designations" && call[1] === "eq" && call[2] === "id" && call[3] === "designation-1"));
  assert.ok(actions.calls.some((call) => call[0] === "designations" && call[1] === "eq" && call[2] === "company_id" && call[3] === "tenant"));
});

test("server rejects a profile destination incompatible with the selected category", async () => {
  const actions = actionHarness();
  await assert.rejects(
    actions.createDesignation(designationForm({ destination: "employees" })),
    /redirect/
  );

  assert.equal(actions.writes.length, 0);
  assert.match(actions.flashes.at(-1).error, /not a valid profile destination for the Workforce designation category/);
});

test("server rejects an unavailable, inactive, or cross-company designation category", async () => {
  const actions = actionHarness({ category: null });
  await assert.rejects(actions.createDesignation(designationForm()), /redirect/);

  assert.equal(actions.writes.length, 0);
  assert.deepEqual(actions.flashes.at(-1), { error: "Select an active designation category for this company." });
});

test("page and form wire the required add selectors and safe edit presentation", () => {
  const pageSource = fs.readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
  const formSource = fs.readFileSync(new URL("../../../components/designation-form.tsx", import.meta.url), "utf8");

  assert.match(pageSource, /from\("designation_categories"\)[\s\S]*?\.eq\("company_id", companyId\)\.eq\("is_active", true\)/);
  assert.equal((pageSource.match(/<DesignationForm[^>]*businessCategories=\{businessCategories\}/g) ?? []).length, 2);
  assert.match(formSource, /name="designation_category_id"/);
  assert.match(formSource, /name="profile_destination"/);
  assert.match(formSource, /initial \? \([\s\S]*Category unavailable[\s\S]*Profile destination/);
  assert.match(pageSource, /initial=\{editDesignation\} key=\{editDesignation\.id\}/);
  assert.match(formSource, /designationProfileDestinationsForModule\(selectedBusinessCategory\.people_module\)/);
});
