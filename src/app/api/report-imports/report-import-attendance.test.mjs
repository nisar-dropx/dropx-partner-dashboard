import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { directPayForDay } from "../../../lib/direct-workforce-pay.ts";
import {
  buildReportImportAttendanceByWorkforceDate,
  canonicalWorkforceForMapping,
  createReportImportWorkforceIndex
} from "./report-import-attendance.ts";

test("report imports resolve legacy attendance identities through canonical Workforce profiles", () => {
  const index = createReportImportWorkforceIndex([
    { id: "workforce-employee", source_profile_type: "employee", source_profile_id: "employee-1" },
    { id: "workforce-contractor", source_profile_type: "contractor", source_profile_id: "contractor-1" },
    { id: "workforce-executive", source_profile_type: "field_executive", source_profile_id: "executive-1" },
    { id: "workforce-canonical", source_profile_type: "canonical", source_profile_id: "workforce-canonical" }
  ]);

  assert.equal(canonicalWorkforceForMapping({ employee_id: "employee-1" }, index)?.id, "workforce-employee");
  assert.equal(canonicalWorkforceForMapping({ contractor_id: "contractor-1" }, index)?.id, "workforce-contractor");
  assert.equal(canonicalWorkforceForMapping({ field_executive_id: "executive-1" }, index)?.id, "workforce-executive");
  assert.equal(canonicalWorkforceForMapping({ workforce_id: "workforce-canonical" }, index)?.id, "workforce-canonical");

  const attendance = buildReportImportAttendanceByWorkforceDate([
    { id: "legacy-absent", employee_id: "employee-1", punch_date: "2026-09-01", status: "A", work_minutes: 0 },
    { id: "canonical-half", field_executive_id: "workforce-employee", punch_date: "2026-09-01", status: "HD", in_time: "2026-09-01T03:00:00Z", work_minutes: 240 },
    { id: "contractor-present", contractor_id: "contractor-1", punch_date: "2026-09-01", status: "P", work_minutes: 480 },
    { id: "canonical-present", field_executive_id: "workforce-canonical", punch_date: "2026-09-01", status: "P", work_minutes: 480 }
  ], index);

  assert.equal(attendance.get("workforce-employee|2026-09-01")?.id, "canonical-half");
  assert.equal(attendance.get("workforce-contractor|2026-09-01")?.id, "contractor-present");
  assert.equal(attendance.get("workforce-canonical|2026-09-01")?.id, "canonical-present");
});

test("report-import attendance components use daily units, monthly accrual and worked hours", () => {
  const components = [
    { component_code: "DAILY", component_type: "amount", pay_schedule: "per_day", calculation_type: "fixed_daily", calculation_source: "attendance_eligibility" },
    { component_code: "MONTHLY", component_type: "amount", pay_schedule: "per_month", calculation_type: "fixed_monthly", calculation_source: "attendance_eligibility" },
    { component_code: "HOURLY", component_type: "amount", pay_schedule: "per_hour", calculation_type: "fixed_daily", calculation_source: "attendance_eligibility" }
  ];
  const values = { DAILY: 800, MONTHLY: 3000, HOURLY: 100 };
  const present = directPayForDay(values, components, "2026-09-01", { punch_date: "2026-09-01", status: "P", work_minutes: 480 });
  const half = directPayForDay(values, components, "2026-09-02", { punch_date: "2026-09-02", status: "HD", work_minutes: 240 });
  const absent = directPayForDay(values, components, "2026-09-03", { punch_date: "2026-09-03", status: "A", work_minutes: 480 });
  const missing = directPayForDay(values, components, "2026-09-04", null);

  assert.deepEqual(present.lines.map((line) => line.amount), [800, 100, 800]);
  assert.deepEqual(half.lines.map((line) => line.amount), [400, 50, 400]);
  assert.equal(absent.total, 0);
  assert.equal(missing.total, 0);
});

test("report-import production components retain count-times-rate calculation", async () => {
  const route = await readFile(new URL("./route.ts", import.meta.url), "utf8");
  assert.match(route, /const amount = productionComponent\s*\? productionForSource\(row, source\) \* rate/);
  assert.match(route, /: attendanceComponent\s*\? directPayForDay/);
});
