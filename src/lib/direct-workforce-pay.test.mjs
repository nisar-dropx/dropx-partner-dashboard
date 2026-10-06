import assert from "node:assert/strict";
import test from "node:test";
import { cumulativeDirectPayAttendanceUnitsBefore, directPayForDay, monthlyDailyAccrual, preferredDirectPayAttendance } from "./direct-workforce-pay.ts";
import {
  monthlyAttendanceAmountForDay,
  workforcePaymentExample,
  workforcePaymentMethodFields,
  workforcePaymentPolicyForDate,
  workforcePaymentMonthIsFinalized
} from "./workforce-payment-policy.ts";

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

test("direct pay lines follow the configured payment-field order", () => {
  const result = directPayForDay({ FIELD_A: 100, FIELD_B: 200, FIELD_C: 300 }, [
    { component_code: "FIELD_B", component_type: "amount", pay_schedule: "per_day", sort_order: 2 },
    { component_code: "FIELD_C", component_type: "amount", pay_schedule: "per_day", sort_order: 3 },
    { component_code: "FIELD_A", component_type: "amount", pay_schedule: "per_day", sort_order: 1 }
  ], "2026-10-01", { punch_date: "2026-10-01", status: "P", work_minutes: 480 });

  assert.deepEqual(result.lines.map((line) => line.code), ["FIELD_A", "FIELD_B", "FIELD_C"]);
  assert.deepEqual(result.lines.map((line) => line.sortOrder), [1, 2, 3]);
});

test("monthly accrual conserves paise across a month", () => {
  const total = Array.from({ length: 30 }, (_, index) => monthlyDailyAccrual(1000, `2026-09-${String(index + 1).padStart(2, "0")}`))
    .reduce((sum, amount) => sum + amount, 0);
  assert.equal(Math.round(total * 100) / 100, 1000);
});

test("workforce monthly policy supports fixed and earned paid offs without exceeding the monthly amount", () => {
  const fixed = { calculation_method: "fixed_paid_offs", paid_off_days: 4, work_units_per_paid_off: 6, cap_at_monthly_amount: true, effective_from: "2026-09-01" };
  const earned = { ...fixed, calculation_method: "earned_paid_offs" };
  assert.equal(workforcePaymentExample(fixed, 5), 3461.54);
  assert.equal(workforcePaymentExample(fixed, 10), 6923.08);
  assert.equal(workforcePaymentExample(fixed, 26), 18000);
  assert.equal(workforcePaymentExample(fixed, 30), 18000);
  assert.equal(workforcePaymentExample(earned, 5), 3000);
  assert.equal(workforcePaymentExample(earned, 10), 6600);
  assert.equal(workforcePaymentExample(earned, 26), 18000);
  assert.equal(workforcePaymentExample(earned, 30), 18000);
});

test("earned paid off is credited on the configured attendance threshold", () => {
  const policy = { calculation_method: "earned_paid_offs", paid_off_days: 4, work_units_per_paid_off: 6, cap_at_monthly_amount: true, effective_from: "2026-09-01" };
  const fifth = monthlyAttendanceAmountForDay({ monthlyAmount: 18000, date: "2026-09-05", attendanceUnit: 1, cumulativeAttendanceUnitsBefore: 4, policy });
  const sixth = monthlyAttendanceAmountForDay({ monthlyAmount: 18000, date: "2026-09-06", attendanceUnit: 1, cumulativeAttendanceUnitsBefore: 5, policy });
  assert.equal(fifth.amount, 600);
  assert.equal(sixth.amount, 1200);
  assert.equal(sixth.creditedPaidOffUnits, 1);
});

