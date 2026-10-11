import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as reconciliationPolicy from "../../../../lib/biometric/attendance-reconciliation-policy.ts";

const snapshotToken = "a".repeat(64);

function compile(sourceUrl, mocks) {
  const module = { exports: {} };
  const source = readFileSync(sourceUrl, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  new Function("require", "exports", "module", output)(
    (name) => {
      if (name in mocks) return mocks[name];
      throw new Error(`Missing test mock: ${name}`);
    },
    module.exports,
    module
  );
  return module.exports;
}

function authorizedUser(patch = {}) {
  return {
    companyId: "company-a",
    hasAllLocationAccess: true,
    isMasterOwner: true,
    readOnly: false,
    userId: "22222222-2222-4222-8222-222222222222",
    ...patch
  };
}

function request(body, contentType = "application/json; charset=utf-8", origin) {
  return new Request("https://dashboard.dropxlogistics.com/api/biometric/reconcile", {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      ...(contentType ? { "Content-Type": contentType } : {}),
      ...(origin ? { Origin: origin } : {})
    },
    method: "POST"
  });
}

function routeFixture() {
  const state = {
    auth: authorizedUser(),
    calls: [],
    claimError: null,
    leaseClaimed: true,
    permission: true,
    releaseError: null,
    rpcCalls: [],
    workerResult: null,
    workerError: null
  };
  const route = compile(new URL("./route.ts", import.meta.url), {
    "@/lib/authorization": {
      getAuthorization: async () => state.auth,
      hasPermission: (_authorization, page, action) =>
        state.permission && page === "app_settings" && action === "edit"
    },
    "@/lib/biometric/attendance-reconciliation": {
      reconcileBiometricAttendance: async (options) => {
        state.calls.push(options);
        if (state.workerError) throw state.workerError;
        return state.workerResult ?? {
          attempted: 1,
          completed: 1,
          failures: [],
          fromDate: options.fromDate,
          nextCursor: null,
          punchesReconciled: 2,
          skipped: 0,
          startCursor: options.cursor,
          toDate: options.toDate,
          totalMappings: 1
        };
      }
    },
    "@/lib/biometric/attendance-reconciliation-policy": reconciliationPolicy,
    "@/lib/supabase-admin": {
      supabaseAdmin: {
        async rpc(name, args) {
          state.rpcCalls.push({ args, name });
          if (name === "attendance_try_acquire_reconciliation_run") {
            return state.claimError
              ? { data: null, error: state.claimError }
              : { data: state.leaseClaimed, error: null };
          }
          if (name === "attendance_release_reconciliation_run") {
            return state.releaseError
              ? { data: null, error: state.releaseError }
              : { data: true, error: null };
          }
          throw new Error(`Unexpected RPC: ${name}`);
        }
      }
    },
    "node:crypto": {
      randomUUID: () => "11111111-1111-4111-8111-111111111111"
    }
  });
  return { route, state };
}

