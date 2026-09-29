import test from "node:test";
import assert from "node:assert/strict";
import { assertNoProviderDirectOverlap, calculateDirectWorkforcePayments, directAllocationForDate } from "./direct-workforce-payment.ts";

const allocation = (changes = {}) => ({
  id: "a1", workforce_id: "w1", payment_method_id: "method", payment_values: { DAILY: 800, MONTHLY: 3100, HOURLY: 100 },
  effective_from: "2026-09-01", effective_to: null, status: "active", ...changes
});
const method = (components) => ({ id: "method", name: "Attendance pay", payment_method_components: components });
const component = (code, schedule, changes = {}) => ({
  component_code: code, component_type: "amount", label: code, pay_schedule: schedule, sort_order: 1, is_active: true,
  payment_fields: { code, label: code, field_type: "amount", pay_schedule: schedule, calculation_type: "manual_input", calculation_source: null },
  ...changes
});
const day = (id, date, status = "P", work_minutes = 480) => ({ id, punch_date: date, status, work_minutes });

test("direct allocation pays full and half attendance days without a provider ID", () => {
  const result = calculateDirectWorkforcePayments({
    allocations: [allocation()], methods: [method([component("DAILY", "per_day")])],
    attendance: [day("d1", "2026-09-01"), day("d2", "2026-09-02", "HD"), day("d3", "2026-09-03", "A")], from: "2026-09-01", to: "2026-09-03"
  });
  assert.deepEqual(result.map((row) => [row.date, row.workDayUnits, row.amount]), [
    ["2026-09-01", 1, 800], ["2026-09-02", 0.5, 400]
  ]);
  assert.ok(result.every((row) => !Object.hasOwn(row, "providerMemberId")));
});

test("monthly components accrue by active calendar day while hourly components use canonical attendance", () => {
  const legacyMonthly = component("MONTHLY", "per_month", {
    calculation_type: "fixed_monthly",
    payment_fields: { code: "MONTHLY", label: "MONTHLY", field_type: "amount", pay_schedule: "per_month", calculation_type: "fixed_monthly", calculation_source: null }
  });
  const result = calculateDirectWorkforcePayments({
    allocations: [allocation()], methods: [method([legacyMonthly, component("HOURLY", "per_hour", { sort_order: 2 })])],
    attendance: [day("d1", "2026-09-15", "P", 240)], from: "2026-09-15", to: "2026-09-16"
  });
  assert.equal(result[0].lines[0].amount, 103.33);
  assert.equal(result[0].lines[1].amount, 400);
  assert.equal(result[0].amount, 503.33);
  assert.equal(result[1].lines[0].amount, 103.33);
  assert.equal(result[1].lines[1].amount, 0);
  assert.equal(result[1].amount, 103.33);
});

test("attendance-based monthly components pay only full and half attendance units", () => {
  const attendanceMonthly = component("MONTHLY", "per_month", {
    calculation_type: "fixed_monthly",
    calculation_source: "attendance_eligibility",
    payment_fields: { code: "MONTHLY", label: "MONTHLY", field_type: "amount", pay_schedule: "per_month", calculation_type: "fixed_monthly", calculation_source: "attendance_eligibility" }
  });
  const result = calculateDirectWorkforcePayments({
    allocations: [allocation({ payment_values: { MONTHLY: 3000 } })],
    methods: [method([attendanceMonthly])],
    attendance: [day("d1", "2026-09-01", "P"), day("d2", "2026-09-02", "HD"), day("d3", "2026-09-03", "A")],
    from: "2026-09-01",
    to: "2026-09-04"
  });
  assert.deepEqual(result.map((row) => [row.date, row.workDayUnits, row.amount]), [
    ["2026-09-01", 1, 100],
    ["2026-09-02", 0.5, 50]
  ]);
});

