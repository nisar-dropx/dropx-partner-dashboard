import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = ts.transpileModule(
  readFileSync(new URL("./payout-dispute-attention.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
).outputText;

const mod = { exports: {} };
new Function(
  "require",
  "exports",
  "module",
  source
)(
  (id) => {
    if (id === "@/lib/authorization") return { hasPermission: () => false };
    if (id === "@/lib/access-surface") return { currentAccessSurface: () => "ops" };
    if (id === "@/lib/company-scope") return { requireCompanyId: () => "c" };
    if (id === "@/lib/supabase-admin") return { supabaseAdmin: null };
    throw new Error(id);
  },
  mod.exports,
  mod
);

const {
  payoutDisputeWorkflowStage,
  summarizePayoutDisputeStatuses,
  preferredPayoutDisputeHref,
  payoutDisputeAttentionDetail,
  disputeAwaitsActor,
  payoutDisputeBadgeCount,
  resolvePayoutDisputeStationFilter
} = mod.exports;

test("maps dispute statuses to workflow stages without double counting", () => {
  assert.equal(payoutDisputeWorkflowStage("open"), "initial");
  assert.equal(payoutDisputeWorkflowStage("pending_final_approval"), "final");
  assert.equal(payoutDisputeWorkflowStage("in_review"), "final");
  assert.equal(payoutDisputeWorkflowStage("approved_for_processing"), "processor");
  assert.equal(payoutDisputeWorkflowStage("processing_blocked"), "processor");
  assert.equal(payoutDisputeWorkflowStage("rejected"), null);
  assert.deepEqual(
    summarizePayoutDisputeStatuses([
      { status: "open" },
      { status: "open" },
      { status: "pending_final_approval" },
      { status: "processing" },
      { status: "rejected" }
    ]),
    { active: 4, initial: 2, final: 1, processing: 1 }
  );
});

test("deep links prefer the single populated stage", () => {
  assert.equal(preferredPayoutDisputeHref({ initial: 3, final: 0, processing: 0, active: 3 }), "/payments/disputes?status=initial");
  assert.equal(preferredPayoutDisputeHref({ initial: 0, final: 2, processing: 0, active: 2 }), "/payments/disputes?status=final");
  assert.equal(preferredPayoutDisputeHref({ initial: 1, final: 1, processing: 0, active: 2 }), "/payments/disputes?status=active");
});

test("detail distinguishes personal pending queue from other open tickets", () => {
  assert.match(
    payoutDisputeAttentionDetail({ active: 5, awaitingYou: 2, pending: 2, initial: 3, final: 1, processing: 1 }),
    /2 pending for you/
  );
  assert.equal(
    payoutDisputeAttentionDetail({ active: 4, awaitingYou: 0, pending: 4, initial: 4, final: 0, processing: 0 }),
    "4 pending · 4 initial"
  );
  assert.match(
    payoutDisputeAttentionDetail({ active: 3, awaitingYou: 0, pending: 0, initial: 0, final: 3, processing: 0 }),
    /none pending for you/
  );
});

test("notification statuses never include completed resolved or rejected", () => {
  assert.equal(payoutDisputeWorkflowStage("resolved"), null);
  assert.equal(payoutDisputeWorkflowStage("rejected"), null);
  assert.deepEqual(
    summarizePayoutDisputeStatuses([{ status: "resolved" }, { status: "rejected" }, { status: "open" }]),
    { active: 1, initial: 1, final: 0, processing: 0 }
  );
});

test("awaiting-you respects role route and distinct-person rules", () => {
  const roles = new Map([
    ["d1:initial", "role-initial"],
    ["d2:final", "role-final"],
    ["d3:processor", "role-processor"],
    ["d4:processor", "role-processor"]
  ]);
  const base = {
    station_id: "s1",
    initial_reviewed_by: null,
    proposed_by: null,
    final_approved_by: null,
    processor_id: null
  };

  assert.equal(
    disputeAwaitsActor({ ...base, id: "d1", status: "open" }, "u1", ["role-initial"], roles, false),
    true
  );
  assert.equal(
    disputeAwaitsActor({ ...base, id: "d1", status: "open" }, "u1", ["role-other"], roles, false),
    false
  );
  assert.equal(
    disputeAwaitsActor(
      { ...base, id: "d2", status: "pending_final_approval", initial_reviewed_by: "u1" },
      "u1",
      ["role-final"],
      roles,
      false
    ),
    false,
    "initial reviewer cannot also final-approve"
  );
  assert.equal(
    disputeAwaitsActor(
      { ...base, id: "d2", status: "pending_final_approval", initial_reviewed_by: "u2" },
      "u1",
      ["role-final"],
      roles,
      false
    ),
    true
  );
  assert.equal(
    disputeAwaitsActor({ ...base, id: "d3", status: "approved_for_processing" }, "u1", ["role-processor"], roles, false),
    false,
    "processor stage also needs payout edit"
  );
  assert.equal(
    disputeAwaitsActor({ ...base, id: "d3", status: "approved_for_processing" }, "u1", ["role-processor"], roles, true),
    true
  );
  assert.equal(
    disputeAwaitsActor(
      { ...base, id: "d4", status: "processing", processor_id: "other" },
      "u1",
      ["role-processor"],
      roles,
      true
    ),
    false,
    "claimed processing stays with the claimer"
  );
});

test("badge counts pending only — not completed or already-handled stages", () => {
  assert.equal(
    payoutDisputeBadgeCount({
      active: 9,
      awaitingYou: 2,
      pending: 2,
      initial: 5,
      final: 3,
      processing: 1,
      pageCode: "ops_workforce_payout_disputes",
      href: "/payments/disputes",
      detail: ""
    }),
    2
  );
  assert.equal(
    payoutDisputeBadgeCount({
      active: 4,
      awaitingYou: 0,
      pending: 0,
      initial: 0,
      final: 4,
      processing: 0,
      pageCode: "ops_workforce_payout_disputes",
      href: "/payments/disputes",
      detail: ""
    }),
    0
  );
});

test("station filter never widens past the actor scope and empty selection counts as zero", () => {
  assert.deepEqual(resolvePayoutDisputeStationFilter({ hasAllLocationAccess: true, locationScopeIds: [] }, null), null);
  assert.deepEqual(resolvePayoutDisputeStationFilter({ hasAllLocationAccess: true, locationScopeIds: [] }, ["a", "b"]), ["a", "b"]);
  assert.deepEqual(resolvePayoutDisputeStationFilter({ hasAllLocationAccess: false, locationScopeIds: ["a", "b"] }, ["a", "c"]), ["a"]);
  assert.deepEqual(resolvePayoutDisputeStationFilter({ hasAllLocationAccess: false, locationScopeIds: ["a"] }, []), []);
  assert.deepEqual(resolvePayoutDisputeStationFilter({ hasAllLocationAccess: false, locationScopeIds: ["a"] }, null), ["a"]);
});

test("actor id matching is case-insensitive for claimed processing", () => {
  const roles = new Map([["d1:processor", "role-processor"]]);
  assert.equal(
    disputeAwaitsActor(
      {
        id: "d1",
        status: "processing",
        station_id: "s1",
        initial_reviewed_by: null,
        proposed_by: null,
        final_approved_by: null,
        processor_id: "AAAA-BBBB"
      },
      "aaaa-bbbb",
      ["role-processor"],
      roles,
      true
    ),
    true
  );
});
