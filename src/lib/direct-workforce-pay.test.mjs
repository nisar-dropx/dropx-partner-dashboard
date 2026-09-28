import assert from "node:assert/strict";
import test from "node:test";
import { directPayForDay, monthlyDailyAccrual, preferredDirectPayAttendance } from "./direct-workforce-pay.ts";

test("direct pay handles monthly, present-day and hourly amounts", () => {
  const result = directPayForDay({ MONTHLY: 31000, DAILY: 500, HOURLY: 100 }, [
    { component_code: "MONTHLY", component_type: "amount", pay_schedule: "per_month" },
    { component_code: "DAILY", component_type: "amount", pay_schedule: "per_day" },
    { component_code: "HOURLY", component_type: "amount", pay_schedule: "per_hour" }
  ], "2026-10-01", { punch_date: "2026-10-01", status: "P", in_time: "2026-10-01T03:00:00Z", work_minutes: 480 });
  assert.equal(result.total, 2300);
  assert.equal(result.present, true);
  assert.equal(result.missing, false);
});

test("monthly accrual conserves paise across a month", () => {
  const total = Array.from({ length: 30 }, (_, index) => monthlyDailyAccrual(1000, `2026-09-${String(index + 1).padStart(2, "0")}`))
    .reduce((sum, amount) => sum + amount, 0);
  assert.equal(Math.round(total * 100) / 100, 1000);
});

test("attendance-based monthly pay uses full, half and absent attendance units", () => {
  const component = {
    component_code: "MONTHLY",
    component_type: "amount",
    pay_schedule: "per_month",
    calculation_type: "fixed_monthly",
    calculation_source: "attendance_eligibility"
  };
  const present = directPayForDay({ MONTHLY: 3000 }, [component], "2026-09-01", { punch_date: "2026-09-01", status: "P", work_minutes: 480 });
  const halfDay = directPayForDay({ MONTHLY: 3000 }, [component], "2026-09-02", { punch_date: "2026-09-02", status: "HD", work_minutes: 240 });
  const absent = directPayForDay({ MONTHLY: 3000 }, [component], "2026-09-03", { punch_date: "2026-09-03", status: "A", work_minutes: 0 });
  const missingAttendance = directPayForDay({ MONTHLY: 3000 }, [component], "2026-09-04", null);

  assert.equal(present.total, 100);
  assert.equal(halfDay.total, 50);
  assert.equal(absent.total, 0);
  assert.equal(missingAttendance.total, 0);
  assert.equal(present.lines[0].count, 1 / 30);
  assert.equal(halfDay.lines[0].count, 0.5 / 30);
});

test("legacy monthly pay remains calendar-based when no attendance basis is configured", () => {
  const result = directPayForDay({ MONTHLY: 3000 }, [
    { component_code: "MONTHLY", component_type: "amount", pay_schedule: "per_month", calculation_type: "fixed_monthly" }
  ], "2026-09-01", null);
  assert.equal(result.total, 100);
  assert.equal(result.lines[0].count, 1 / 30);
});

test("provider-production components are rejected for direct allocations", () => {
  const result = directPayForDay({ DELIVERY: 10 }, [
    { component_code: "DELIVERY", component_type: "production", pay_schedule: null }
  ], "2026-09-01", null);
  assert.equal(result.total, 0);
  assert.equal(result.missing, true);
});

test("half-day attendance pays half of a per-day component", () => {
  const result = directPayForDay({ DAILY: 800 }, [
    { component_code: "DAILY", component_type: "amount", pay_schedule: "per_day" }
  ], "2026-09-01", { punch_date: "2026-09-01", status: "HD", in_time: "2026-09-01T03:00:00Z", work_minutes: 240 });
  assert.equal(result.total, 400);
  assert.equal(result.attendanceUnit, 0.5);
});

test("canonical present status remains payable when an imported daily row has no punch timestamp", () => {
  const result = directPayForDay({ DAILY: 800 }, [
    { component_code: "DAILY", component_type: "amount", pay_schedule: "per_day" }
  ], "2026-09-01", { punch_date: "2026-09-01", status: "P", work_minutes: 480 });
  assert.equal(result.total, 800);
  assert.equal(result.present, true);
});

test("duplicate daily rows select the strongest attendance record deterministically", () => {
  const selected = preferredDirectPayAttendance(
    { punch_date: "2026-09-01", status: "A", work_minutes: 0 },
    { punch_date: "2026-09-01", status: "HD", in_time: "2026-09-01T03:00:00Z", work_minutes: 240 }
  );
  assert.equal(selected.status, "HD");
});
