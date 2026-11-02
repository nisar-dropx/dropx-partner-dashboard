import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("./connect-manager-approvals.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText;

function harness() {
  const state = {
    steps: [{
      id: "11111111-1111-4111-8111-111111111111",
      company_id: "co",
      request_id: "22222222-2222-4222-8222-222222222222",
      step_order: 1,
      step_name: "Cluster Manager approval",
      status: "pending",
      approver_user_id: "stale-login",
      approver_person_id: "person-kanala"
    }],
    requests: [{
      id: "22222222-2222-4222-8222-222222222222",
      company_id: "co",
      request_kind: null,
      status: "pending_manager",
      attachment_path: "proof.jpg",
      profile_type: "contractor",
      profile_id: "worker-1",
      full_name: "CHINTHALA SRINIVASULU",
      dropx_id: "GDRD80088",
      attendance_date: "2026-10-11"
    }],
    rpc: []
  };

  function table(name) {
    const rows = () => name === "attendance_regularization_approval_steps" ? state.steps : state.requests;
    const api = {
      _filters: [],
      select() { return api; },
      eq(column, value) { api._filters.push([column, value, "eq"]); return api; },
      in(column, values) { api._filters.push([column, values, "in"]); return api; },
      is(column, value) { api._filters.push([column, value, "is"]); return api; },
      order() { return api; },
      limit() { return api; },
      update(payload) {
        api._update = payload;
        return {
          eq(column, value) { api._filters.push([column, value, "eq"]); return this; },
          in(column, values) { api._filters.push([column, values, "in"]); return this; },
          is(column, value) { api._filters.push([column, value, "is"]); return this; },
          then(resolve) {
            const matched = rows().filter((row) => api._filters.every(([column, value, op]) => {
              if (op === "in") return value.includes(row[column]);
              if (op === "is") return (row[column] ?? null) === value;
              return row[column] === value;
            }));
            for (const row of matched) Object.assign(row, payload);
            api._filters = [];
            resolve({ data: matched, error: null });
          }
        };
      },
      async maybeSingle() {
        const matched = rows().filter((row) => api._filters.every(([column, value, op]) => {
          if (op === "in") return Array.isArray(value) && value.includes(row[column]);
          if (op === "is") return (row[column] ?? null) === value;
          return row[column] === value;
        }));
        api._filters = [];
        return { data: matched[0] ?? null, error: null };
      },
      then(resolve) {
        const matched = rows().filter((row) => api._filters.every(([column, value, op]) => {
          if (op === "in") return Array.isArray(value) && value.includes(row[column]);
          if (op === "is") return (row[column] ?? null) === value;
          return row[column] === value;
        }));
        api._filters = [];
        resolve({ data: matched, error: null });
      }
    };
    return api;
  }

  const boundaries = {
    "server-only": {},
    "./connect-approver-identity": {
      adoptPendingStepForHigherManager: async () => undefined,
      resolveConnectActorPersonId: async () => "person-kanala",
      resolveConnectActorUserId: async () => "people-login",
      resolveConnectActorUserIds: async () => ["people-login"],
      resolveConnectVisibleApproverUserIds: async () => ["people-login"]
    },
    "./approver-mobile-notifications": { notifyApproverMobile: async () => undefined },
    "./connect-people-attendance-access": {
      connectWorkforceMatches: () => true,
      loadConnectAccessibleWorkforceIds: async () => ({ allowAll: true }),
      loadConnectAttendanceApproveScope: async () => ({ canFinalize: false, actorUserIds: ["people-login"] })
    },
    "./connect-reportee-scope": {},
    "./connect-exit-notifications": { notifyConnectExitOutcome: async () => undefined, notifyExitApprovalRequired: async () => undefined },
    "./india-date": { todayInIndia: () => "2026-11-02" },
    "./supabase-admin": {
      supabaseAdmin: {
        from: (name) => table(name),
        rpc: async (name, args) => { state.rpc.push({ name, args }); return { data: "pending_hr", error: null }; },
        storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://example/proof" } }) }) }
      }
    },
    "./connect-auth": {},
    "./connect-expense-data": {
      connectApproverIdentity: async () => ({ assignment: { designation_id: null, position_title: "Cluster Manager" } })
    },
    "./user-facing-error": { userFacingError: (error, fallback) => error?.message || fallback },
    "./connect-approval-journey": { approvalJourneySummary: () => [], loadApprovalJourneySteps: async () => new Map() },
    "./approval-designation-labels": { isHrHeadDesignation: () => false },
    "./connect-approval-location": { connectApprovalLocationFromJoin: () => ({}), loadConnectApprovalLocations: async () => new Map() },
    "../../../../src/lib/connect-attendance-notifications": { notifyAttendanceApprovalRequired: async () => undefined }
  };

  const module = { exports: {} };
  new Function("require", "exports", "module", compiled)((name) => {
    if (name in boundaries) return boundaries[name];
    return require(name);
  }, module.exports, module);

  return {
    state,
    decide: (decision = "approved") => module.exports.decideConnectAttendanceApproval(
      { id: "people-login", companyId: "co", profileType: "user", role: "Cluster Manager", designationCode: "CLM" },
      "22222222-2222-4222-8222-222222222222",
      decision,
      decision === "returned" ? "Please reattach clearer CCTV proof" : ""
    ),
    list: () => module.exports.listConnectAttendanceApprovals(
      { id: "people-login", companyId: "co", profileType: "user", role: "Cluster Manager", designationCode: "CLM" },
      { employeeIds: new Set(), contractorIds: new Set(), allowAll: false }
    )
  };
}

test("attendance list keeps person-matched steps after a stale One login id", async () => {
  const ui = harness();
  const rows = await ui.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].requestId, "22222222-2222-4222-8222-222222222222");
  assert.equal(rows[0].stepName, "Cluster Manager approval");
});

test("attendance decide allows the People person when approver_user_id is a stale login", async () => {
  const ui = harness();
  const notice = await ui.decide("approved");
  assert.match(notice, /HR attendance finalization|approved|routed/i);
  assert.equal(ui.state.rpc.length, 1);
  assert.equal(ui.state.rpc[0].args.p_actor_user_id, "people-login");
  assert.equal(ui.state.rpc[0].args.p_request_id, "22222222-2222-4222-8222-222222222222");
});

test("attendance decide no longer blocks when only person_id matches", async () => {
  const ui = harness();
  await assert.doesNotReject(() => ui.decide("approved"));
});
