import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  requiredAttendanceBasisForComponents,
  validateAttendanceImportBases,
  validateAttendanceImportStability
} from "./attendance-basis.ts";

function attendanceRow(overrides = {}) {
  return {
    rowNumber: 2,
    action: "UPSERT",
    dropxId: "DX-001",
    inputType: "ATTENDANCE",
    fieldCode: "WORK_HOURS",
    workforceId: "worker-1",
    locationId: "station-1",
    effectiveDate: "2026-10-06",
    effectiveFrom: "2026-10-06",
    effectiveTo: "2026-10-31",
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

test("mixed hourly and day-based attendance components require configuration correction", () => {
  assert.equal(requiredAttendanceBasisForComponents([
    { componentType: "amount", calculationSource: "attendance_eligibility", paySchedule: "per_day" },
    { componentType: "amount", calculationSource: "attendance_eligibility", paySchedule: "per_hour" }
  ]), "mixed");

  const issues = validateAttendanceImportBases(
    [attendanceRow()],
    [allocation({ requiredBasis: "mixed" })]
  );
  assert.match(issues[0].message, /mixes hourly and daily\/monthly attendance pay/i);
  assert.match(issues[0].message, /cannot represent both WORK_HOURS and WORK_DAYS/i);
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
    [attendanceRow({ fieldCode: "WORK_DAYS", attendanceBasis: "days" })],
    [allocation({ requiredBasis: "days" })]
  ), []);
});

test("basis validation follows FIELD_CODE and identifies the required code", () => {
  const hourlyIssue = validateAttendanceImportBases(
    [attendanceRow({ fieldCode: "WORK_DAYS", attendanceBasis: "hours" })],
    [allocation({ requiredBasis: "hours" })]
  );
  assert.match(hourlyIssue[0].message, /FIELD_CODE WORK_DAYS is not valid/);
  assert.match(hourlyIssue[0].message, /Use FIELD_CODE WORK_HOURS/);

  const dailyIssue = validateAttendanceImportBases(
    [attendanceRow({ attendanceBasis: "hours" })],
    [allocation({ requiredBasis: "days" })]
  );
  assert.match(dailyIssue[0].message, /FIELD_CODE WORK_HOURS is not valid/);
  assert.match(dailyIssue[0].message, /Use FIELD_CODE WORK_DAYS/);
});

test("one attendance allocation must cover the complete aggregate range", () => {
  const row = attendanceRow({ effectiveFrom: "2026-10-01", effectiveDate: "2026-10-01" });
  assert.deepEqual(validateAttendanceImportBases([row], [allocation()]), []);

  const split = validateAttendanceImportBases([row], [
    allocation({ sourceId: "direct:first", effectiveTo: "2026-10-15" }),
    allocation({ sourceId: "direct:second", effectiveFrom: "2026-10-16" })
  ]);
  assert.match(split[0].message, /exactly one attendance payment allocation must cover the entire range/);
  assert.match(split[0].message, /Split the row at every payment-method or effective-date change/);

  const gap = validateAttendanceImportBases([row], [
    allocation({ sourceId: "direct:first", effectiveTo: "2026-10-15" }),
    allocation({ sourceId: "direct:second", effectiveFrom: "2026-10-17" })
  ]);
  assert.match(gap[0].message, /exactly one attendance payment allocation must cover the entire range/);

  const changedBasis = validateAttendanceImportBases([row], [
    allocation({ sourceId: "direct:hourly", effectiveTo: "2026-10-15" }),
    allocation({ sourceId: "direct:daily", effectiveFrom: "2026-10-16", requiredBasis: "days" })
  ]);
  assert.match(changedBasis[0].message, /exactly one attendance payment allocation must cover the entire range/);
});

test("attendance dates require a complete forward range", () => {
  const missingTo = validateAttendanceImportBases(
    [attendanceRow({ effectiveTo: "" })],
    [allocation()]
  );
  assert.match(missingTo[0].message, /EFFECTIVE_DATE and EFFECTIVE_TO are compulsory/);

  const backwards = validateAttendanceImportBases(
    [attendanceRow({ effectiveFrom: "2026-10-20", effectiveDate: "2026-10-20", effectiveTo: "2026-10-19" })],
    [allocation()]
  );
  assert.match(backwards[0].message, /EFFECTIVE_TO cannot be before EFFECTIVE_DATE/);
});

test("attendance preflight rejects a range that crosses a calendar month", () => {
  const row = attendanceRow({
    effectiveDate: "2026-10-20",
    effectiveFrom: "2026-10-20",
    effectiveTo: "2026-11-10"
  });
  const issues = validateAttendanceImportBases([row], [allocation({ effectiveTo: "2026-11-30" })]);
  assert.match(issues[0].message, /one calendar month/i);

  assert.deepEqual(validateAttendanceImportBases([
    { ...row, action: "CLEAR", attendanceBasis: null }
  ], []), [], "CLEAR must remain available for an exact historical repair");
});

