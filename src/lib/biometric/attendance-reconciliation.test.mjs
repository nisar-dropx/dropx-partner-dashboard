import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ATTENDANCE_RECONCILIATION_DEFAULT_LOOKBACK_DAYS,
  addIsoDateDays,
  buildHistoricalBiometricOwnershipWindows,
  intersectAttendanceReconciliationWindow,
  resolveAttendanceReconciliationWindow,
  rotatingAttendanceReconciliationOffset
} from "./attendance-reconciliation-policy.ts";
import {
  biometricCandidateCategory,
  biometricCandidateOwnerKey,
  biometricCandidatePriority,
  biometricEnrolmentIdCandidates,
  isSameBiometricAssignmentLocation,
  partitionCurrentBiometricEnrolmentVariants,
  resolveBiometricAssignmentWindow,
  resolveBiometricCandidate
} from "./enrolment-resolution.ts";

const routeSource = readFileSync(
  new URL("../../app/api/cron/attendance-reconciliation/route.ts", import.meta.url),
  "utf8"
);
const workerSource = readFileSync(new URL("./attendance-reconciliation.ts", import.meta.url), "utf8");
const vercel = readFileSync(new URL("../../../vercel.json", import.meta.url), "utf8");

test("scheduled reconciliation uses a bounded rolling window", () => {
  const window = resolveAttendanceReconciliationWindow({
    catchup: false,
    fromDate: null,
    now: new Date("2026-10-11T05:00:00.000Z"),
    toDate: null
  });
  assert.deepEqual(window, {
    days: ATTENDANCE_RECONCILIATION_DEFAULT_LOOKBACK_DAYS,
    fromDate: "2026-08-11",
    toDate: "2026-10-11"
  });
  assert.equal(addIsoDateDays("2026-09-30", 1), "2026-10-01");
});

test("scheduled reconciliation retains blocked prior-month days until payout processing unlocks", () => {
  const window = resolveAttendanceReconciliationWindow({
    catchup: false,
    fromDate: null,
    now: new Date("2026-10-31T05:00:00.000Z"),
    toDate: null
  });
  assert.equal(window.fromDate, "2026-08-31");
  assert.equal(window.toDate, "2026-10-31");
  assert.equal(window.days, 62);
});

test("authenticated catch-up mode can replay September without allowing an unbounded scan", () => {
  assert.deepEqual(resolveAttendanceReconciliationWindow({
    catchup: true,
    fromDate: "2026-09-01",
    now: new Date("2026-10-11T05:00:00.000Z"),
    toDate: "2026-09-30"
  }), { days: 30, fromDate: "2026-09-01", toDate: "2026-09-30" });
  assert.throws(() => resolveAttendanceReconciliationWindow({
    catchup: true,
    fromDate: "2026-07-01",
    now: new Date("2026-10-11T05:00:00.000Z"),
    toDate: "2026-10-11"
  }), /limited to 62 days/);
  assert.throws(() => resolveAttendanceReconciliationWindow({
    catchup: false,
    fromDate: "2026-09-01",
    now: new Date("2026-10-11T05:00:00.000Z"),
    toDate: null
  }), /mode=catchup/);
  assert.match(routeSource, /: catchup \? 0 : null/);
});