test("direct monthly attendance pay follows the effective paid-off policy", () => {
  const attendanceMonthly = component("MONTHLY", "per_month", {
    calculation_type: "fixed_monthly",
    calculation_source: "attendance_eligibility",
    payment_fields: { code: "MONTHLY", label: "MONTHLY", field_type: "amount", pay_schedule: "per_month", calculation_type: "fixed_monthly", calculation_source: "attendance_eligibility" }
  });
  const attendance = Array.from({ length: 30 }, (_, index) => day(`d${index + 1}`, `2026-09-${String(index + 1).padStart(2, "0")}`));
  const result = calculateDirectWorkforcePayments({
    allocations: [allocation({ payment_values: { MONTHLY: 18000 } })],
    methods: [method([attendanceMonthly])],
    attendance,
    policyHistory: [{ calculation_method: "fixed_paid_offs", paid_off_days: 4, work_units_per_paid_off: 6, cap_at_monthly_amount: true, effective_from: "2026-09-01" }],
    from: "2026-09-01",
    to: "2026-09-30"
  });
  assert.equal(Math.round(result.reduce((sum, row) => sum + row.amount, 0) * 100) / 100, 18000);
  assert.equal(Math.round(result.slice(0, 5).reduce((sum, row) => sum + row.amount, 0) * 100) / 100, 3461.54);
});

test("mid-month direct views retain month-to-date attendance context", () => {
  const attendanceMonthly = component("MONTHLY", "per_month", {
    calculation_type: "fixed_monthly",
    calculation_source: "attendance_eligibility",
    payment_fields: { code: "MONTHLY", label: "MONTHLY", field_type: "amount", pay_schedule: "per_month", calculation_type: "fixed_monthly", calculation_source: "attendance_eligibility" }
  });
  const attendance = Array.from({ length: 20 }, (_, index) => day(`d${index + 1}`, `2026-09-${String(index + 1).padStart(2, "0")}`));
  const policyHistory = [{ calculation_method: "earned_paid_offs", paid_off_days: 4, work_units_per_paid_off: 6, cap_at_monthly_amount: true, effective_from: "2026-09-01" }];
  const full = calculateDirectWorkforcePayments({ allocations: [allocation({ payment_values: { MONTHLY: 18000 } })], methods: [method([attendanceMonthly])], attendance, policyHistory, from: "2026-09-01", to: "2026-09-20" });
  const partial = calculateDirectWorkforcePayments({ allocations: [allocation({ payment_values: { MONTHLY: 18000 } })], methods: [method([attendanceMonthly])], attendance, policyHistory, from: "2026-09-15", to: "2026-09-20" });
  const expected = full.filter((row) => row.date >= "2026-09-15").reduce((sum, row) => sum + row.amount, 0);
  assert.equal(partial.reduce((sum, row) => sum + row.amount, 0), expected);
});

test("effective dates choose exactly one allocation and reject overlapping setup", () => {
  const old = allocation({ id: "old", effective_to: "2026-09-14" });
  const next = allocation({ id: "new", effective_from: "2026-09-15" });
  assert.equal(directAllocationForDate([old, next], "2026-09-14")?.id, "old");
  assert.equal(directAllocationForDate([old, next], "2026-09-15")?.id, "new");
  assert.throws(() => directAllocationForDate([old, allocation({ id: "bad", effective_from: "2026-09-14" })], "2026-09-14"), /Overlapping/);
});

test("production components and provider/direct overlap fail closed", () => {
  assert.throws(() => calculateDirectWorkforcePayments({
    allocations: [allocation()], methods: [method([component("DAILY", "per_day", { component_type: "production" })])], attendance: [day("d1", "2026-09-01")], from: "2026-09-01", to: "2026-09-01"
  }), /Production components/);
  assert.throws(() => assertNoProviderDirectOverlap({
    allocations: [allocation({ effective_from: "2026-09-10" })], mappings: [{ id: "p1", effective_from: "2026-09-01", effective_to: "2026-09-12" }], from: "2026-09-01", to: "2026-09-30"
  }), /overlap/);
  assert.doesNotThrow(() => assertNoProviderDirectOverlap({
    allocations: [allocation({ effective_from: "2026-09-13" })], mappings: [{ id: "p1", effective_from: "2026-09-01", effective_to: "2026-09-12" }], from: "2026-09-01", to: "2026-09-30"
  }));
});

