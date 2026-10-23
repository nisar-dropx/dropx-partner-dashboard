import assert from "node:assert/strict";
import test from "node:test";

import {
  payableBalanceMonthRange,
  payableBalanceMonthSequence,
  peoplePayrollFinalPayable,
  reconcilePayableBalance,
  summarizePayableBalance,
  summarizePayableBalanceByMonthAndSource,
  summarizePayableBalanceBySource
} from "./payable-balance.ts";

const target = (source, month, identity, targetAmount) => ({ source, month, identity, targetAmount });
const payment = (source, month, identity, paidAmount) => ({ source, month, identity, paidAmount });

test("reconciles targets and actual settlements at person/location grain", () => {
  const grains = reconcilePayableBalance([
    target("workforce", "2026-09", "w1|x", 1000),
    target("workforce", "2026-09", "w1|x", 1000),
    target("workforce", "2026-09", "w2|x", 500)
  ], [
    payment("workforce", "2026-09", "w1|x", 400),
    payment("workforce", "2026-09", "w1|x", 100)
  ]);
  assert.deepEqual(grains, [
    { source: "workforce", month: "2026-09", identity: "w1|x", grandTotal: 1000, actualPaidAmount: 500, paidAmount: 500, payableBalance: 500, overpaidAmount: 0 },
    { source: "workforce", month: "2026-09", identity: "w2|x", grandTotal: 500, actualPaidAmount: 0, paidAmount: 0, payableBalance: 500, overpaidAmount: 0 }
  ]);
  assert.deepEqual(summarizePayableBalance(grains), {
    grandTotal: 1500,
    actualPaidAmount: 500,
    paidAmount: 500,
    payableBalance: 1000,
    overpaidAmount: 0,
    recordCount: 2
  });
});

test("an overpayment is visible but never offsets another payable record", () => {
  const grains = reconcilePayableBalance([
    target("helpers", "2026-09", "h1|a", 100),
    target("helpers", "2026-09", "h2|a", 200)
  ], [payment("helpers", "2026-09", "h1|a", 150)]);
  assert.deepEqual(summarizePayableBalance(grains), {
    grandTotal: 300,
    actualPaidAmount: 150,
    paidAmount: 100,
    payableBalance: 200,
    overpaidAmount: 50,
    recordCount: 2
  });
});

test("paid history without a live target remains a fully settled grain", () => {
  const grains = reconcilePayableBalance([], [payment("people_payroll", "2026-08", "run|person", 999.75)]);
  assert.deepEqual(grains[0], {
    source: "people_payroll",
    month: "2026-08",
    identity: "run|person",
    grandTotal: 999.75,
    actualPaidAmount: 999.75,
    paidAmount: 999.75,
    payableBalance: 0,
    overpaidAmount: 0
  });
});

test("a known zero target remains zero and reports its settlement as overpaid", () => {
  const grains = reconcilePayableBalance(
    [target("workforce", "2026-09", "w0|x", 0)],
    [payment("workforce", "2026-09", "w0|x", 4752)]
  );
  assert.deepEqual(grains[0], {
    source: "workforce",
    month: "2026-09",
    identity: "w0|x",
    grandTotal: 0,
    actualPaidAmount: 4752,
    paidAmount: 0,
    payableBalance: 0,
    overpaidAmount: 4752
  });
  assert.equal(summarizePayableBalance(grains).recordCount, 1);
  assert.equal(summarizePayableBalance(
    reconcilePayableBalance([target("workforce", "2026-09", "w0|y", 0)], [])
  ).recordCount, 0);
});

test("all-pending summaries exclude fully settled identities and preserve sources", () => {
  const grains = reconcilePayableBalance([
    target("people_payroll", "2026-08", "p1", 100),
    target("workforce", "2026-09", "w1|a", 300),
    target("helpers", "2026-09", "h1|a", 50)
  ], [
    payment("people_payroll", "2026-08", "p1", 100),
    payment("workforce", "2026-09", "w1|a", 125)
  ]);
  assert.deepEqual(summarizePayableBalance(grains, { pendingOnly: true }), {
    grandTotal: 350,
    actualPaidAmount: 125,
    paidAmount: 125,
    payableBalance: 225,
    overpaidAmount: 0,
    recordCount: 2
  });
  const bySource = summarizePayableBalanceBySource(grains, { pendingOnly: true });
  assert.equal(bySource.length, 3);
  assert.equal(bySource.find((row) => row.source === "people_payroll")?.recordCount, 0);
  assert.equal(bySource.find((row) => row.source === "workforce")?.payableBalance, 175);
  assert.equal(bySource.find((row) => row.source === "helpers")?.payableBalance, 50);
  assert.deepEqual(summarizePayableBalanceByMonthAndSource(grains, { pendingOnly: true }).map((row) => [row.month, row.source]), [
    ["2026-09", "workforce"],
    ["2026-09", "helpers"]
  ]);
});

test("People Payroll salary holds match current and legacy storage", () => {
  assert.equal(peoplePayrollFinalPayable({ net_pay: 1000, adjusted_net_pay: null, hr_payroll_run_items: [] }), 1000);
  assert.equal(peoplePayrollFinalPayable({
    net_pay: 1000,
    adjusted_net_pay: null,
    hr_payroll_run_items: [{ code: "SALARY_HOLD", item_type: "hold", amount: 250 }]
  }), 750);
  // Legacy rows already deducted the hold from net; adding and subtracting it
  // keeps the final payable at the stored net.
  assert.equal(peoplePayrollFinalPayable({
    net_pay: 750,
    adjusted_net_pay: null,
    hr_payroll_run_items: [{ code: "salary_hold", item_type: "deduction", amount: 250 }]
  }), 750);
  assert.equal(peoplePayrollFinalPayable({
    net_pay: 750,
    adjusted_net_pay: 800,
    hr_payroll_run_items: [{ code: "SALARY_HOLD", item_type: "deduction", amount: 250 }]
  }), 800);
});

test("month validation accepts only canonical calendar months", () => {
  assert.deepEqual(payableBalanceMonthRange("2026-02"), { start: "2026-02-01", end: "2026-02-28" });
  assert.deepEqual(payableBalanceMonthRange("2028-02"), { start: "2028-02-01", end: "2028-02-29" });
  assert.equal(payableBalanceMonthRange("2026-13"), null);
  assert.equal(payableBalanceMonthRange("September 2026"), null);
  assert.deepEqual(payableBalanceMonthSequence("2026-08", "2026-10"), ["2026-08", "2026-09", "2026-10"]);
  assert.deepEqual(payableBalanceMonthSequence("2026-10", "2026-08"), []);
});
