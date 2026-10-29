import assert from "node:assert/strict";
import test from "node:test";
import { attendanceCredit, dateRange, nextVendorPeriod, vendorBillingAmounts } from "./vendor-billing.ts";

test("fixed contracts support monthly, quarterly, half-yearly and annual periods", () => {
  assert.deepEqual(nextVendorPeriod("2026-01-01", 3), {
    periodStart: "2026-01-01",
    periodEnd: "2026-03-31",
    nextPeriodStart: "2026-04-01"
  });
  assert.equal(nextVendorPeriod("2026-01-31", 1).periodEnd, "2026-02-27");
});

test("missing daily marks are deducted from fixed rent", () => {
  assert.deepEqual(vendorBillingAmounts({
    attendanceRequired: true,
    expectedUnits: 30,
    mode: "fixed_cycle",
    presentUnits: 27,
    rateAmount: 30000
  }), {
    expectedUnits: 30,
    presentUnits: 27,
    absentUnits: 3,
    grossAmount: 30000,
    deductionAmount: 3000,
    payableAmount: 27000
  });
});

test("daily attendance pays only positively marked days", () => {
  const result = vendorBillingAmounts({
    attendanceRequired: true,
    expectedUnits: 31,
    mode: "daily_attendance",
    presentUnits: 20.5,
    rateAmount: 800
  });
  assert.equal(result.payableAmount, 16400);
  assert.equal(result.deductionAmount, 8400);
  assert.equal(attendanceCredit("HD"), 0.5);
  assert.equal(attendanceCredit(null, 0), 0);
  assert.equal(attendanceCredit(null, 1), 1);
});

test("date range is inclusive", () => {
  assert.deepEqual(dateRange("2026-10-30", "2026-11-01"), ["2026-10-30", "2026-10-31", "2026-11-01"]);
});
