import test from "node:test";
import assert from "node:assert/strict";
import { calculateProviderAttendancePayments, consumeProviderAttendanceAmount } from "./provider-attendance-payment.ts";

const component = (code, schedule, changes = {}) => ({
  component_code: code,
  component_type: "amount",
  label: code,
  pay_schedule: schedule,
  sort_order: 1,
  is_active: true,
  payment_fields: {
    code,
    label: code,
    field_type: "amount",
    pay_schedule: schedule,
    calculation_type: schedule === "per_month" ? "fixed_monthly" : "fixed_daily",
    calculation_source: "attendance_eligibility"
  },
  ...changes
});
const mapping = (changes = {}) => ({
  id: "map-a",
  payment_method_id: "method",
  payment_values: { DAILY: 800, MONTHLY: 18_000, HOURLY: 100 },
  effective_from: "2026-09-01",
  effective_to: null,
  status: "active",
  payment_methods: { id: "method", payment_method_components: [component("DAILY", "per_day")] },
  ...changes
});
const attendance = (id, punch_date, status = "P", work_minutes = 480) => ({ id, punch_date, status, work_minutes });

test("provider attendance heads pay full and half days but not absent days", () => {
  const result = calculateProviderAttendancePayments({
    mappings: [mapping()],
    attendance: [attendance("a", "2026-09-01"), attendance("b", "2026-09-02", "HD"), attendance("c", "2026-09-03", "A")],
    from: "2026-09-01",
    to: "2026-09-03"
  });
  assert.deepEqual(result.map((day) => [day.date, day.workDayUnits, day.amount]), [
    ["2026-09-01", 1, 800],
    ["2026-09-02", 0.5, 400]
  ]);
});

test("monthly and hourly provider heads use calendar proration and worked minutes", () => {
  const result = calculateProviderAttendancePayments({
    mappings: [mapping({
      payment_methods: { id: "method", payment_method_components: [component("MONTHLY", "per_month"), component("HOURLY", "per_hour", { sort_order: 2 })] }
    })],
    attendance: [attendance("a", "2026-09-01", "P", 240), attendance("b", "2026-09-02", "HD", 120)],
    from: "2026-09-01",
    to: "2026-09-02"
  });
  assert.deepEqual(result[0].lines.map((line) => [line.code, line.count, line.amount]), [
    ["MONTHLY", 1 / 30, 600],
    ["HOURLY", 4, 400]
  ]);
  assert.deepEqual(result[1].lines.map((line) => [line.code, line.count, line.amount]), [
    ["MONTHLY", 0.5 / 30, 300],
    ["HOURLY", 2, 200]
  ]);
});

test("provider monthly attendance pay uses the same paid-off policy as direct pay", () => {
  const result = calculateProviderAttendancePayments({
    mappings: [mapping({ payment_methods: { id: "method", payment_method_components: [component("MONTHLY", "per_month")] } })],
    attendance: Array.from({ length: 10 }, (_, index) => attendance(`a${index + 1}`, `2026-09-${String(index + 1).padStart(2, "0")}`)),
    policyHistory: [{ calculation_method: "earned_paid_offs", paid_off_days: 4, work_units_per_paid_off: 6, cap_at_monthly_amount: true, effective_from: "2026-09-01" }],
    from: "2026-09-01",
    to: "2026-09-10"
  });
  assert.equal(Math.round(result.reduce((sum, day) => sum + day.amount, 0) * 100) / 100, 6600);
});

test("production and legacy amount components remain outside provider attendance calculation", () => {
  const production = component("DELIVERY", null, {
    component_type: "production",
    payment_fields: { code: "DELIVERY", field_type: "production", calculation_type: "count_x_rate", calculation_source: "total_delivery" }
  });
  const legacy = component("LEGACY", "per_day", {
    payment_fields: { code: "LEGACY", field_type: "amount", pay_schedule: "per_day", calculation_type: "manual_input", calculation_source: null }
  });
  const result = calculateProviderAttendancePayments({
    mappings: [mapping({ payment_methods: { id: "method", payment_method_components: [production, legacy, component("DAILY", "per_day")] } })],
    attendance: [attendance("a", "2026-09-01")],
    from: "2026-09-01",
    to: "2026-09-01"
  });
  assert.deepEqual(result[0].lines.map((line) => line.code), ["DAILY"]);
  assert.equal(result[0].amount, 800);
});

test("identical provider IDs share one attendance amount per workforce day", () => {
  const result = calculateProviderAttendancePayments({
    mappings: [mapping({ id: "map-a" }), mapping({ id: "map-b" })],
    attendance: [attendance("a", "2026-09-01")],
    from: "2026-09-01",
    to: "2026-09-01"
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].amount, 800);
});

test("conflicting provider attendance setups fail closed", () => {
  assert.throws(() => calculateProviderAttendancePayments({
    mappings: [mapping({ id: "map-a" }), mapping({ id: "map-b", payment_values: { DAILY: 900 } })],
    attendance: [attendance("a", "2026-09-01")],
    from: "2026-09-01",
    to: "2026-09-01"
  }), /Conflicting provider attendance payment allocations/);
});

test("missing attendance produces no provider attendance accrual", () => {
  const result = calculateProviderAttendancePayments({ mappings: [mapping()], attendance: [], from: "2026-09-01", to: "2026-09-02" });
  assert.deepEqual(result, []);
});

test("a shipment on a non-owner mapping cannot suppress the attendance owner's amount", () => {
  const providerAttendanceDays = calculateProviderAttendancePayments({
    mappings: [
      mapping({ id: "shipment-map", effective_from: "2026-09-01" }),
      mapping({ id: "attendance-owner", effective_from: "2026-09-02" })
    ],
    attendance: [attendance("a", "2026-09-02")],
    from: "2026-09-02",
    to: "2026-09-02"
  });
  const byMappingDate = new Map(providerAttendanceDays.map((day) => [`${day.mappingId}|${day.date}`, day]));
  const consumed = new Set();
  const shipmentAmount = consumeProviderAttendanceAmount(byMappingDate.get("shipment-map|2026-09-02"), consumed);
  const attendanceOwnerAmount = consumeProviderAttendanceAmount(providerAttendanceDays[0], consumed);

  assert.equal(shipmentAmount, 0);
  assert.equal(providerAttendanceDays[0].mappingId, "attendance-owner");
  assert.equal(attendanceOwnerAmount, 800);
  assert.equal(consumeProviderAttendanceAmount(providerAttendanceDays[0], consumed), 0);
});
