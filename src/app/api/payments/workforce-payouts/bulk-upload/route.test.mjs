import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  requiredAttendanceBasisForComponents,
  validateAttendanceImportBases
} from "./attendance-basis.ts";

function attendanceRow(overrides = {}) {
  return {
    rowNumber: 2,
    action: "UPSERT",
    dropxId: "DX-001",
    inputType: "ATTENDANCE",
    workforceId: "worker-1",
    locationId: "station-1",
    effectiveDate: "2026-10-06",
    effectiveFrom: "2026-10-06",
    attendanceBasis: "hours",
    ...overrides
  };
}

function allocation(overrides = {}) {
  return {
    sourceId: "direct:allocation-1",
    workforceId: "worker-1",
    locationId: "station-1",
    effectiveFrom: "2026-10-01",
    effectiveTo: "2026-10-31",
    requiredBasis: "hours",
    ...overrides
  };
}

test("attendance payment components require hours whenever an hourly component is present", () => {
  assert.equal(requiredAttendanceBasisForComponents([
    { componentType: "amount", calculationSource: "attendance_eligibility", paySchedule: "per_day" },
    { componentType: "amount", calculationSource: "attendance_eligibility", paySchedule: "per_hour" }
  ]), "hours");
});

test("daily and monthly attendance components use WORK_DAYS", () => {
  assert.equal(requiredAttendanceBasisForComponents([
    { componentType: "amount", calculationSource: "attendance_eligibility", paySchedule: "per_month" }
  ]), "days");
  assert.equal(requiredAttendanceBasisForComponents([
    { componentType: "amount", calculationSource: "attendance_eligibility", paySchedule: "per_day" }
  ]), "days");
});

test("production and non-attendance components do not establish an attendance basis", () => {
  assert.equal(requiredAttendanceBasisForComponents([
    { componentType: "production", calculationSource: "attendance_eligibility", paySchedule: "per_hour" },
    { componentType: "amount", calculationSource: "manual", paySchedule: "per_day" }
  ]), null);
});

test("matching hour and day attendance uploads pass validation", () => {
  assert.deepEqual(validateAttendanceImportBases(
    [attendanceRow()],
    [allocation()]
  ), []);
  assert.deepEqual(validateAttendanceImportBases(
    [attendanceRow({ attendanceBasis: "days" })],
    [allocation({ requiredBasis: "days" })]
  ), []);
});

test("basis mismatches identify the supplied and required workbook columns", () => {
  const hourlyIssue = validateAttendanceImportBases(
    [attendanceRow({ attendanceBasis: "days" })],
    [allocation({ requiredBasis: "hours" })]
  );
  assert.match(hourlyIssue[0].message, /WORK_DAYS is not valid/);
  assert.match(hourlyIssue[0].message, /Upload WORK_HOURS/);

  const dailyIssue = validateAttendanceImportBases(
    [attendanceRow({ attendanceBasis: "hours" })],
    [allocation({ requiredBasis: "days" })]
  );
  assert.match(dailyIssue[0].message, /WORK_HOURS is not valid/);
  assert.match(dailyIssue[0].message, /Upload WORK_DAYS/);
});

test("missing, incompatible, and conflicting effective allocations are row-specific errors", () => {
  const row = attendanceRow();
  const missing = validateAttendanceImportBases([row], []);
  assert.deepEqual({ rowNumber: missing[0].rowNumber, dropxId: missing[0].dropxId }, { rowNumber: 2, dropxId: "DX-001" });
  assert.match(missing[0].message, /No effective payment allocation applies on 2026-10-06/);

  const incompatible = validateAttendanceImportBases([row], [allocation({ requiredBasis: null })]);
  assert.match(incompatible[0].message, /no attendance-eligible hourly, daily, or monthly component/i);

  const conflicting = validateAttendanceImportBases([row], [
    allocation(),
    allocation({ sourceId: "provider:mapping-1", effectiveFrom: "2026-10-06", effectiveTo: null, requiredBasis: "days" })
  ]);
  assert.match(conflicting[0].message, /Conflicting attendance payment allocations apply/);
  assert.match(conflicting[0].message, /WORK_HOURS and another requires WORK_DAYS/);
  assert.match(conflicting[0].message, /overlapping allocations/);
});

test("same-basis provider IDs are accepted and non-attendance mappings do not block them", () => {
  assert.deepEqual(validateAttendanceImportBases([attendanceRow()], [
    allocation({ sourceId: "provider:mapping-1" }),
    allocation({ sourceId: "provider:mapping-2" }),
    allocation({ sourceId: "provider:production-only", requiredBasis: null })
  ]), []);
});

test("CLEAR rows do not require a current payment allocation", () => {
  assert.deepEqual(validateAttendanceImportBases([
    attendanceRow({ action: "CLEAR", attendanceBasis: null })
  ], []), []);
});

test("the bulk route loads attendance metadata, validates rows, and returns hour/day preview values", () => {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  assert.match(source, /payment_fields\(field_type,pay_schedule,calculation_source\)/);
  assert.match(source, /validateAttendanceImportBases\(resolved\.rows, references\.attendanceAllocations\)/);
  assert.match(source, /workHours: row\.workHours/);
  assert.match(source, /workDays: row\.workDays/);
});