test("browser reconciliation requires an authenticated company-wide Settings editor", async () => {
  const { route, state } = routeFixture();
  const crossOrigin = await route.POST(request({ cursor: 0, limit: 1 }, undefined, "https://example.com"));
  assert.equal(crossOrigin.status, 403);
  assert.equal(state.calls.length, 0);

  for (const [auth, permission, expectedStatus] of [
    [null, true, 401],
    [authorizedUser({ readOnly: true }), true, 403],
    [authorizedUser({ isMasterOwner: false }), true, 403],
    [authorizedUser({ hasAllLocationAccess: false }), true, 403],
    [authorizedUser({ companyId: null }), true, 403],
    [authorizedUser(), false, 403]
  ]) {
    state.auth = auth;
    state.permission = permission;
    const response = await route.POST(request({ cursor: 0, limit: 1 }));
    assert.equal(response.status, expectedStatus);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  assert.equal(state.calls.length, 0);
});

test("browser reconciliation accepts only bounded JSON catch-up requests", async () => {
  const { route, state } = routeFixture();

  const unsupported = await route.POST(request({}, "text/plain"));
  assert.equal(unsupported.status, 415);
  assert.equal(unsupported.headers.get("cache-control"), "private, no-store");

  for (const body of [
    "{",
    { from: "2020-01-01", to: "2020-03-03" },
    { cursor: -1 },
    { limit: 51 },
    { from: { forged: true } },
    { snapshotToken: "not-a-snapshot" }
  ]) {
    const response = await route.POST(request(body));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  assert.equal(state.calls.length, 0);
});

test("browser reconciliation passes the authenticated company and validated page to the worker", async () => {
  const { route, state } = routeFixture();
  const response = await route.POST(request({
    cursor: 4,
    from: "2020-09-01",
    limit: 5,
    snapshotToken: snapshotToken.toUpperCase(),
    to: "2020-09-30"
  }));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal((await response.json()).healthy, true);
  assert.equal(state.calls.length, 1);
  assert.deepEqual(
    {
      batchSize: state.calls[0].batchSize,
      companyId: state.calls[0].companyId,
      cursor: state.calls[0].cursor,
      expectedSnapshotToken: state.calls[0].expectedSnapshotToken,
      fromDate: state.calls[0].fromDate,
      serializeByCompany: state.calls[0].serializeByCompany,
      toDate: state.calls[0].toDate
    },
    {
      batchSize: 5,
      companyId: "company-a",
      cursor: 4,
      expectedSnapshotToken: snapshotToken,
      fromDate: "2020-09-01",
      serializeByCompany: false,
      toDate: "2020-09-30"
    }
  );
  assert.ok(state.calls[0].deadlineAtMs > Date.now());
  assert.deepEqual(
    state.rpcCalls.map(({ args, name }) => [name, args.p_company_id, args.p_owner_user_id, args.p_token]),
    [
      ["attendance_try_acquire_reconciliation_run", "company-a", "22222222-2222-4222-8222-222222222222", "11111111-1111-4111-8111-111111111111"],
      ["attendance_release_reconciliation_run", "company-a", "22222222-2222-4222-8222-222222222222", "11111111-1111-4111-8111-111111111111"]
    ]
  );
});

test("browser reconciliation acquires one lease for a multi-window batch", async () => {
  const { route, state } = routeFixture();
  state.workerResult = {
    attempted: 5,
    completed: 5,
    failures: [],
    fromDate: "2020-09-01",
    nextCursor: 5,
    punchesReconciled: 25,
    skipped: 0,
    startCursor: 0,
    toDate: "2020-09-30",
    totalMappings: 12
  };

  const response = await route.POST(request({ cursor: 0, limit: 5 }));

  assert.equal(response.status, 200);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].serializeByCompany, false);
  assert.deepEqual(state.rpcCalls.map(({ name }) => name), [
    "attendance_try_acquire_reconciliation_run",
    "attendance_release_reconciliation_run"
  ]);
});

test("browser reconciliation returns conflict without invoking the worker when its company lease is busy", async () => {
  const { route, state } = routeFixture();
  state.leaseClaimed = false;

  const response = await route.POST(request({ cursor: 0, limit: 5 }));

  assert.equal(response.status, 409);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), {
    error: "Attendance repair is busy for this company. Run the repair again."
  });
  assert.equal(state.calls.length, 0);
  assert.deepEqual(state.rpcCalls.map(({ name }) => name), [
    "attendance_try_acquire_reconciliation_run"
  ]);
});

test("browser reconciliation releases its company lease when the worker fails", async () => {
  const { route, state } = routeFixture();
  state.workerError = new Error("backfill failed");

  const response = await route.POST(request({ cursor: 0, limit: 1 }));

  assert.equal(response.status, 500);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { error: "backfill failed" });
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.rpcCalls.map(({ name }) => name), [
    "attendance_try_acquire_reconciliation_run",
    "attendance_release_reconciliation_run"
  ]);
});

test("reconciliation worker applies an optional company filter before paging", async () => {
  const mappings = ["a", "b"].map((suffix) => ({
    account_id: `person-${suffix}`,
    company_id: `company-${suffix}`,
    effective_from: "2020-09-01",
    effective_to: null,
    employee_id: `person-${suffix}`,
    enrolment_id: suffix === "a" ? "101" : "202",
    field_executive_id: null,
    id: `mapping-${suffix}`,
    location_id: `station-${suffix}`,
    profile_type: "employee",
    status: "Active",
    worker_type: "employee"
  }));
  const filters = [];
  const backfills = [];
  const db = {
    from(table) {
      assert.equal(table, "biometric_enrolments");
      const equalities = new Map();
      const query = {
        eq(column, value) {
          equalities.set(column, value);
          filters.push([column, value]);
          return query;
        },
        lte() { return query; },
        or() { return query; },
        order() { return query; },
        range() {
          const companyId = equalities.get("company_id");
          return Promise.resolve({
            data: companyId === undefined ? mappings : mappings.filter((row) => row.company_id === companyId),
            error: null
          });
        },
        select() { return query; }
      };
      return query;
    }
  };
  const worker = compile(
    new URL("../../../../lib/biometric/attendance-reconciliation.ts", import.meta.url),
    {
      "@/lib/biometric/attendance": {
        backfillHistoricalPunches: async (options) => {
          backfills.push(options);
          return 1;
        }
      },
      "@/lib/biometric/attendance-reconciliation-policy": reconciliationPolicy,
      "@/lib/supabase-admin": { supabaseAdmin: db },
      "node:crypto": {
        createHash,
        randomUUID: () => "33333333-3333-4333-8333-333333333333"
      }
    }
  );

  const result = await worker.reconcileBiometricAttendance({
    batchSize: 50,
    companyId: "company-a",
    cursor: 0,
    deadlineAtMs: Date.now() + 60_000,
    fromDate: "2020-09-01",
    toDate: "2020-09-30"
  });

  assert.deepEqual(filters, [["company_id", "company-a"]]);
  assert.equal(result.totalMappings, 1);
  assert.match(result.snapshotToken, /^[0-9a-f]{64}$/);
  assert.deepEqual(backfills.map((item) => item.companyId), ["company-a"]);

  const repeated = await worker.reconcileBiometricAttendance({
    batchSize: 50,
    companyId: "company-a",
    cursor: 0,
    deadlineAtMs: Date.now() + 60_000,
    expectedSnapshotToken: result.snapshotToken,
    fromDate: "2020-09-01",
    toDate: "2020-09-30"
  });
  assert.equal(repeated.snapshotToken, result.snapshotToken);
  await assert.rejects(
    worker.reconcileBiometricAttendance({
      batchSize: 50,
      companyId: "company-a",
      cursor: 0,
      deadlineAtMs: Date.now() + 60_000,
      expectedSnapshotToken: "f".repeat(64),
      fromDate: "2020-09-01",
      toDate: "2020-09-30"
    }),
    /mappings changed/i
  );
});

