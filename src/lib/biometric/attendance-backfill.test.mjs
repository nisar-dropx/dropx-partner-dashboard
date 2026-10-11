import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildAttendancePunchMergePlan,
  isPendingAttendanceReviewPunch,
  RECONCILIATION_PROMOTABLE_PUNCH_FILTER,
  selectAttendancePunchSummaryRows,
  shouldClearStalePresentDaily
} from "./attendance-rebuild-policy.ts";

const attendanceSource = readFileSync(new URL("./attendance.ts", import.meta.url), "utf8");

test("historical mapping dates become an inclusive IST punch window", () => {
  const start = attendanceSource.indexOf("export function historicalPunchTimeWindow");
  const end = attendanceSource.indexOf("async function historicalEnrolmentWindow", start);
  assert.ok(start >= 0 && end > start, "expected the historical punch window helper");
  const window = attendanceSource.slice(start, end);

  assert.match(window, /istDateTime\(fromDate, "00:00"\)\.toISOString\(\)/);
  assert.match(window, /istDateTime\(addIsoDateDays\(toDate, 1\), "00:00"\)\.toISOString\(\)/);
});

test("historical backfill scans TimeLogs directly within the mapping window", () => {
  const start = attendanceSource.indexOf("export async function backfillHistoricalPunches");
  const end = attendanceSource.indexOf("function reportMatchesType", start);
  assert.ok(start >= 0 && end > start, "expected the historical backfill implementation");
  const backfill = attendanceSource.slice(start, end);

  assert.match(backfill, /\.from\("biometric_raw_events"\)/);
  assert.match(backfill, /\.ilike\("event_type", "timelog"\)/);
  assert.match(backfill, /rawQuery\.gte\("punch_time", window\.startAt\)/);
  assert.match(backfill, /rawQuery\.lt\("punch_time", window\.endBefore\)/);
  assert.doesNotMatch(backfill, /select\("raw_event_id"\)/);
  assert.match(backfill, /buildHistoricalBiometricOwnershipWindows/);
  assert.match(backfill, /isSameBiometricOwner/);
  assert.match(backfill, /if \(args\.ownershipVerified\)/);
});