test("mapping validity intersects the requested replay window for every status", () => {
  assert.deepEqual(intersectAttendanceReconciliationWindow({
    effectiveFrom: "2026-09-14",
    effectiveTo: null,
    fromDate: "2026-09-01",
    toDate: "2026-09-30"
  }), { fromDate: "2026-09-14", toDate: "2026-09-30" });
  assert.equal(intersectAttendanceReconciliationWindow({
    effectiveFrom: "2026-10-01",
    effectiveTo: null,
    fromDate: "2026-09-01",
    toDate: "2026-09-30"
  }), null);
  assert.doesNotMatch(workerSource, /\.eq\(\s*["']status["']\s*,\s*["']Active["']/);
  assert.match(workerSource, /isActive:\s*row\.status === ["']Active["']/);
  assert.match(workerSource, /Lifecycle status is intentionally not an eligibility condition/);
});

test("padded shared IDs produce one priority-resolved historical window", () => {
  const common = {
    company_id: "company",
    effective_from: "2026-09-01",
    effective_to: null,
    location_id: "station",
    status: "Active",
    worker_type: "individual_contract"
  };
  const windows = buildHistoricalBiometricOwnershipWindows({
    fromDate: "2026-09-01",
    mappings: [
      { ...common, id: "worker-map", enrolment_id: "00000123", profile_type: "worker", account_id: "helper" },
      {
        ...common,
        id: "employee-map",
        enrolment_id: "123",
        profile_type: "employee",
        account_id: "employee",
        employee_id: "employee",
        worker_type: "employee"
      }
    ],
    toDate: "2026-09-30"
  });

  assert.equal(windows.length, 1);
  assert.equal(windows[0].enrolmentId, "123");
  assert.equal(windows[0].kind, "resolved");
  assert.equal(windows[0].owner.id, "employee-map");
});

test("normalization remains canonical-first and repeated same-owner rows collapse", () => {
  assert.deepEqual(biometricEnrolmentIdCandidates("000123").slice(0, 2), ["123", "000123"]);
  const repeated = ["first-row", "second-row"].map((id) => ({
    id,
    profile_type: "worker",
    account_id: "same-helper",
    status: "Active",
    worker_type: "individual_contract"
  }));
  assert.equal(resolveBiometricCandidate(repeated).kind, "resolved");
});

test("legacy individual-contract and explicit contractor mappings share one duplicate category", () => {
  const legacy = {
    id: "legacy",
    enrolment_id: "000123",
    profile_type: null,
    worker_type: "individual_contract",
    account_id: "legacy-owner",
    status: "Active"
  };
  const canonical = {
    id: "canonical",
    enrolment_id: "123",
    profile_type: "contractor",
    worker_type: "individual_contract",
    account_id: "canonical-owner",
    status: "Active"
  };

  assert.equal(resolveBiometricCandidate([legacy, canonical]).kind, "ambiguous");
});

test("legacy workforce aliases resolve as field executives and unknown categories sort last", () => {
  const workforce = {
    id: "legacy-workforce",
    profile_type: "workforce",
    account_id: "owner",
    field_executive_id: "owner",
    status: "Active"
  };
  const executive = {
    id: "canonical-executive",
    profile_type: "field_executive",
    account_id: "owner",
    field_executive_id: "owner",
    status: "Active"
  };
  const unknown = { id: "unknown", profile_type: "mystery", account_id: "other", status: "Active" };

  assert.equal(biometricCandidateCategory(workforce), "field_executive");
  assert.equal(biometricCandidateOwnerKey(workforce), biometricCandidateOwnerKey(executive));
  assert.equal(resolveBiometricCandidate([workforce, executive]).kind, "resolved");
  assert.ok(biometricCandidatePriority(unknown)[0] > biometricCandidatePriority(executive)[0]);
});

test("legacy and canonical padded rows for one owner reuse the canonical mapping", () => {
  const legacy = {
    id: "legacy",
    enrolment_id: "000123",
    profile_type: null,
    worker_type: "individual_contract",
    account_id: "owner",
    status: "Active"
  };
  const canonical = {
    id: "canonical",
    enrolment_id: "123",
    profile_type: "contractor",
    worker_type: "individual_contract",
    account_id: "owner",
    status: "Active"
  };

  assert.equal(resolveBiometricCandidate([legacy, canonical]).kind, "resolved");
  assert.deepEqual(
    partitionCurrentBiometricEnrolmentVariants([legacy, canonical], canonical, "123"),
    { conflicts: [], duplicates: [legacy], keeper: canonical }
  );
});

test("historical resolver collapses overlapping padded rows for the same owner", () => {
  const mappings = [
    { id: "legacy", enrolment_id: "000123", profile_type: null },
    { id: "canonical", enrolment_id: "123", profile_type: "contractor" }
  ].map((row) => ({
    ...row,
    company_id: "company",
    worker_type: "individual_contract",
    account_id: "owner",
    employee_id: null,
    field_executive_id: null,
    location_id: "station",
    status: "Active",
    effective_from: "2026-09-01",
    effective_to: null
  }));
  const windows = buildHistoricalBiometricOwnershipWindows({
    fromDate: "2026-09-01",
    mappings,
    toDate: "2026-09-30"
  });

  assert.equal(windows.length, 1);
  assert.equal(windows[0].kind, "resolved");
  assert.equal(windows[0].owner?.account_id, "owner");
});

test("padded same-owner mappings are reused while a padded different owner conflicts", () => {
  const padded = {
    id: "padded",
    enrolment_id: "000123",
    profile_type: "worker",
    worker_type: "individual_contract",
    account_id: "helper"
  };
  const desired = {
    enrolment_id: "123",
    profile_type: "worker",
    worker_type: "individual_contract",
    account_id: "helper"
  };
  const otherOwner = { ...padded, id: "other", account_id: "other-helper" };

  assert.deepEqual(
    partitionCurrentBiometricEnrolmentVariants([padded], desired, "123"),
    { conflicts: [], duplicates: [], keeper: padded }
  );
  assert.deepEqual(
    partitionCurrentBiometricEnrolmentVariants([padded, otherOwner], desired, "123"),
    { conflicts: [otherOwner], duplicates: [], keeper: padded }
  );
});

test("biometric reassignment starts today without overlapping prior ownership", () => {
  const common = {
    assignmentDate: "2026-10-11",
    existingEffectiveFrom: null,
    hasPriorIdHistory: false,
    hasPriorPersonMapping: false,
    requestedEffectiveFrom: "2026-09-01"
  };

  assert.deepEqual(resolveBiometricAssignmentWindow(common), {
    effectiveFrom: "2026-09-01",
    isReassignment: false,
    priorEffectiveTo: "2026-10-10"
  });
  assert.deepEqual(resolveBiometricAssignmentWindow({ ...common, hasPriorIdHistory: true }), {
    effectiveFrom: "2026-10-11",
    isReassignment: true,
    priorEffectiveTo: "2026-10-10"
  });
  assert.deepEqual(resolveBiometricAssignmentWindow({ ...common, hasPriorPersonMapping: true }), {
    effectiveFrom: "2026-10-11",
    isReassignment: true,
    priorEffectiveTo: "2026-10-10"
  });
  assert.deepEqual(resolveBiometricAssignmentWindow({
    ...common,
    existingEffectiveFrom: "2026-08-15",
    hasPriorIdHistory: true
  }), {
    effectiveFrom: "2026-08-15",
    isReassignment: false,
    priorEffectiveTo: "2026-10-10"
  });
});

test("a biometric location transfer is a new assignment window", () => {
  const current = { location_id: "old-location" };
  assert.equal(isSameBiometricAssignmentLocation(current, "old-location"), true);
  assert.equal(isSameBiometricAssignmentLocation(current, "new-location"), false);
});

test("same-category historical owners remain ambiguous and are never replayed", () => {
  const windows = buildHistoricalBiometricOwnershipWindows({
    fromDate: "2026-09-01",
    mappings: ["first", "second"].map((account, index) => ({
      id: `mapping-${index}`,
      company_id: "company",
      enrolment_id: index ? "00123" : "123",
      worker_type: "individual_contract",
      profile_type: "contractor",
      account_id: account,
      employee_id: null,
      field_executive_id: null,
      location_id: "station",
      status: "Active",
      effective_from: "2026-09-01",
      effective_to: null
    })),
    toDate: "2026-09-30"
  });

  assert.equal(windows.length, 1);
  assert.equal(windows[0].kind, "ambiguous");
  assert.equal(windows[0].owner, null);
  assert.match(workerSource, /ownership\.kind === "ambiguous"/);
  assert.match(workerSource, /ownershipVerified: true/);
});

test("historical ownership is split only at effective-date boundaries", () => {
  const mappings = [
    {
      id: "old", company_id: "company", enrolment_id: "00099", worker_type: "individual_contract",
      profile_type: "vendor", account_id: "old-owner", employee_id: null, field_executive_id: null,
      location_id: "station", status: "Inactive", effective_from: "2026-09-01", effective_to: "2026-09-14"
    },
    {
      id: "new", company_id: "company", enrolment_id: "99", worker_type: "individual_contract",
      profile_type: "vendor", account_id: "new-owner", employee_id: null, field_executive_id: null,
      location_id: "station", status: "Active", effective_from: "2026-09-15", effective_to: null
    }
  ];
  const windows = buildHistoricalBiometricOwnershipWindows({
    fromDate: "2026-09-01",
    mappings,
    toDate: "2026-09-30"
  });
  assert.deepEqual(windows.map((window) => [window.fromDate, window.toDate, window.owner?.id]), [
    ["2026-09-01", "2026-09-14", "old"],
    ["2026-09-15", "2026-09-30", "new"]
  ]);
});

test("recurring pages rotate deterministically across the mapped population", () => {
  const now = new Date("2026-10-11T05:00:00.000Z");
  const first = rotatingAttendanceReconciliationOffset({ batchSize: 16, now, total: 730 });
  const second = rotatingAttendanceReconciliationOffset({
    batchSize: 16,
    now: new Date(now.getTime() + 15 * 60_000),
    total: 730
  });
  assert.equal(second, (first + 16) % 730);
});

test("cron is strictly authenticated, deadline-bounded, idempotent through backfill, and scheduled", () => {
  assert.match(routeSource, /process\.env\.CRON_SECRET/);
  assert.match(routeSource, /authorization/);
  assert.match(routeSource, /maxDuration - 45/);
  assert.match(routeSource, /fetchCache = ["']force-no-store["']/);
  assert.match(workerSource, /backfillHistoricalPunches/);
  assert.match(workerSource, /buildHistoricalBiometricOwnershipWindows/);
  assert.match(workerSource, /effectiveFrom:\s*ownership\.fromDate/);
  assert.match(workerSource, /effectiveTo:\s*ownership\.toDate/);
  assert.doesNotMatch(workerSource, /result\.nextCursor = Math\.min\(\.\.\.result\.failures/);
  assert.match(workerSource, /Failure cursors are returned separately/);
  assert.match(vercel, /\/api\/cron\/attendance-reconciliation/);
});