test("serialized worker leases each company independently and skips only a contended company", async () => {
  const mappings = ["a", "b"].map((suffix) => ({
    account_id: `person-${suffix}`,
    company_id: `company-${suffix}`,
    effective_from: "2020-09-01",
    effective_to: null,
    employee_id: `person-${suffix}`,
    enrolment_id: suffix === "a" ? "101" : "202",
    field_executive_id: null,
    id: `mapping-${suffix}`,
    location_id: `station-${suffix}`,
    profile_type: "employee",
    status: suffix === "a" ? "Inactive" : "Active",
    worker_type: "employee"
  }));
  const rpcCalls = [];
  const backfills = [];
  const tokens = [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  ];
  const db = {
    from(table) {
      assert.equal(table, "biometric_enrolments");
      let companyId;
      const query = {
        eq(column, value) {
          assert.equal(column, "company_id");
          companyId = value;
          return query;
        },
        lte() { return query; },
        or() { return query; },
        order() { return query; },
        range() {
          return Promise.resolve({
            data: companyId === undefined
              ? mappings
              : mappings.filter((mapping) => mapping.company_id === companyId),
            error: null
          });
        },
        select() { return query; }
      };
      return query;
    },
    async rpc(name, args) {
      rpcCalls.push({ args, name });
      if (name === "attendance_try_acquire_reconciliation_run") {
        return { data: args.p_company_id !== "company-a", error: null };
      }
      if (name === "attendance_release_reconciliation_run") {
        return { data: true, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    }
  };
  const worker = compile(
    new URL("../../../../lib/biometric/attendance-reconciliation.ts", import.meta.url),
    {
      "@/lib/biometric/attendance": {
        backfillHistoricalPunches: async (options) => {
          backfills.push(options);
          return 3;
        }
      },
      "@/lib/biometric/attendance-reconciliation-policy": reconciliationPolicy,
      "@/lib/supabase-admin": { supabaseAdmin: db },
      "node:crypto": { createHash, randomUUID: () => tokens.shift() }
    }
  );

  const result = await worker.reconcileBiometricAttendance({
    batchSize: 50,
    cursor: 0,
    deadlineAtMs: Date.now() + 60_000,
    fromDate: "2020-09-01",
    leaseOwnerId: "99999999-9999-4999-8999-999999999999",
    serializeByCompany: true,
    toDate: "2020-09-30"
  });

  assert.deepEqual(
    rpcCalls.map(({ args, name }) => [name, args.p_company_id, args.p_owner_user_id, args.p_token]),
    [
      ["attendance_try_acquire_reconciliation_run", "company-a", "99999999-9999-4999-8999-999999999999", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      ["attendance_try_acquire_reconciliation_run", "company-b", "99999999-9999-4999-8999-999999999999", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
      ["attendance_release_reconciliation_run", "company-b", "99999999-9999-4999-8999-999999999999", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]
    ]
  );
  assert.deepEqual(backfills.map((item) => item.companyId), ["company-b"]);
  assert.equal(result.attempted, 2);
  assert.equal(result.completed, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.punchesReconciled, 3);
  assert.deepEqual(result.failures, []);
});

test("serialized worker reports lease contention as retryable in browser fail mode", async () => {
  const mapping = {
    account_id: "person-a",
    company_id: "company-a",
    effective_from: "2020-09-01",
    effective_to: null,
    employee_id: "person-a",
    enrolment_id: "101",
    field_executive_id: null,
    id: "mapping-a",
    location_id: "station-a",
    profile_type: "employee",
    status: "Active",
    worker_type: "employee"
  };
  const rpcCalls = [];
  const backfills = [];
  const db = {
    from(table) {
      assert.equal(table, "biometric_enrolments");
      const query = {
        eq() { return query; },
        lte() { return query; },
        or() { return query; },
        order() { return query; },
        range() { return Promise.resolve({ data: [mapping], error: null }); },
        select() { return query; }
      };
      return query;
    },
    async rpc(name, args) {
      rpcCalls.push({ args, name });
      assert.equal(name, "attendance_try_acquire_reconciliation_run");
      return { data: false, error: null };
    }
  };
  const worker = compile(
    new URL("../../../../lib/biometric/attendance-reconciliation.ts", import.meta.url),
    {
      "@/lib/biometric/attendance": {
        backfillHistoricalPunches: async (options) => {
          backfills.push(options);
          return 1;
        }
      },
      "@/lib/biometric/attendance-reconciliation-policy": reconciliationPolicy,
      "@/lib/supabase-admin": { supabaseAdmin: db },
      "node:crypto": {
        createHash,
        randomUUID: () => "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
      }
    }
  );

  const result = await worker.reconcileBiometricAttendance({
    batchSize: 50,
    cursor: 0,
    deadlineAtMs: Date.now() + 60_000,
    fromDate: "2020-09-01",
    leaseContention: "fail",
    leaseOwnerId: "99999999-9999-4999-8999-999999999999",
    serializeByCompany: true,
    toDate: "2020-09-30"
  });

  assert.equal(rpcCalls.length, 1);
  assert.deepEqual(rpcCalls[0], {
    args: {
      p_company_id: "company-a",
      p_lease_seconds: 360,
      p_owner_user_id: "99999999-9999-4999-8999-999999999999",
      p_token: "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    },
    name: "attendance_try_acquire_reconciliation_run"
  });
  assert.equal(backfills.length, 0);
  assert.equal(result.attempted, 1);
  assert.equal(result.completed, 0);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.failures, [{
    cursor: 0,
    enrolmentId: "101",
    mappingId: "mapping-a",
    message: "Attendance repair is busy for this company. This mapping will be retried."
  }]);
});

test("serialized worker rechecks ownership after leasing and skips a stale mapping", async () => {
  const original = {
    account_id: "original-owner",
    company_id: "company-a",
    effective_from: "2020-09-01",
    effective_to: null,
    employee_id: "original-owner",
    enrolment_id: "101",
    field_executive_id: null,
    id: "mapping-a",
    location_id: "station-a",
    profile_type: "employee",
    status: "Active",
    worker_type: "employee"
  };
  const replacement = {
    ...original,
    account_id: "replacement-owner",
    employee_id: "replacement-owner",
    id: "mapping-replacement"
  };
  const loads = [];
  const rpcCalls = [];
  const backfills = [];
  const db = {
    from(table) {
      assert.equal(table, "biometric_enrolments");
      let companyId;
      const query = {
        eq(column, value) {
          assert.equal(column, "company_id");
          companyId = value;
          return query;
        },
        lte() { return query; },
        or() { return query; },
        order() { return query; },
        range() {
          loads.push(companyId ?? null);
          return Promise.resolve({ data: companyId ? [replacement] : [original], error: null });
        },
        select() { return query; }
      };
      return query;
    },
    async rpc(name, args) {
      rpcCalls.push({ args, name });
      return { data: true, error: null };
    }
  };
  const worker = compile(
    new URL("../../../../lib/biometric/attendance-reconciliation.ts", import.meta.url),
    {
      "@/lib/biometric/attendance": {
        backfillHistoricalPunches: async (options) => {
          backfills.push(options);
          return 1;
        }
      },
      "@/lib/biometric/attendance-reconciliation-policy": reconciliationPolicy,
      "@/lib/supabase-admin": { supabaseAdmin: db },
      "node:crypto": {
        createHash,
        randomUUID: () => "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
      }
    }
  );

  const result = await worker.reconcileBiometricAttendance({
    batchSize: 50,
    cursor: 0,
    deadlineAtMs: Date.now() + 60_000,
    fromDate: "2020-09-01",
    serializeByCompany: true,
    toDate: "2020-09-30"
  });

  assert.deepEqual(loads, [null, "company-a"]);
  assert.deepEqual(rpcCalls.map(({ name }) => name), [
    "attendance_try_acquire_reconciliation_run",
    "attendance_release_reconciliation_run"
  ]);
  assert.equal(backfills.length, 0);
  assert.equal(result.attempted, 1);
  assert.equal(result.completed, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.punchesReconciled, 0);
  assert.deepEqual(result.failures, []);
});