test("duplicate attendance collapses to the strongest canonical row and invalid values never pay", () => {
  const result = calculateDirectWorkforcePayments({
    allocations: [allocation()], methods: [method([component("DAILY", "per_day")])],
    attendance: [day("d1", "2026-09-01", "A", 0), day("d2", "2026-09-01", "HD", 240)],
    from: "2026-09-01", to: "2026-09-01"
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].workDayUnits, 0.5);
  assert.equal(result[0].amount, 400);
  assert.throws(() => calculateDirectWorkforcePayments({
    allocations: [allocation({ payment_values: { DAILY: -1 } })], methods: [method([component("DAILY", "per_day")])], attendance: [day("d1", "2026-09-01")], from: "2026-09-01", to: "2026-09-01"
  }), /invalid rate/);
});

test("an imported attendance row with a punch but no canonical status is payable", () => {
  const result = calculateDirectWorkforcePayments({
    allocations: [allocation()], methods: [method([component("DAILY", "per_day")])],
    attendance: [{ id: "d1", punch_date: "2026-09-01", status: null, in_time: "2026-09-01T03:00:00Z", work_minutes: 480 }],
    from: "2026-09-01", to: "2026-09-01"
  });
  assert.equal(result[0].workDayUnits, 1);
  assert.equal(result[0].amount, 800);
});

test("stored component codes stay authoritative and unsupported schedules fail closed", () => {
  const result = calculateDirectWorkforcePayments({
    allocations: [allocation({ payment_values: { DAILY_COMPONENT: 750 } })],
    methods: [method([{ ...component("DAILY_COMPONENT", "per_day"), payment_fields: { code: "FIELD_CODE", label: "Daily", field_type: "amount", pay_schedule: "per_day", calculation_type: "fixed_daily" } }])],
    attendance: [day("d1", "2026-09-01")],
    from: "2026-09-01",
    to: "2026-09-01"
  });
  assert.equal(result[0].amount, 750);
  assert.equal(result[0].lines[0].code, "DAILY_COMPONENT");
  assert.throws(() => calculateDirectWorkforcePayments({
    allocations: [allocation({ payment_values: { UNSCHEDULED: 100 } })],
    methods: [method([{ ...component("UNSCHEDULED", null), payment_fields: { code: "UNSCHEDULED", label: "Unscheduled", field_type: "amount", pay_schedule: null, calculation_type: "manual_input" } }])],
    attendance: [day("d1", "2026-09-01")],
    from: "2026-09-01",
    to: "2026-09-01"
  }), /missing a per-hour/);
});

test("allocation component snapshots remain authoritative after the method master changes", () => {
  const result = calculateDirectWorkforcePayments({
    allocations: [allocation({
      payment_values: { DAILY: 800 },
      payment_components: [{ component_code: "DAILY", component_type: "amount", label: "Snapshotted daily pay", pay_schedule: "per_day", sort_order: 1 }]
    })],
    methods: [method([component("MONTHLY", "per_month", { label: "Changed master component" })])],
    attendance: [day("d1", "2026-09-01")],
    from: "2026-09-01",
    to: "2026-09-01"
  });
  assert.equal(result[0].amount, 800);
  assert.equal(result[0].lines[0].code, "DAILY");
  assert.equal(result[0].lines[0].label, "Snapshotted daily pay");
});

test("a component snapshot can be calculated even when the current method relation is unavailable", () => {
  const result = calculateDirectWorkforcePayments({
    allocations: [allocation({
      payment_values: { DAILY: 800 },
      payment_components: [component("DAILY", "per_day")]
    })],
    methods: [],
    attendance: [day("d1", "2026-09-01")],
    from: "2026-09-01",
    to: "2026-09-01"
  });
  assert.equal(result[0].amount, 800);
});