test("earned paid off attendance restarts when a new dated payment allocation begins", () => {
  const attendance = new Map(Array.from({ length: 6 }, (_, index) => {
    const date = `2026-09-${String(index + 1).padStart(2, "0")}`;
    return [date, { punch_date: date, status: "P" }];
  }));
  const cumulative = cumulativeDirectPayAttendanceUnitsBefore("2026-09-06", "2026-09-06", (date) => attendance.get(date));
  const result = directPayForDay({ MONTHLY: 18000 }, [{
    component_code: "MONTHLY",
    component_type: "amount",
    pay_schedule: "per_month",
    calculation_type: "fixed_monthly",
    calculation_source: "attendance_eligibility"
  }], "2026-09-06", attendance.get("2026-09-06"), {
    cumulativeAttendanceUnitsBefore: cumulative,
    policyHistory: [{ calculation_method: "earned_paid_offs", paid_off_days: 4, work_units_per_paid_off: 6, cap_at_monthly_amount: true, effective_from: "2026-09-01" }]
  });

  assert.equal(cumulative, 0);
  assert.equal(result.total, 600);
});

test("payment policies are selected by effective month and default to existing calendar attendance", () => {
  const history = [
    { calculation_method: "fixed_paid_offs", paid_off_days: 4, work_units_per_paid_off: 6, cap_at_monthly_amount: true, effective_from: "2026-10-01" },
    { calculation_method: "earned_paid_offs", paid_off_days: 4, work_units_per_paid_off: 6, cap_at_monthly_amount: true, effective_from: "2026-11-01" }
  ];
  assert.equal(workforcePaymentPolicyForDate(history, "2026-09-30").calculation_method, "calendar_days");
  assert.equal(workforcePaymentPolicyForDate(history, "2026-10-15").calculation_method, "fixed_paid_offs");
  assert.equal(workforcePaymentPolicyForDate(history, "2026-11-01").calculation_method, "earned_paid_offs");
});

test("settings require only the fields used by the selected payment method", () => {
  assert.deepEqual(workforcePaymentMethodFields("calendar_days"), {
    paidOffDays: false,
    workUnitsPerPaidOff: false
  });
  assert.deepEqual(workforcePaymentMethodFields("fixed_paid_offs"), {
    paidOffDays: true,
    workUnitsPerPaidOff: false
  });
  assert.deepEqual(workforcePaymentMethodFields("earned_paid_offs"), {
    paidOffDays: true,
    workUnitsPerPaidOff: true
  });
});

test("only the selected month locks when its payroll is finalized", () => {
  assert.equal(workforcePaymentMonthIsFinalized("2026-03-01", [
    { period_start: "2026-03-01", period_end: "2026-03-31" }
  ]), true);
  assert.equal(workforcePaymentMonthIsFinalized("2026-02-01", [
    { period_start: "2026-03-01", period_end: "2026-03-31" }
  ]), false);
  assert.equal(workforcePaymentMonthIsFinalized("2026-12-01", [
    { period_start: "2027-01-01", period_end: "2027-01-31" }
  ]), false);
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

test("shipment attendance fails closed for hourly payment heads", () => {
  const result = directPayForDay({ HOURLY: 100 }, [{
    component_code: "HOURLY",
    component_type: "amount",
    pay_schedule: "per_hour",
    calculation_source: "attendance_eligibility"
  }], "2026-09-01", { punch_date: "2026-09-01", status: "P" }, {
    attendanceSource: "shipment_data"
  });

  assert.equal(result.total, 0);
  assert.equal(result.missing, true);
  assert.deepEqual(result.lines, []);
});

test("present bulk attendance without minutes fails closed for hourly payment heads", () => {
  const result = directPayForDay({ HOURLY: 100 }, [{
    component_code: "HOURLY",
    component_type: "amount",
    pay_schedule: "per_hour",
    calculation_source: "attendance_eligibility"
  }], "2026-09-01", { punch_date: "2026-09-01", status: "P", work_minutes: null }, {
    attendanceSource: "biometric"
  });

  assert.equal(result.total, 0);
  assert.equal(result.missing, true);
  assert.deepEqual(result.lines, []);
});
