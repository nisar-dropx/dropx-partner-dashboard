import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
function load(file, mocks = {}) {
  const mod = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  new Function("module", "exports", "require", code)(mod, mod.exports, (id) => {
    assert.ok(id in mocks, id);
    return mocks[id];
  });
  return mod.exports;
}
const scoring = load("src/lib/ops-pulse/station-audit-scoring.ts");
const key = "check:b1ef68cc-43aa-467c-99aa-ab05c48aeb5f";
const options = [
  {
    code: "controllable",
    label: "Within station control",
    metadata: { exclude_from_score: false },
  },
  {
    code: "external",
    label: "Outside station control",
    metadata: { exclude_from_score: true },
  },
  {
    code: "investigating",
    label: "Under investigation",
    metadata: { pending: true, exclude_from_score: false },
  },
  {
    code: "prior_missing",
    label: "Prior missing scan",
    metadata: { applies_to: ["shipment"], exclude_from_score: true },
  },
  { code: "band", label: "Rated", metadata: { minimum_score: 0 } },
];
const item = {
  id: key.slice(6),
  section_id: "hygiene",
  label: "Example cleanliness check",
  score_source: "checklist",
  response_options: [
    { value: "poor", label: "Poor", score: 0 },
    { value: "great", label: "Great", score: 80, is_compliant: true },
    { value: "pass", label: "Pass", score: 100 },
    { value: "na", label: "N/A", score: null },
  ],
};
const input = {
  sections: [{ id: "hygiene", name: "Hygiene", score_weight: 100 }],
  items: [item],
  options,
  expectedCash: 0,
  actualCash: 0,
  expectedTids: [],
  scannedTids: [],
  responses: { [item.id]: "poor" },
  evidenceIds: ["proof"],
  assessments: { [key]: { code: "controllable", reason: " ", evidenceId: "" } },
};
assert.throws(
  () => scoring.calculateAuditScore(input),
  (error) => {
    assert.ok(error instanceof scoring.AuditResponsibilityError);
    assert.equal(error.issue.fieldName, `assessment_reason_${key}`);
    assert.match(error.message, /Example cleanliness check/);
    assert.ok(!error.message.includes(item.id));
    return true;
  },
);
const data = new FormData();
data.set("score_assessments", JSON.stringify(input.assessments));
const malformed = new FormData();
malformed.set("score_assessments", "invalid json");
assert.match(
  scoring.auditResponsibilityFormIssue(malformed, [key], options, [], {})
    .message,
  /Invalid responsibility/,
);
const issue = () =>
  scoring.auditResponsibilityFormIssue(data, [key], options, ["proof"], {
    [key]: item.label,
  });
assert.equal(issue().fieldName, `assessment_reason_${key}`);
input.assessments[key].reason = "Cleaning was missed";
data.set("score_assessments", JSON.stringify(input.assessments));
assert.equal(issue(), null);
assert.equal(
  scoring.calculateAuditScore(input).percentage,
  0,
  "valid responsibility does not erase a finding",
);
assert.equal(
  scoring.auditCheckHasScoreDifference(item, "great"),
  true,
  "an 80-point compliant outcome must not hide a retained responsibility field",
);
assert.equal(
  scoring.auditCheckNeedsResponsibility(item, "great"),
  false,
  "do not turn an untouched compliant outcome into provisional responsibility",
);
assert.equal(
  scoring.auditCheckNeedsResponsibility(item, "great", true),
  true,
  "keep an existing reason editable after an outcome change",
);
assert.equal(scoring.auditCheckHasScoreDifference(item, "pass"), false);
assert.equal(scoring.auditCheckHasScoreDifference(item, "na"), false);
assert.equal(
  scoring.auditCheckHasScoreDifference(
    { ...item, score_source: "cash_match" },
    "poor",
  ),
  false,
);
input.assessments[key] = { code: "investigating", reason: "", evidenceId: "" };
assert.equal(
  scoring.calculateAuditScore(input).provisional,
  true,
  "master metadata defines pending, not the code spelling",
);
input.assessments[key] = {
  code: "external",
  reason: "Verified external cause",
  evidenceId: "wrong-audit",
};
data.set("score_assessments", JSON.stringify(input.assessments));
assert.equal(issue().fieldName, `assessment_evidenceId_${key}`);
assert.throws(() => scoring.calculateAuditScore(input), /Select saved proof/);
data.set(
  `assessment_proof_${key}`,
  new File(["proof"], "proof.png", { type: "image/png" }),
);
assert.equal(issue(), null, "new proof can be uploaded after preflight");
assert.throws(
  () => scoring.calculateAuditScore(input),
  /Select saved proof/,
  "server still rejects evidence not saved to this audit",
);
input.assessments[key] = {
  code: "prior_missing",
  reason: "Prior scan",
  evidenceId: "proof",
};
assert.throws(() => scoring.calculateAuditScore(input), /does not apply/);

// Exercise actual upload retry flow without network or real audit mutations.
let prepared = 0,
  uploaded = 0,
  completed = 0,
  failName = "bad.png";
const realFetch = globalThis.fetch;
globalThis.fetch = async (_url, request) => {
  const body = JSON.parse(request.body);
  if (body.phase === "prepare") {
    prepared++;
    if (body.fileName === failName)
      return {
        ok: false,
        json: async () => ({ error: "simulated upload failure" }),
      };
    return {
      ok: true,
      json: async () => ({ bucket: "b", path: body.fileName, token: "test" }),
    };
  }
  completed++;
  return { ok: true, json: async () => ({ evidenceId: `saved-${completed}` }) };
};
const { uploadAuditFiles } = load("src/lib/ops-pulse/station-audit-upload.ts", {
  "@/lib/supabase": {
    supabase: {
      storage: {
        from: () => ({
          uploadToSignedUrl: async () => {
            uploaded++;
            return { error: null };
          },
        }),
      },
    },
  },
});
const good = new File(["a"], "good.png", { type: "image/png" }),
  bad = new File(["b"], "bad.png", { type: "image/png" });
const payload = (
  audit = "audit-a",
  field = "evidence_files",
  files = [good, bad],
) => {
  const d = new FormData();
  d.set("audit_id", audit);
  for (const f of files) d.append(field, f);
  return d;
};
try {
  await assert.rejects(() => uploadAuditFiles(payload()), /simulated/);
  assert.equal(
    completed,
    1,
    "successful peer upload finishes before retry is possible",
  );
  failName = "";
  await uploadAuditFiles(payload());
  assert.equal(uploaded, 2, "retry uploads only the previously failed file");
  await uploadAuditFiles(payload());
  assert.equal(
    uploaded,
    2,
    "failed audit submission retry reuses both saved proofs",
  );
  await uploadAuditFiles(payload("audit-b", "evidence_files", [good]));
  await uploadAuditFiles(payload("audit-a", "check_photo_other", [good]));
  assert.equal(
    uploaded,
    4,
    "different audits and checklist fields are not conflated",
  );
  const p = payload("audit-a", `assessment_proof_${key}`, [good]);
  await uploadAuditFiles(p);
  const proof = p.get(`assessment_evidence_${key}`);
  const retry = payload("audit-a", `assessment_proof_${key}`, [good]);
  await uploadAuditFiles(retry);
  assert.equal(
    retry.get(`assessment_evidence_${key}`),
    proof,
    "exclusion proof ID survives retry",
  );
  assert.equal(uploaded, 5);
} finally {
  globalThis.fetch = realFetch;
}
console.log(
  "Audit responsibility regressions passed: named errors, focus targets, configured pending, hidden scored outcomes, exclusions, retry and partial-upload safety.",
);