test("historical backfill calculates and rebuilds every mapped profile status", () => {
  const start = attendanceSource.indexOf("export async function backfillHistoricalPunches");
  const end = attendanceSource.indexOf("function reportMatchesType", start);
  const backfill = attendanceSource.slice(start, end);

  assert.match(backfill, /await resolveAttendanceWorkDate\(/);
  assert.match(backfill, /calculated: true/);
  assert.doesNotMatch(backfill, /calculated: isActive/);
  assert.doesNotMatch(backfill, /if \(isActive\)/);
  assert.match(backfill, /for \(const punchDate of Array\.from\(affectedDates\)\.sort\(\)\)/);
  assert.match(backfill, /await rebuildAttendanceDay\(companyId, enrolmentId, punchDate\)/);
});

test("historical backfill never reactivates a punch held for manager review", () => {
  assert.equal(isPendingAttendanceReviewPunch({ calculated: false, isFlagged: true }), true);
  assert.equal(isPendingAttendanceReviewPunch({ calculated: false, isFlagged: false }), false);
  assert.equal(isPendingAttendanceReviewPunch({ calculated: true, isFlagged: true }), false);
  assert.equal(
    RECONCILIATION_PROMOTABLE_PUNCH_FILTER,
    "is_flagged.is.null,is_flagged.eq.false"
  );

  const start = attendanceSource.indexOf("async function backfillResolvedHistoricalPunches");
  const end = attendanceSource.indexOf("function reportMatchesType", start);
  const backfill = attendanceSource.slice(start, end);
  const promotionStart = backfill.indexOf("const promote = await supabaseAdmin");
  const promotionEnd = backfill.indexOf("if (promote.error)", promotionStart);
  const promotion = backfill.slice(promotionStart, promotionEnd);
  assert.match(backfill, /ignoreDuplicates: true/);
  assert.match(backfill, /\.in\("raw_event_id", rawEventIds\)[\s\S]*?\.eq\("calculated", false\)[\s\S]*?\.or\(RECONCILIATION_PROMOTABLE_PUNCH_FILTER\)/);
  assert.match(backfill, /\.or\(RECONCILIATION_PROMOTABLE_PUNCH_FILTER\)/);
  assert.match(backfill, /Never rewrite an already-calculated punch/);
  assert.doesNotMatch(promotion, /enrolment_id:/);
  assert.match(promotion, /Preserve the retained row's enrolment spelling/);
  assert.match(backfill, /database predicates also close[\s\S]*?the race/);
});

test("daily attendance snapshots resolve the canonical Helpers table", () => {
  const start = attendanceSource.indexOf("export async function loadDailyWorkerSnapshot");
  const end = attendanceSource.indexOf("export async function rebuildAttendanceDay", start);
  const snapshotLoader = attendanceSource.slice(start, end);

  assert.match(
    snapshotLoader,
    /profileType === "worker"[\s\S]*?\["helpers", table, "workforce_helpers", "workforce_pickers"\]/
  );
});

test("reconciliation preserves approved manual attendance days", () => {
  const start = attendanceSource.indexOf("export async function rebuildAttendanceDay");
  const end = attendanceSource.indexOf("type HistoricalRawPunchRow", start);
  const rebuild = attendanceSource.slice(start, end);

  assert.match(
    rebuild,
    /select\("enrolment_id,punch_date,punch_count,status,work_mode,remark,in_source,out_source,manual_in_request_id,manual_out_request_id"\)/
  );
  assert.match(rebuild, /\.in\("enrolment_id", enrolmentVariants\)/);
  const dailyQueryStart = rebuild.indexOf('.from("attendance_daily")');
  const dailyQueryEnd = rebuild.indexOf("]);", dailyQueryStart);
  assert.ok(dailyQueryStart >= 0 && dailyQueryEnd > dailyQueryStart, "expected the existing daily rows query");
  assert.doesNotMatch(rebuild.slice(dailyQueryStart, dailyQueryEnd), /\.limit\(1\)/);
  assert.match(
    rebuild,
    /\(existingDailyResult\.data \?\? \[\]\)\.some\(\(row\) => isManualRegularizationDay\(row as DailyRow\)\)/
  );
  assert.match(rebuild, /authoritative daily summary/);
});

test("holding the last owner punch clears only stale biometric Present summaries", () => {
  assert.equal(shouldClearStalePresentDaily({ hasHeldOwnerPunch: true, status: "P", workMode: "onsite" }), true);
  assert.equal(shouldClearStalePresentDaily({ hasHeldOwnerPunch: false, status: "P", workMode: "onsite" }), false);
  assert.equal(shouldClearStalePresentDaily({ hasHeldOwnerPunch: true, status: "A", workMode: "onsite" }), false);
  assert.equal(shouldClearStalePresentDaily({ hasHeldOwnerPunch: true, status: "P", workMode: "wfh" }), false);
  assert.equal(shouldClearStalePresentDaily({ hasHeldOwnerPunch: true, status: "P", workMode: "business_trip" }), false);
  assert.equal(shouldClearStalePresentDaily({ hasHeldOwnerPunch: true, inSource: "app_gps", status: "P", workMode: "onsite" }), false);

  const start = attendanceSource.indexOf("export async function rebuildAttendanceDay");
  const end = attendanceSource.indexOf("type HistoricalRawPunchRow", start);
  const rebuild = attendanceSource.slice(start, end);
  const manualGuard = rebuild.indexOf("isManualRegularizationDay");
  const staleClear = rebuild.indexOf("shouldClearStalePresentDaily");
  const ambiguityGuard = rebuild.indexOf('ownership.kind === "ambiguous"');
  assert.ok(manualGuard >= 0 && manualGuard < staleClear, "manual attendance must win before stale cleanup");
  assert.ok(ambiguityGuard >= 0 && ambiguityGuard < staleClear, "ambiguous ownership must stop before cleanup");
  assert.match(rebuild, /select\("[^"]*calculated,is_flagged,source"\)/);
  assert.match(rebuild, /isPendingAttendanceReviewPunch\(\{ calculated: punch\.calculated, isFlagged: punch\.is_flagged \}\)/);
  assert.match(rebuild, /if \(resolvedOwner && distinctMappedOwnerCount === 1 && !punches\.length && heldOwnerPunches\.length\)/);
  assert.match(rebuild, /inSource: row\.in_source,[\s\S]*?outSource: row\.out_source/);
  assert.match(rebuild, /stalePresentDelete/);
});

test("daily rebuild resolves historical ownership before choosing punch snapshots", () => {
  const start = attendanceSource.indexOf("export async function rebuildAttendanceDay");
  const end = attendanceSource.indexOf("type HistoricalRawPunchRow", start);
  const rebuild = attendanceSource.slice(start, end);

  assert.match(rebuild, /from\("biometric_enrolments"\)/);
  assert.match(rebuild, /resolveBiometricCandidate/);
  assert.match(rebuild, /if \(ownership\.kind === "ambiguous"\) return/);
  assert.match(rebuild, /isSameBiometricOwner\(punch, resolvedOwner\)/);
  assert.match(rebuild, /if \(resolvedOwner && !punches\.length\) return/);
  assert.match(rebuild, /buildAttendancePunchMergePlan/);
  assert.doesNotMatch(rebuild, /from\("attendance_integrity_flags"\)/);
  assert.doesNotMatch(rebuild, /from\("attendance_location_reviews"\)/);
  assert.doesNotMatch(rebuild, /from\("attendance_punches"\)[\s\S]{0,300}?\.delete\(\)/);
  assert.match(rebuild, /if \(canonicalUpdate\.error\) throw/);
  assert.doesNotMatch(rebuild, /const staleVariants =/);
  assert.match(rebuild, /Padded attendance_daily rows are retained/);
});

test("daily station keeps the punch-time location after a later profile transfer", () => {
  const start = attendanceSource.indexOf("export async function loadDailyWorkerSnapshot");
  const end = attendanceSource.indexOf("export async function rebuildAttendanceDay", start);
  const snapshotLoader = attendanceSource.slice(start, end);

  assert.match(snapshotLoader, /let locationId = fallbackLocationId \?\? null/);
  assert.match(snapshotLoader, /locationId \?\?= employee\.data\.location_id \?\? null/);
  assert.match(snapshotLoader, /locationId \?\?= profile\.data\.location_id \?\? null/);
  assert.doesNotMatch(snapshotLoader, /locationId = (?:employee|profile)\.data\.location_id \?\? locationId/);
});

test("canonical punch merge prefers held, GPS evidence, then canonical spelling", () => {
  const common = {
    punch_time: "2026-09-15T03:30:00.000Z",
    owner_key: "employee:owner",
    calculated: true,
    is_flagged: false,
    source: "biometric"
  };
  const held = { ...common, id: "held", enrolment_id: "000123", calculated: false, is_flagged: true };
  const gps = { ...common, id: "gps", enrolment_id: "000123", source: "app_gps" };
  const canonical = { ...common, id: "canonical", enrolment_id: "123" };
  const padded = { ...common, id: "padded", enrolment_id: "000123" };

  assert.equal(buildAttendancePunchMergePlan([canonical, held, gps], "123")[0].keeper.id, "held");
  assert.equal(buildAttendancePunchMergePlan([canonical, gps], "123")[0].keeper.id, "gps");
  const canonicalPlan = buildAttendancePunchMergePlan([padded, canonical], "123")[0];
  assert.equal(canonicalPlan.keeper.id, "canonical");
  assert.deepEqual(canonicalPlan.shadowed.map((row) => row.id), ["padded"]);
});

test("canonical punch merge is deterministic and preserves the held row state", () => {
  const held = {
    id: "held-evidence",
    enrolment_id: "000123",
    punch_time: "2026-09-15T03:30:00.000Z",
    owner_key: "employee:owner",
    calculated: false,
    is_flagged: true,
    source: "app_gps",
    raw_event_id: "raw-held"
  };
  const calculated = {
    id: "calculated-twin",
    enrolment_id: "123",
    punch_time: held.punch_time,
    owner_key: "employee:owner",
    calculated: true,
    is_flagged: false,
    source: "biometric",
    raw_event_id: "raw-calculated"
  };
  const plan = buildAttendancePunchMergePlan([calculated, held], "123")[0];

  assert.equal(plan.keeper, held);
  assert.equal(plan.keeper.raw_event_id, "raw-held");
  assert.equal(plan.keeper.calculated, false);
  assert.equal(plan.keeper.is_flagged, true);
  assert.deepEqual(plan.shadowed, [calculated]);
  assert.equal(plan.canonicalize, false);
});

test("physical merge keeps same-time evidence from different devices while daily summary collapses it", () => {
  const common = {
    punch_time: "2026-09-15T03:30:00.000Z",
    enrolment_id: "123",
    owner_key: "employee:owner",
    calculated: true,
    is_flagged: false
  };
  const biometric = {
    ...common,
    id: "biometric",
    device_serial: "BIO-1",
    source: "biometric"
  };
  const gps = {
    ...common,
    id: "gps",
    device_serial: "APP-GPS",
    source: "app_gps"
  };

  const merge = buildAttendancePunchMergePlan([biometric, gps], "123");
  assert.equal(merge.length, 2);
  assert.equal(merge.flatMap((group) => group.shadowed).length, 0);
  assert.deepEqual(selectAttendancePunchSummaryRows([biometric, gps], "123"), [gps]);

  const heldGps = { ...gps, calculated: false, is_flagged: true };
  assert.deepEqual(selectAttendancePunchSummaryRows([biometric, heldGps], "123"), [biometric]);
});

test("shared-ID owners never destructively merge and a canonical lower owner blocks reassignment", () => {
  const common = {
    device_serial: "BIO-1",
    punch_time: "2026-09-15T03:30:00.000Z",
    calculated: true,
    source: "biometric"
  };
  const canonicalLowerOwner = {
    ...common,
    id: "lower-canonical",
    enrolment_id: "123",
    owner_key: "contractor:lower",
    preferred_owner: false,
    is_flagged: false
  };
  const paddedPreferredOwner = {
    ...common,
    id: "preferred-padded",
    enrolment_id: "000123",
    owner_key: "employee:preferred",
    preferred_owner: true,
    is_flagged: false
  };
  const heldLowerOwner = {
    ...canonicalLowerOwner,
    id: "lower-held",
    enrolment_id: "000123",
    calculated: false,
    is_flagged: true,
    source: "app_gps"
  };

  const plan = buildAttendancePunchMergePlan([paddedPreferredOwner, canonicalLowerOwner], "123");
  assert.equal(plan.length, 2);
  assert.equal(plan.flatMap((group) => group.shadowed).length, 0);
  assert.equal(plan.find((group) => group.ownerKey === "contractor:lower")?.keeper, canonicalLowerOwner);
  assert.equal(plan.find((group) => group.ownerKey === "contractor:lower")?.canonicalize, true);
  assert.equal(plan.find((group) => group.ownerKey === "employee:preferred")?.canonicalize, false);

  const heldPlan = buildAttendancePunchMergePlan(
    [paddedPreferredOwner, canonicalLowerOwner, heldLowerOwner],
    "123"
  );
  const lowerHeldGroup = heldPlan.find((group) => group.ownerKey === "contractor:lower");
  assert.equal(lowerHeldGroup?.keeper, heldLowerOwner);
  assert.deepEqual(lowerHeldGroup?.shadowed, [canonicalLowerOwner]);
  assert.equal(lowerHeldGroup?.canonicalize, false);
  assert.equal(
    heldPlan.find((group) => group.ownerKey === "employee:preferred")?.canonicalize,
    false
  );

  const preferredSummary = selectAttendancePunchSummaryRows([paddedPreferredOwner], "123");
  assert.deepEqual(preferredSummary, [paddedPreferredOwner]);
});
