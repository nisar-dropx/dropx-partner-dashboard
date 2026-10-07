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
const models = { edsp: ["AMAZON", "EDSP"], xpt: ["AMAZON", "XPT"], now: ["AMAZON", "NOW"], flipkart: ["FLIPKART", "MDH"] };
// portal: "down" (worker throws), "unconfigured", "verified", "mismatch" or "login" (portal login typed as submitter).
function fixture({ returned = false, uploadError = "", saveError = "", readOnly = false, portal = "down", model = "edsp" } = {}) {
  const [providerCode, modelCode] = models[model];
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
            ? { id: "station", station_code: "SPBE", providers: { code: providerCode }, location_models: { code: modelCode } }
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
      isCashReconWorkerConfigured: () => portal !== "unconfigured",
      verifyRemittance: async (params) => {
        workerCalls++;
        if (portal === "down") throw new Error("Amazon unavailable");
        const verified = portal !== "mismatch";
        return {
          verified, codeFound: true, amountMatched: verified, depositDateMatched: true, creationPeriodMatched: true, submitterMatched: true,
          failureReason: verified ? null : "Amount on Amazon portal does not match.", remittanceCode: params.remittanceCode, amount: params.amount, nearMisses: [],
          matches: verified ? [{ creationDateIst: "2026-10-04", submissionDateIst: "2026-10-04", submittedBy: portal === "login" ? "testdepositor" : "dliraja", createdBy: "dliraja" }] : [],
        };
      },
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
test("Amazon EDSP/XPT upload is verified on the portal and saved as matched", async () => {
  for (const model of ["edsp", "xpt"]) {
    const f = fixture({ portal: "verified", model });
    const result = await f.actions.createCodSubmission(null, form());
    assert.equal(result.ok, true); assert.match(result.notice, /remittance verified/);
    assert.equal(f.workerCalls(), 1); assert.equal(f.saved.length, 1);
    const row = f.saved[0];
    assert.equal(row.validation_status, "Matched"); assert.equal(row.validated_amount, 10104); assert.ok(row.validated_at);
    assert.equal(row.remittance_creation_date, "2026-10-04"); assert.equal(row.remittance_submission_date, "2026-10-04");
    assert.equal(row.validation_payload.remittance_verify.verified, true);
    assert.equal(row.ai_status, "Review pending"); assert.equal(row.status, "Submitted");
  }
});
test("portal outage still saves the upload as pending and never claims remittance matched", async () => {
  for (const portal of ["down", "unconfigured"]) {
    const f = fixture({ portal }), input = form();
    input.set("validation_status", "Matched"); input.set("validated_amount", "10104");
    const result = await f.actions.createCodSubmission(null, input);
    assert.equal(result.ok, true); assert.match(result.notice, /daily update is recorded/); assert.match(result.notice, /not verified yet/);
    assert.equal(f.workerCalls(), portal === "down" ? 1 : 0); assert.equal(f.saved.length, 1);
    const row = f.saved[0];
    assert.equal(row.validation_status, "Pending"); assert.equal(row.validated_amount, null); assert.equal(row.validated_at, null);
    assert.equal(row.validation_payload.portal_check, "unavailable");
    assert.equal(row.ai_status, "Review pending"); assert.equal(row.status, "Submitted");
    assert.equal(row.company_id, "company"); assert.equal(row.created_by, "station-user");
    assert.equal(row.deposited_amount, 10104); assert.deepEqual(row.deposit_slip_attachments, [attachment]);
    assert.ok(f.filters.some(x => x[0] === "stations" && x[1] === "company_id" && x[2] === "company"));
  }
});
test("a portal mismatch or a portal login as submitter blocks the save before anything is stored", async () => {
  for (const [portal, message] of [["mismatch", /does not match/], ["login", /looks like the Amazon portal login/]]) {
    for (const action of ["createCodSubmission", "updateCodSubmission"]) {
      const f = fixture({ portal }), result = await f.actions[action](null, form());
      assert.equal(result.ok, false, portal + action); assert.match(result.error, message);
      assert.equal(f.saved.length, 0); assert.equal(f.uploads(), 0);
    }
  }
});
test("Flipkart and Amazon Now stations upload directly without a portal check", async () => {
  for (const model of ["flipkart", "now"]) {
    for (const action of ["createCodSubmission", "updateCodSubmission"]) {
      const f = fixture({ portal: "mismatch", model }), result = await f.actions[action](null, form());
      assert.equal(result.ok, true, model + action); assert.equal(f.workerCalls(), 0);
      assert.equal(f.saved[0].validation_status, "Pending"); assert.equal(f.saved[0].validated_amount, null);
      assert.equal(f.saved[0].validation_payload.portal_check, "not_required");
    }
  }
});
test("edits and returned-slip replacements verify when the portal is up and stay pending when it is down", async () => {
  for (const returned of [false, true]) {
    for (const [portal, status, amount] of [["verified", "Matched", 10104], ["down", "Pending", null]]) {
      const f = fixture({ returned, portal });
      assert.equal((await f.actions.updateCodSubmission(null, form(returned))).ok, true);
      assert.equal(f.workerCalls(), 1); assert.equal(f.saved[0].validation_status, status);
      assert.equal(f.saved[0].validated_amount, amount);
      assert.ok(f.filters.some(x => x[1] === "proof_version" && x[2] === 2));
      assert.ok(f.filters.some(x => x[1] === "company_id" && x[2] === "company"));
    }
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
