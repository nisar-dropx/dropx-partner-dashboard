import assert from "node:assert/strict";
import test from "node:test";
import { calculateWorkforceIncentives } from "./workforce-incentive-calculation.ts";

const plan = {
  id: "plan-1", company_id: "company", code: "FK-CONV", name: "Flipkart conversion",
  provider_id: "flipkart", location_model_id: "odh", station_id: null, designation_id: "wishmaster",
  incentive_type: "conversion", cycle_type: "half_monthly", metric: "delivery_conversion",
  calculation_type: "tiered_flat", threshold_value: 0, rate_value: 0, flat_amount: 0, maximum_amount: null,
  minimum_activity: 10, tiers: [{ minimum: 80, amount: 500 }, { minimum: 90, amount: 750 }],
  effective_from: "2026-10-01", effective_to: "2026-12-31", status: "active", approved_at: "2026-10-01T00:00:00Z"
};
const source = (id, date, assigned, delivered, pickup = 0) => ({
  id, workDate: date, providerId: "flipkart", locationModelId: "odh", stationId: "station",
  totalDelivery: delivered, totalActivity: delivered + pickup, amazonDelivery: 0, swaDelivery: 0,
  customerReturn: pickup, mfn: 0, deliveryAssignedCount: assigned
});
const attendancePlan = {
  ...plan,
  id: "attendance-plan",
  code: "AMZ-ATT",
  name: "Amazon attendance bonus",
  provider_id: "amazon",
  location_model_id: "edsp",
  incentive_type: "attendance",
  cycle_type: "monthly",
  metric: "attendance_compliance",
  calculation_type: "flat_threshold",
  flat_amount: 1200,
  minimum_activity: 0,
  reporting_time: "07:30:00",
  minimum_present_days: 2,
  allowed_late_days: 1,
  tiers: []
};
const attendance = (id, date, inTime) => ({
  id,
  workDate: date,
  providerId: "amazon",
  locationModelId: "edsp",
  stationId: "station",
  inTime
});

test("Flipkart conversion uses delivery assigned only and awards the completed half-month tier", () => {
  const result = calculateWorkforceIncentives({
    companyId: "company", designationId: "wishmaster", from: "2026-10-01", to: "2026-10-15",
    plans: [plan], sources: [source("a", "2026-10-01", 80, 72, 100), source("b", "2026-10-02", 20, 18, 100)]
  });
  assert.equal(result.plans[0].cycles[0].metricValue, 90);
  assert.equal(result.amount, 750);
  assert.equal(result.bySource.get("a"), 600);
  assert.equal(result.bySource.get("b"), 150);
});

test("an incomplete half-month is visible but not payable", () => {
  const result = calculateWorkforceIncentives({
    companyId: "company", designationId: "wishmaster", from: "2026-10-01", to: "2026-10-10",
    plans: [plan], sources: [source("a", "2026-10-01", 100, 95)]
  });
  assert.equal(result.amount, 0);
  assert.equal(result.plans[0].cycles[0].status, "in_progress");
});

test("designation and model scopes prevent cross-plan payment", () => {
  const result = calculateWorkforceIncentives({
    companyId: "company", designationId: "driver", from: "2026-10-01", to: "2026-10-15",
    plans: [plan], sources: [source("a", "2026-10-01", 100, 95)]
  });
  assert.equal(result.amount, 0);
  assert.equal(result.plans.length, 0);
});

test("paused plans stop estimates while approved closed plans preserve their effective history", () => {
  const base = { companyId: "company", designationId: "wishmaster", from: "2026-10-01", to: "2026-10-31", sources: [source("source-1", "2026-10-15", 100, 95)] };
  assert.equal(calculateWorkforceIncentives({ ...base, plans: [{ ...plan, status: "paused" }] }).amount, 0);
  assert.equal(calculateWorkforceIncentives({ ...base, plans: [{ ...plan, status: "closed", approved_at: "2026-10-01T00:00:00Z" }] }).amount, 750);
});

test("disabled incentive plans never block the existing payout calculation", () => {
  const result = calculateWorkforceIncentives({
    companyId: "company",
    designationId: "designation",
    from: "2026-10-01",
    to: "2026-10-31",
    plans: [],
    sources: [
      { id: "", workDate: "invalid", providerId: "", locationModelId: null, stationId: null,
        totalDelivery: "invalid", totalActivity: null, amazonDelivery: null, swaDelivery: null,
        customerReturn: null, mfn: null, deliveryAssignedCount: null }
    ]
  });
  assert.equal(result.amount, 0);
  assert.equal(result.plans.length, 0);
  assert.equal(result.bySource.size, 0);
});

test("attendance bonus uses distinct biometric punch-ins and the configured IST reporting time", () => {
  const result = calculateWorkforceIncentives({
    companyId: "company", designationId: "wishmaster", from: "2026-10-01", to: "2026-10-31",
    plans: [attendancePlan], sources: [], attendance: [
      attendance("a", "2026-10-01", "2026-10-01T01:50:00.000Z"),
      attendance("b", "2026-10-02", "2026-10-02T02:15:00.000Z"),
      attendance("missing", "2026-10-03", null)
    ]
  });
  assert.equal(result.amount, 1200);
  assert.equal(result.plans[0].cycles[0].presentDays, 2);
  assert.equal(result.plans[0].cycles[0].lateDays, 1);
  assert.equal(result.plans[0].cycles[0].reportingTime, "07:30");
  assert.equal(result.bySource.size, 0);
});

test("attendance bonus stays unpaid when late exceptions exceed the configured allowance", () => {
  const result = calculateWorkforceIncentives({
    companyId: "company", designationId: "wishmaster", from: "2026-10-01", to: "2026-10-31",
    plans: [attendancePlan], sources: [], attendance: [
      attendance("a", "2026-10-01", "2026-10-01T02:15:00.000Z"),
      attendance("b", "2026-10-02", "2026-10-02T02:20:00.000Z")
    ]
  });
  assert.equal(result.amount, 0);
  assert.equal(result.plans[0].cycles[0].status, "not_qualified");
});
