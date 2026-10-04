import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
function compile(file, deps) {
  const exports = {};
  new Function("require", "exports", ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)((name) => deps[name] ?? require(name), exports);
  return exports;
}
const cod = compile("src/lib/ops-pulse/cod.ts", {
  react: { cache: (fn) => fn },
  "@/lib/date-format": {}, "@/lib/supabase-admin": { supabaseAdmin: null },
  "@/lib/ops-pulse/capacity-shipments": {}, "@/lib/people-operational-hierarchy": {},
});
const attachment = { storage_bucket: "private-proof", storage_path: "company/slip.png" };
function fixture({ returned = false, uploadError = "", saveError = "", readOnly = false } = {}) {
  const saved = [], filters = [];
  let workerCalls = 0, uploads = 0;
  const auth = { companyId: "company", userId: "station-user", fullName: "Station user", locationScopeIds: ["station"], hasAllLocationAccess: false };
  const db = {
    from(table) {
      let mutation = null;
      const q = {
        select() { return q; },
        eq(key, value) { filters.push([table, key, value]); return q; },
        is(key, value) { filters.push([table, key, value]); return q; },
        insert(row) { mutation = row; return q; },
        update(row) { mutation = row; return q; },
        async maybeSingle() {
          return { error: null, data: table === "stations"
            ? { id: "station", station_code: "SPBE", providers: { code: "AMAZON" }, location_models: { code: "EDSP" } }
            : { id: "existing", location_id: "station", deposit_date: "2026-10-04", form_type: "amazon", deposit_slip_attachments: [attachment], proof_version: 2, returned_at: returned ? "2026-10-05T00:00:00Z" : null } };
        },
        then(resolve, reject) {
          if (mutation) saved.push(mutation);
          return Promise.resolve({ data: mutation ? [{ id: "existing" }] : [], error: saveError ? { message: saveError } : null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  const actions = compile("src/app/ops-pulse/cod/submission/actions.ts", {
    "next/cache": { revalidatePath() {} },
    "@/lib/authorization": { requirePagePermission: async () => { if (readOnly) throw new Error("Read-only preview"); return auth; } },
    "@/lib/company-scope": { requireCompanyId: () => auth.companyId, withCompany: (row, id) => ({ ...row, company_id: id }) },
    "@/lib/ops-pulse/cod": cod,
    "@/lib/supabase-admin": { supabaseAdmin: db },
    "@/lib/ops-pulse/upload": { uploadOpsProof: async ({ file }) => { uploads++; if (uploadError) throw new Error(uploadError); return file ? attachment : null; } },
    "@/lib/ops-pulse/cash-recon-worker": {
      isCashReconWorkerConfigured: () => false,
      verifyRemittance: async () => { workerCalls++; throw new Error("Amazon unavailable"); },
    },
  });
  return { actions, saved, filters, workerCalls: () => workerCalls, uploads: () => uploads };
}
function form(withFile = true) {
  const f = new FormData();
  for (const [key, value] of Object.entries({ location_id: "station", remittance_code: "AC672687", submitter_name: "Test Depositor", deposited_amount: "10104", deposit_date: "2026-10-04", cod_period_from: "2026-10-04", cod_period_to: "2026-10-04", submission_id: "existing", proof_version: "2" })) f.set(key, value);
  if (withFile) f.set("deposit_slip", new Blob(["test image"], { type: "image/png" }), "test.png");
  return f;
}
test("Amazon upload saves evidence without SCC and never claims remittance matched", async () => {
  const f = fixture(), input = form();
  input.set("validation_status", "Matched"); input.set("validated_amount", "10104");
  const result = await f.actions.createCodSubmission(null, input);
  assert.equal(result.ok, true); assert.match(result.notice, /daily update is recorded/);
  assert.equal(f.workerCalls(), 0); assert.equal(f.saved.length, 1);
  const row = f.saved[0];
  assert.equal(row.validation_status, "Pending"); assert.equal(row.validated_amount, null); assert.equal(row.validated_at, null);
  assert.equal(row.ai_status, "Review pending"); assert.equal(row.status, "Submitted");
  assert.equal(row.company_id, "company"); assert.equal(row.created_by, "station-user");
  assert.equal(row.deposited_amount, 10104); assert.deepEqual(row.deposit_slip_attachments, [attachment]);
  assert.ok(f.filters.some(x => x[0] === "stations" && x[1] === "company_id" && x[2] === "company"));
});
test("ordinary edits and returned-slip replacements save without SCC", async () => {
  for (const returned of [false, true]) {
    const f = fixture({ returned });
    assert.equal((await f.actions.updateCodSubmission(null, form(returned))).ok, true);
    assert.equal(f.workerCalls(), 0); assert.equal(f.saved[0].validation_status, "Pending");
    assert.equal(f.saved[0].validated_amount, null);
    assert.ok(f.filters.some(x => x[1] === "proof_version" && x[2] === 2));
    assert.ok(f.filters.some(x => x[1] === "company_id" && x[2] === "company"));
  }
});
test("missing photos, failed storage and failed persistence cannot report upload success", async () => {
  for (const [options, withFile, message] of [[{}, false, /Upload a photo/], [{ uploadError: "Storage unavailable" }, true, /Storage unavailable/], [{ saveError: "Database unavailable" }, true, /Database unavailable/]]) {
    const f = fixture(options), result = await f.actions.createCodSubmission(null, form(withFile));
    assert.equal(result.ok, false); assert.match(result.error, message);
  }
  const f = fixture({ returned: true });
  assert.match((await f.actions.updateCodSubmission(null, form(false))).error, /replacement photo/);
  assert.equal(f.saved.length, 0);
});
test("station scope, preview, proof version and local amount/date checks remain enforced", async () => {
  const preview = fixture({ readOnly: true });
  assert.equal((await preview.actions.createCodSubmission(null, form())).ok, false); assert.equal(preview.uploads(), 0);
  for (const [field, value] of [["location_id", "other-station"], ["deposited_amount", "0"], ["deposited_amount", "-1"], ["deposit_date", "2026-02-30"], ["cod_period_to", "2026-10-03"]]) {
    const f = fixture(), input = form(); input.set(field, value);
    assert.equal((await f.actions.createCodSubmission(null, input)).ok, false, field); assert.equal(f.saved.length, 0); assert.equal(f.uploads(), 0);
  }
  const f = fixture(), stale = form(); stale.set("proof_version", "1");
  assert.match((await f.actions.updateCodSubmission(null, stale)).error, /changed/); assert.equal(f.saved.length, 0);
});