test("missing, incompatible, and conflicting effective allocations are row-specific errors", () => {
  const row = attendanceRow();
  const missing = validateAttendanceImportBases([row], []);
  assert.deepEqual({ rowNumber: missing[0].rowNumber, dropxId: missing[0].dropxId }, { rowNumber: 2, dropxId: "DX-001" });
  assert.match(missing[0].message, /No effective payment allocation applies for 2026-10-06 to 2026-10-31/);

  const incompatible = validateAttendanceImportBases([row], [allocation({ requiredBasis: null })]);
  assert.match(incompatible[0].message, /no attendance-eligible hourly, daily, or monthly component/i);

  const conflicting = validateAttendanceImportBases([row], [
    allocation(),
    allocation({ sourceId: "provider:mapping-1", effectiveFrom: "2026-10-06", effectiveTo: null, requiredBasis: "days" })
  ]);
  assert.match(conflicting[0].message, /exactly one attendance payment allocation must cover the entire range/);
  assert.match(conflicting[0].message, /Split the row/);
});

test("non-attendance mappings are ignored but duplicate attendance sources are rejected", () => {
  assert.deepEqual(validateAttendanceImportBases([attendanceRow()], [
    allocation({ sourceId: "provider:mapping-1" }),
    allocation({ sourceId: "provider:production-only", requiredBasis: null })
  ]), []);

  const duplicate = validateAttendanceImportBases([attendanceRow()], [
    allocation({ sourceId: "provider:mapping-1" }),
    allocation({ sourceId: "provider:mapping-2" })
  ]);
  assert.match(duplicate[0].message, /exactly one attendance payment allocation must cover the entire range/);
});

test("CLEAR rows do not require a current payment allocation", () => {
  assert.deepEqual(validateAttendanceImportBases([
    attendanceRow({ action: "CLEAR", attendanceBasis: null, effectiveTo: "" })
  ], []), []);
});

test("aggregate attendance rejects an effective rate-override boundary", () => {
  const row = attendanceRow();
  const source = allocation({
    components: [{
      paymentFieldId: "field-hours",
      fieldCode: "ATTENDANCE_HOURS",
      componentType: "amount",
      calculationSource: "attendance_eligibility",
      paySchedule: "per_hour"
    }]
  });
  const boundary = {
    workforceId: "worker-1",
    locationId: "station-1",
    paymentFieldId: "field-hours",
    fieldCode: "ATTENDANCE_HOURS",
    effectiveFrom: "2026-10-15",
    effectiveTo: "2026-10-31"
  };
  const issues = validateAttendanceImportStability([row], [source], [boundary], []);
  assert.match(issues[0].message, /rate override begins or ends inside/i);

  assert.deepEqual(validateAttendanceImportStability([row], [source], [{
    ...boundary,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo
  }], []), [], "a whole-range override is a stable effective rate");
});

test("monthly aggregate attendance rejects a payment-policy change inside its range", () => {
  const row = attendanceRow({
    fieldCode: "WORK_DAYS",
    attendanceBasis: "days",
    effectiveFrom: "2026-10-01",
    effectiveDate: "2026-10-01",
    effectiveTo: "2026-11-30"
  });
  const source = allocation({
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    requiredBasis: "days",
    components: [{
      paymentFieldId: "field-monthly",
      fieldCode: "FIXED_PAY_PER_MONTH",
      componentType: "amount",
      calculationType: "fixed_monthly",
      calculationSource: "attendance_eligibility",
      paySchedule: "per_month"
    }]
  });
  const issues = validateAttendanceImportStability([row], [source], [], [{
    effectiveFrom: "2026-11-01",
    calculationMethod: "fixed_paid_offs",
    paidOffDays: 4,
    workUnitsPerPaidOff: 6,
    capAtMonthlyAmount: true
  }]);
  assert.match(issues[0].message, /payment policy changes inside/i);
});

test("the bulk route validates attendance ranges and preserves FIELD_CODE/VALUE payloads", () => {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  assert.match(source, /payment_fields\(field_type,pay_schedule,calculation_type,calculation_source\)/);
  assert.match(source, /validateAttendanceImportBases\(resolved\.rows, references\.attendanceAllocations\)/);
  assert.match(source, /validateAttendanceImportStability/);
  assert.match(source, /value: row\.numericValue \?\? row\.textValue/);
  assert.match(source, /effectiveDate: row\.effectiveDate \|\| row\.effectiveFrom/);
  assert.match(source, /text_value: row\.inputType === "ATTENDANCE" \? null : row\.textValue/);
  assert.match(source, /work_minutes: row\.inputType === "ATTENDANCE" \? null : row\.workMinutes/);
  assert.match(source, /item\.workDate >= row\.effectiveFrom/);
  assert.match(source, /item\.workDate <= row\.effectiveTo/);
  assert.match(source, /\.from\("workforce_payout_attendance_values"\)/);
  assert.match(source, /item\.effectiveFrom <= row\.effectiveTo/);
  assert.match(source, /item\.effectiveTo >= row\.effectiveFrom/);
  assert.match(source, /This exact attendance period already belongs to another location/);
  assert.match(source, /This attendance range partially overlaps the stored/);
  assert.doesNotMatch(source, /workHours: row\.workHours|workDays: row\.workDays/);
});
