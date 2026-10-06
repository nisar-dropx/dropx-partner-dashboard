import assert from "node:assert/strict";
import test from "node:test";
import { consolidateProviderPayoutSegments } from "./provider-payout-consolidation.ts";
import { directPayForDay } from "./direct-workforce-pay.ts";

function segment({ id, methodId, method, from, to, rate, units, amount, paymentSetupKey, locationId = "station" }) {
  const days = [];
  for (let day = from; day <= to; day += 1) {
    const date = `2026-09-${String(day).padStart(2, "0")}`;
    const dailyAmount = amount / (to - from + 1);
    days.push({ date, workDayUnits: 1, attendanceSource: "Biometric", methodAmounts: [{ id: methodId, label: method, amount: dailyAmount }], baseAmount: dailyAmount, lines: [{ code: "PAY", label: "Pay", componentType: "amount", count: units / (to - from + 1), rate, amount: dailyAmount, sortOrder: 1 }] });
  }
  return {
    workforceId: "worker-1",
    categoryCode: "workforce",
    panNumber: null,
    paymentSetupKey,
    row: {
      id, dropxId: "DROPX1", dropxStatus: "Active", name: "Worker", designation: "DA", providerMemberId: "P1", providerMemberName: "Provider worker", locationId, location: locationId, provider: "Amazon", model: "EDSP", paymentMethod: method, mappingStatus: "Mapped", paymentDetailsAvailable: true, workDays: days.length, workDaysSource: "Biometric", history: [], paymentMethodBreakdown: [{ id: methodId, label: method, amount }], production: units, productionBreakdown: [], dailyBreakdown: days, baseAmount: amount, additions: 0, grossPayment: amount, deductions: 0, deductionBreakdown: [], panAadhaarStatus: "NOT LINKED", netAmount: amount, status: "Ready for review"
    }
  };
}

test("adjacent fixed and packet segments become one person-level payout", () => {
  const fixed = segment({ id: "fixed", methodId: "fixed", method: "Fixed pay", from: 1, to: 5, rate: 600, units: 5, amount: 3000 });
  const packet = segment({ id: "packet", methodId: "packet", method: "Per packet", from: 6, to: 30, rate: 10, units: 1000, amount: 10000 });
  const result = consolidateProviderPayoutSegments([fixed, packet]);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].row.dailyBreakdown.length, 30);
  assert.equal(result.rows[0].row.workDays, 30);
  assert.equal(result.rows[0].row.grossPayment, 13000);
  assert.deepEqual(result.rows[0].row.paymentMethodBreakdown.map((method) => [method.label, method.amount]), [["Fixed pay", 3000], ["Per packet", 10000]]);
});

test("fixed monthly biometric pay stops at the method boundary", () => {
  const component = {
    component_code: "FIXED_MONTHLY",
    component_type: "amount",
    pay_schedule: "per_month",
    calculation_type: "fixed_monthly",
    calculation_source: "attendance_eligibility"
  };
  const fixedAmount = Array.from({ length: 5 }, (_, index) => {
    const date = `2026-09-${String(index + 1).padStart(2, "0")}`;
    return directPayForDay({ FIXED_MONTHLY: 18000 }, [component], date, { punch_date: date, status: "P", work_minutes: 480 }).total;
  }).reduce((sum, amount) => sum + amount, 0);
  assert.equal(fixedAmount, 3000);

  const fixed = segment({ id: "fixed", methodId: "fixed", method: "Fixed pay", from: 1, to: 5, rate: 18000, units: 5 / 30, amount: fixedAmount });
  const packet = segment({ id: "packet", methodId: "packet", method: "Per packet", from: 6, to: 30, rate: 10, units: 1000, amount: 10000 });
  const result = consolidateProviderPayoutSegments([fixed, packet]);
  assert.equal(result.rows[0].row.grossPayment, 13000);
  assert.equal(result.rows[0].row.paymentMethodBreakdown.find((method) => method.id === "fixed")?.amount, 3000);
});

