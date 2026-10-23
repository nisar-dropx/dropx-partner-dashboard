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
  category = { id: "category-workforce", people_module: "delivery_network" },
  writeError = null
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
          return Promise.resolve(resolve({
            data: state.operation === "select" ? [] : null,
            error: state.operation === "select" ? null : writeError
          }));
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
      requirePagePermission: async () => ({ companyId: "tenant" }),
      requirePagePermissionOrThrow: async () => ({ companyId: "tenant" })
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
  id = null,
  registrationCategory = "workforce"
} = {}) {
  const formData = new FormData();
  if (id) formData.set("id", id);
  formData.set("code", "da");
  formData.set("name", "Delivery Associate");
  formData.set("designation_category_id", categoryId);
  formData.set("profile_destination", destination);
  formData.set("onboarding_categories", "workforce");
  if (registrationCategory !== null) formData.set("registration_category_code", registrationCategory);
  return formData;
}

const initialActionState = { error: "" };

test("create validates an active tenant category and persists its compatible destination", async () => {
  const actions = actionHarness();
  await assert.rejects(actions.createDesignation(initialActionState, designationForm()), /redirect/);

  assert.ok(actions.calls.some((call) => call[0] === "designation_categories" && call[1] === "eq" && call[2] === "id" && call[3] === "category-workforce"));
  assert.ok(actions.calls.some((call) => call[0] === "designation_categories" && call[1] === "eq" && call[2] === "company_id" && call[3] === "tenant"));
  assert.ok(actions.calls.some((call) => call[0] === "designation_categories" && call[1] === "eq" && call[2] === "is_active" && call[3] === true));

  const insert = actions.writes.find((write) => write.table === "designations" && write.operation === "insert");
  assert.equal(insert.payload.designation_category_id, "category-workforce");
  assert.equal(insert.payload.profile_destination, "workforce");
  assert.equal(insert.payload.registration_category_code, "workforce");
  assert.equal(insert.payload.company_id, "tenant");
  assert.deepEqual(actions.flashes.at(-1), { notice: "Designation added." });
});

test("update preserves the existing classification to avoid stale register routing", async () => {
  const actions = actionHarness({ category: { id: "category-hr", people_module: "people_hr" } });
  await assert.rejects(
    actions.updateDesignation(initialActionState, designationForm({ categoryId: "category-hr", destination: "employees", id: "designation-1" })),
    /redirect/
  );

  const update = actions.writes.find((write) => write.table === "designations" && write.operation === "update");
  assert.equal("designation_category_id" in update.payload, false);
  assert.equal("profile_destination" in update.payload, false);
  assert.equal(update.payload.registration_category_code, "workforce");
  assert.equal(actions.calls.some((call) => call[0] === "designation_categories"), false);
  assert.ok(actions.calls.some((call) => call[0] === "designations" && call[1] === "eq" && call[2] === "id" && call[3] === "designation-1"));
  assert.ok(actions.calls.some((call) => call[0] === "designations" && call[1] === "eq" && call[2] === "company_id" && call[3] === "tenant"));
});

test("server rejects a profile destination incompatible with the selected category", async () => {
  const actions = actionHarness();
  const result = await actions.createDesignation(initialActionState, designationForm({ destination: "employees" }));

  assert.equal(actions.writes.length, 0);
  assert.equal(actions.flashes.length, 0);
  assert.match(result.error, /not a valid profile destination for the Workforce designation category/);
});

test("server rejects an unavailable, inactive, or cross-company designation category", async () => {
  const actions = actionHarness({ category: null });
  const result = await actions.createDesignation(initialActionState, designationForm());

  assert.equal(actions.writes.length, 0);
  assert.equal(actions.flashes.length, 0);
  assert.deepEqual(result, { error: "Select an active designation category for this company." });
});

test("server keeps registration policy within the selected engagement types", async () => {
  const actions = actionHarness();
  const result = await actions.createDesignation(
    initialActionState,
    designationForm({ registrationCategory: "employees" })
  );

  assert.equal(actions.writes.length, 0);
  assert.equal(actions.flashes.length, 0);
  assert.deepEqual(result, { error: "Registration policy must be one of the selected engagement types." });
});

test("database errors return inline state without redirecting or clearing the form", async () => {
  const actions = actionHarness({ writeError: { message: "Database unavailable" } });
  const result = await actions.createDesignation(initialActionState, designationForm());

  assert.deepEqual(result, { error: "Database unavailable" });
  assert.equal(actions.flashes.length, 0);
});

test("page and form wire the required add selectors and safe edit presentation", () => {
  const pageSource = fs.readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
  const formSource = fs.readFileSync(new URL("../../../components/designation-form.tsx", import.meta.url), "utf8");

  assert.match(pageSource, /from\("designation_categories"\)[\s\S]*?\.eq\("company_id", companyId\)\.eq\("is_active", true\)/);
  assert.equal((pageSource.match(/<DesignationForm[^>]*businessCategories=\{businessCategories\}/g) ?? []).length, 2);
  assert.match(formSource, /name="designation_category_id"/);
  assert.match(formSource, /name="profile_destination"/);
  assert.match(formSource, /name="registration_category_code"/);
  assert.match(pageSource, /onboarding_categories, registration_category_code, profile_field_rules/);
  assert.match(formSource, /initial \? \([\s\S]*Category unavailable[\s\S]*Profile destination/);
  assert.match(pageSource, /initial=\{editDesignation\} key=\{editDesignation\.id\}/);
  assert.match(formSource, /designationProfileDestinationsForModule\(selectedBusinessCategory\.people_module\)/);
  assert.match(formSource, /useFormState\(action, \{ error: "" \}\)/);
  assert.match(formSource, /<form action=\{formAction\}[\s\S]*?actionState\.error[\s\S]*?role="alert"/);
  assert.match(formSource, /name="code" onChange=\{\(event\) => setCode\(event\.target\.value\)\}[\s\S]*?value=\{code\}/);
  assert.match(formSource, /name="name" onChange=\{\(event\) => setName\(event\.target\.value\)\}[\s\S]*?value=\{name\}/);
  assert.match(formSource, /name="status" onChange=\{\(event\) => setStatus\(event\.target\.value\)\} value=\{status\}/);
});
