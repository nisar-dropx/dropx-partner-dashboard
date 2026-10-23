import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
const compile = (file, mocks = {}) => {
  const m = { exports: {} };
  new Function(
    "require",
    "exports",
    "module",
    ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
  )(
    (n) => {
      if (n in mocks) return mocks[n];
      throw Error(n);
    },
    m.exports,
    m,
  );
  return m.exports;
};
const model = compile("src/lib/ops-pulse/store-audits/model.ts");
const seed = JSON.parse(
  readFileSync("supabase/seeds/amazon-now-apollo-audit.json", "utf8"),
);
const settings = {
  managerRoles: ["manager"],
  responderRoles: ["store"],
  modelIds: ["now"],
  emailEnabled: true,
  ccRules: [],
};
const manager = {
  userId: "auditor",
  isMasterOwner: false,
  effectiveRoleIds: ["manager"],
  hasAllLocationAccess: false,
  locationScopeIds: ["A"],
  permissions: { store_audits: { canView: true, canAdd: true, canEdit: true } },
};
const store = { ...manager, userId: "store-user", effectiveRoleIds: ["store"] };
const q = {
  ...seed.sections[0].questions[0],
  id: "test_q",
  allowNA: true,
  kind: "yes_no_na",
  scored: true,
  compliantAnswer: "yes",
  evidence: { when: "always", min: 1, max: 5 },
  responseEvidence: { when: "always", min: 1, max: 5 },
  extraFields: [
    { id: "instances", label: "No. of instances", type: "number", when: "gap" },
  ],
  defaultOwner: "Store TL",
};
const template = {
  ...seed,
  sections: [{ ...seed.sections[0], questions: [q] }],
};
const audit = () => ({
  id: "audit",
  company_id: "company",
  location_id: "A",
  assigned_to: "auditor",
  status: "scheduled",
  audit_type: "mock",
  started_at: null,
  completed_at: null,
  deleted_at: null,
  version: 1,
  template,
  answers: {},
  findings: [],
  events: [],
  summary: "",
  score: null,
  score_band: null,
  score_snapshot: null,
  amazon_score: null,
  amazon_auditor: null,
  present_sm_name: null,
  started_lat: null,
  started_lng: null,
});
const proof = (phase = "audit") => ({
  id: "proof",
  audit_id: "audit",
  question_id: q.id,
  phase,
  ready: true,
});
const answer = (outcome = "gap") => ({
  outcome,
  response:
    outcome === "pass" ? "yes" : outcome === "gap" ? "no" : outcome === "na" ? "na" : "",
  observation: "Expired stock in bin A",
  action: "Remove expired units from system",
  owner: "Store TL",
  dueAt: "2099-10-16T10:00:00+05:30",
  instances: outcome === "gap" ? 2 : null,
  extras: {},
});
test("source has all 83 Apollo checks (79 scored + 4 counts) with polarity and evidence rules", () => {
  model.validateTemplate(seed);
  assert.equal(model.questions(seed).length, 83);
  assert.equal(seed.sections.length, 10);
  const scored = model.questions(seed).filter((q) => model.isScored(q));
  assert.equal(scored.length, 79);
  assert.equal(
    scored.filter((q) => q.compliantAnswer === "no").length >= 15,
    true,
  );
  for (const q of model.questions(seed)) {
    assert(q.hours > 0);
    assert(q.action);
    if (model.isCount(q)) {
      assert.equal(q.evidence.when, "optional");
      assert.equal(q.scored, false);
    } else {
      assert(["always", "gap", "optional"].includes(q.evidence.when));
      assert.equal(q.responseEvidence.min >= 1, true);
      assert(["yes", "no"].includes(q.compliantAnswer));
    }
  }
  assert.equal(model.outcomeFromResponse(scored[0], scored[0].compliantAnswer), "pass");
  const inverted = scored.find((q) => q.compliantAnswer === "no");
  assert.equal(model.outcomeFromResponse(inverted, "no"), "pass");
  assert.equal(model.outcomeFromResponse(inverted, "yes"), "gap");
});
test("store cannot discover scheduled/in-progress/cancelled/deleted/out-of-scope audits", () => {
  for (const status of ["scheduled", "in_progress", "cancelled"])
    assert.equal(model.canRead(store, settings, { ...audit(), status }), false);
  // Surprise mock: even the assigned store user cannot read before completion.
  assert.equal(
    model.canRead(store, settings, {
      ...audit(),
      assigned_to: store.userId,
      audit_type: "mock",
      status: "scheduled",
    }),
    false,
  );
  assert.equal(
    model.canRead(store, settings, {
      ...audit(),
      assigned_to: store.userId,
      audit_type: "self",
      status: "scheduled",
    }),
    true,
  );
  assert.equal(
    model.canRead(store, settings, {
      ...audit(),
      completed_at: "2026-10-15",
      status: "awaiting_response",
    }),
    true,
  );
  assert.equal(
    model.canRead(store, settings, {
      ...audit(),
      location_id: "B",
      completed_at: "2026-10-15",
      status: "closed",
    }),
    false,
  );
  assert.equal(
    model.canRead(manager, settings, { ...audit(), location_id: "B" }),
    false,
  );
  assert.equal(
    model.canRead(manager, settings, { ...audit(), deleted_at: "2026-10-15" }),
    false,
  );
});
test("draft audits can be deleted by assignee, managers, or owners — not random store users", () => {
  const draft = { ...audit(), status: "in_progress" };
  assert.equal(model.canDeleteDraftStoreAudit(manager, settings, draft), true);
  assert.equal(
    model.canDeleteDraftStoreAudit(
      { ...store, userId: "auditor" },
      settings,
      draft,
    ),
    true,
  );
  assert.equal(model.canDeleteDraftStoreAudit(store, settings, draft), false);
  assert.equal(
    model.canDeleteDraftStoreAudit(manager, settings, {
      ...draft,
      status: "closed",
      completed_at: "2026-10-15",
    }),
    false,
  );
});
test("only assigned in-scope leadership can inspect; preview and view-only cannot write", () => {
  const a = { ...audit(), status: "in_progress" };
  assert(model.canInspect(manager, settings, a));
  for (const auth of [
    store,
    { ...manager, userId: "other" },
    { ...manager, readOnly: true },
    { ...manager, permissions: { store_audits: { canView: true } } },
    { ...manager, locationScopeIds: ["B"] },
  ])
    assert.equal(model.canInspect(auth, settings, a), false);
});
test("complete requires every mandatory answer, evidence, action, owner and future due date", () => {
  const a = audit();
  assert.throws(() => model.validateAnswers(a, {}, []), /Answer/);
  assert.throws(
    () => model.validateAnswers(a, { [q.id]: answer("pass") }, []),
    /evidence/,
  );
  assert.throws(
    () =>
      model.validateAnswers(a, { [q.id]: { ...answer(), owner: "" } }, [
        proof(),
      ]),
    /owner/,
  );
  assert.throws(
    () =>
      model.validateAnswers(
        a,
        { [q.id]: { ...answer(), dueAt: "2020-01-01" } },
        [proof()],
      ),
    /future/,
  );
  model.validateAnswers(a, { [q.id]: answer() }, [proof()]);
  assert.throws(
    () =>
      model.validateAnswers(a, { [q.id]: answer() }, [
        { ...proof(), audit_id: "other" },
      ]),
    /evidence/,
  );
  assert.throws(
    () =>
      model.validateAnswers(a, { [q.id]: answer() }, [
        { ...proof(), ready: false },
      ]),
    /evidence/,
  );
});
test("N/A needs explanation and respects configuration; no unrelated evidence satisfies a check", () => {
  assert.throws(
    () =>
      model.validateAnswers(
        audit(),
        { [q.id]: { ...answer("na"), observation: "" } },
        [],
      ),
    /Explain/,
  );
  model.validateAnswers(audit(), { [q.id]: answer("na") }, []);
  const noNA = structuredClone(audit());
  noNA.template.sections[0].questions[0].allowNA = false;
  assert.throws(
    () => model.validateAnswers(noNA, { [q.id]: answer("na") }, []),
    /allowed/,
  );
  assert.throws(
    () =>
      model.validateAnswers(audit(), { [q.id]: answer() }, [proof("response")]),
    /evidence/,
  );
});
test("configurable counts enforce minimum and maximum separately for inspection and closure", () => {
  const row = structuredClone(audit());
  row.template.sections[0].questions[0].evidence = {
    when: "always",
    min: 2,
    max: 2,
  };
  assert.throws(
    () => model.validateAnswers(row, { [q.id]: answer() }, [proof()]),
    /2–2/,
  );
  model.validateAnswers(row, { [q.id]: answer() }, [
    proof(),
    { ...proof(), id: "two" },
  ]);
  assert.throws(
    () =>
      model.validateAnswers(row, { [q.id]: answer() }, [
        proof(),
        proof(),
        proof(),
      ]),
    /2–2/,
  );
  assert.throws(() => model.validateResponse(q, "Corrected", 0), /Attach/);
  model.validateResponse(q, "Corrected", 1);
  assert.throws(() => model.validateResponse(q, "", 1), /Describe/);
});
test("Amazon autofilled passes skip always-photo and always-extra validation", () => {
  const row = structuredClone(audit());
  row.audit_type = "amazon";
  row.template.sections[0].questions[0] = {
    ...q,
    evidence: { when: "always", min: 1, max: 5 },
    extraFields: [
      { id: "reading_c", label: "Reading (°C)", type: "number", when: "always" },
      { id: "instances", label: "No. of instances", type: "number", when: "gap" },
    ],
  };
  const filled = model.fillAmazonPasses(row.template, {});
  model.validateAnswers(row, filled, []);
  assert.equal(filled[q.id].autofilled, true);
  assert.equal(model.score({ template: row.template, answers: filled }), 100);
});
test("editing/removing master questions never changes the saved audit snapshot", () => {
  const a = structuredClone(audit());
  const t = structuredClone(template);
  t.sections[0].questions = [];
  assert.equal(model.questions(a.template).length, 1);
  assert.throws(() => model.validateTemplate(t), /at least one question/);
});
test("end-to-end server actions: start, draft, blocked completion, release, response, return, resubmit, close", async () => {
  let row = structuredClone(audit()),
    auth = manager,
    proofs = [],
    sent = 0;
  const c = () => ({
    auth,
    companyId: "company",
    master: { settings, template },
    audit: structuredClone(row),
  });
  const actions = compile("src/app/ops-pulse/store-audits/actions.ts", {
    "node:crypto": { randomUUID: () => "id" },
    "next/cache": { revalidatePath() {} },
    "@/lib/authorization": { hasPermission: () => true },
    "@/lib/ops-pulse/store-audits/server": {
      context: async () => c(),
      readAudit: async () => {
        if (!model.canRead(auth, settings, row)) throw Error("Unavailable");
        return c();
      },
      proofs: async () => proofs,
      requireManager: () => {
        if (!model.isManager(auth, settings) || auth.readOnly)
          throw Error("Denied");
      },
      updateAudit: async (c, patch, kind, note, version) => {
        if (version !== row.version) throw Error("changed in another window");
        row = {
          ...row,
          ...patch,
          version: row.version + 1,
          events: [...row.events, { kind, note }],
        };
        return structuredClone(row);
      },
    },
    "@/lib/ops-pulse/store-audits/model": model,
    "@/lib/ops-pulse/station-audit-people": {},
    "@/lib/ops-pulse/station-audits": {},
    "@/lib/ops-pulse/store-audits/mail": {
      notifyStoreAudit: async () => {
        sent++;
        return "Sent";
      },
    },
  });
  assert.equal(
    (
      await actions.startStoreAudit("audit", 1, {
        lat: 12.97,
        lng: 77.59,
        presentSmName: "Store SM",
      })
    ).ok,
    true,
  );
  assert.equal(sent, 0);
  assert.equal(model.canRead(store, settings, row), false);
  assert.equal(
    (
      await actions.saveStoreInspection(
        "audit",
        row.version,
        { [q.id]: answer() },
        "Gap found",
        false,
      )
    ).ok,
    true,
  );
  assert.equal(sent, 0);
  assert.equal(
    (
      await actions.saveStoreInspection(
        "audit",
        row.version,
        row.answers,
        "Gap found",
        true,
        { presentSmName: "Store SM" },
      )
    ).ok,
    false,
  );
  assert.equal(row.completed_at, null);
  proofs = [proof()];
  assert.equal(
    (
      await actions.saveStoreInspection(
        "audit",
        row.version,
        row.answers,
        "Gap found",
        true,
        { presentSmName: "Store SM" },
      )
    ).ok,
    true,
  );
  assert.equal(sent, 1);
  assert.equal(row.status, "awaiting_response");
  assert(model.canRead(store, settings, row));
  auth = store;
  assert.equal(
    (await actions.respondStoreFinding("audit", row.version, q.id, "Fixed")).ok,
    false,
  );
  proofs.push(proof("response"));
  assert.equal(
    (
      await actions.respondStoreFinding(
        "audit",
        row.version,
        q.id,
        "Removed and reconciled",
      )
    ).ok,
    true,
  );
  assert.equal(row.status, "under_review");
  assert.equal(
    (
      await actions.reviewStoreFinding(
        "audit",
        row.version,
        q.id,
        true,
        "Verified",
      )
    ).ok,
    false,
  );
  auth = manager;
  assert.equal(
    (
      await actions.reviewStoreFinding(
        "audit",
        row.version,
        q.id,
        false,
        "Need clearer evidence",
      )
    ).ok,
    true,
  );
  assert.equal(row.status, "awaiting_response");
  auth = store;
  assert.equal(
    (
      await actions.respondStoreFinding(
        "audit",
        row.version,
        q.id,
        "Added detail",
      )
    ).ok,
    true,
  );
  auth = manager;
  assert.equal(
    (
      await actions.reviewStoreFinding(
        "audit",
        row.version,
        q.id,
        true,
        "Verified system and stock",
      )
    ).ok,
    true,
  );
  assert.equal(row.status, "closed");
  assert.equal(model.canRespond(store, settings, row), false);
  assert.equal(
    (
      await actions.saveStoreInspection(
        "audit",
        row.version,
        {},
        "Rewrite",
        false,
      )
    ).ok,
    false,
  );
  assert.equal(sent, 1);
});