test("different rates remain separate breakup lines", () => {
  const first = segment({ id: "first", methodId: "first", method: "First", from: 1, to: 1, rate: 10, units: 2, amount: 20 });
  const second = segment({ id: "second", methodId: "second", method: "Second", from: 2, to: 2, rate: 15, units: 2, amount: 30 });
  const result = consolidateProviderPayoutSegments([first, second]);
  assert.deepEqual(result.rows[0].row.productionBreakdown.map((line) => line.rate), [10, 15]);
});

test("overlapping mapping periods are rejected instead of double-paid", () => {
  const first = segment({ id: "first", methodId: "first", method: "First", from: 1, to: 5, rate: 10, units: 5, amount: 50 });
  const second = segment({ id: "second", methodId: "second", method: "Second", from: 5, to: 7, rate: 15, units: 3, amount: 45 });
  const result = consolidateProviderPayoutSegments([first, second]);
  assert.deepEqual(result.conflicts, ["worker-1"]);
  assert.equal(result.rows.length, 0);
});

test("simultaneous provider IDs with the same payment setup merge without double-counting work days", () => {
  const first = segment({ id: "provider-a", methodId: "packets", method: "Per packet", from: 1, to: 1, rate: 10, units: 7, amount: 70, paymentSetupKey: "same-setup" });
  const second = segment({ id: "provider-b", methodId: "packets", method: "Per packet", from: 1, to: 1, rate: 10, units: 5, amount: 50, paymentSetupKey: "same-setup" });
  first.row.providerMemberId = "P1";
  second.row.providerMemberId = "P2";

  const result = consolidateProviderPayoutSegments([first, second]);

  assert.deepEqual(result.conflicts, []);
  assert.equal(result.rows[0].row.dailyBreakdown.length, 1);
  assert.equal(result.rows[0].row.workDays, 1);
  assert.equal(result.rows[0].row.grossPayment, 120);
  assert.equal(result.rows[0].row.providerMemberId, "P1 / P2");
});

test("the same workforce remains one payout row per location", () => {
  const first = segment({ id: "station-a", methodId: "fixed-a", method: "Fixed A", from: 1, to: 1, rate: 100, units: 1, amount: 100, locationId: "station-a" });
  const second = segment({ id: "station-b", methodId: "fixed-b", method: "Fixed B", from: 1, to: 1, rate: 200, units: 1, amount: 200, locationId: "station-b" });

  const result = consolidateProviderPayoutSegments([first, second]);

  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.rows.map(({ row }) => [row.locationId, row.grossPayment]), [
    ["station-a", 100],
    ["station-b", 200]
  ]);
  assert.equal(new Set(result.rows.map(({ row }) => row.id)).size, 2);
});

test("aggregate WORK_DAYS settlement is not clamped to one day", () => {
  const aggregate = segment({ id: "aggregate", methodId: "daily", method: "Daily", from: 5, to: 5, rate: 100, units: 4.5, amount: 450 });
  aggregate.row.dailyBreakdown[0].workDayUnits = 4.5;
  aggregate.row.dailyBreakdown[0].attendanceSource = "Bulk upload range";
  aggregate.row.dailyBreakdown[0].attendanceRange = {
    basis: "days",
    quantity: 4.5,
    effectiveFrom: "2026-09-01",
    effectiveTo: "2026-09-05"
  };

  const result = consolidateProviderPayoutSegments([aggregate]);

  assert.equal(result.rows[0].row.workDays, 4.5);
  assert.equal(result.rows[0].row.workDaysSource, "Bulk upload range");
  assert.deepEqual(result.rows[0].row.dailyBreakdown[0].attendanceRange, aggregate.row.dailyBreakdown[0].attendanceRange);
  assert.equal(result.rows[0].row.grossPayment, 450);
});
