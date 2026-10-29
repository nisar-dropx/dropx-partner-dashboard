import assert from "node:assert/strict";
import test from "node:test";
import {
  applyWorkforceLossRecoveries,
  isMissingLossRecoveryFunction,
  workforceLossRecoveryMonth
} from "./workforce-loss-recovery.ts";

const row = (id, subject, net, extra = {}) => ({
  id, reviewSubjectType: "workforce", reviewSubjectId: subject,
  grossPayment: net, deductions: 0, netAmount: net, deductionBreakdown: [], ...extra
});
const line = (key, amount, worker = "w1", month = "2026-10") => ({
  recovery_key: `2026-09|${key}|workforce:${worker}`, month: "2026-09", case_key: key, report: "nl",
  worker_id: worker, employee_code: "W1", amount, deduction_month: month, label: `NL loss · Sep 2026 · ${key}`
});

test("only a whole calendar month carries loss recoveries", () => {
  assert.equal(workforceLossRecoveryMonth("2026-10-01", "2026-10-31"), "2026-10");
  assert.equal(workforceLossRecoveryMonth("2027-02-01", "2027-02-28"), "2027-02");
  assert.equal(workforceLossRecoveryMonth("2028-02-01", "2028-02-29"), "2028-02");
  assert.equal(workforceLossRecoveryMonth("2026-10-01", "2026-10-15"), null);
  assert.equal(workforceLossRecoveryMonth("2026-10-02", "2026-10-31"), null);
  assert.equal(workforceLossRecoveryMonth("2026-10-05", "2026-10-05"), null);
});

test("adds each due line to the worker's largest payout row with its recovery key", () => {
  const rows = [row("a", "w1", 3000), row("b", "w1", 9000), row("c", "w2", 5000)];
  applyWorkforceLossRecoveries(rows, [line("A", 400), line("B", 600)]);
  assert.equal(rows[0].deductions, 0);
  assert.deepEqual(rows[1].deductionBreakdown.map((l) => [l.code, l.amount, l.recoveryKey]), [
    ["LOSS_RECOVERY", 400, "2026-09|A|workforce:w1"],
    ["LOSS_RECOVERY", 600, "2026-09|B|workforce:w1"]
  ]);
  assert.equal(rows[1].deductions, 1000);
  assert.equal(rows[1].netAmount, 8000);
  assert.equal(rows[2].netAmount, 5000);
});

test("never part-recovers: a line larger than the remaining net moves to the next month", () => {
  const rows = [row("a", "w1", 1000)];
  const { carried } = applyWorkforceLossRecoveries(rows, [line("A", 800), line("B", 300)]);
  assert.deepEqual(rows[0].deductionBreakdown.map((l) => l.amount), [800]);
  assert.deepEqual(carried.map((l) => l.case_key), ["B"]);
  assert.equal(rows[0].netAmount, 200);
});

test("a worker with no payout row this month carries every line", () => {
  const rows = [row("a", "w2", 1000)];
  const { carried } = applyWorkforceLossRecoveries(rows, [line("A", 100)]);
  assert.equal(carried.length, 1);
  assert.equal(rows[0].deductions, 0);
});

test("helper rows are never charged and a line is never added twice", () => {
  const rows = [row("h", "w1", 5000, { reviewSubjectType: "helper" }), row("a", "w1", 5000)];
  applyWorkforceLossRecoveries(rows, [line("A", 100)]);
  applyWorkforceLossRecoveries(rows, [line("A", 100)]);
  assert.equal(rows[0].deductions, 0);
  assert.equal(rows[1].deductionBreakdown.length, 1);
  assert.equal(rows[1].netAmount, 4900);
});

test("oldest salary month first", () => {
  const rows = [row("a", "w1", 500)];
  applyWorkforceLossRecoveries(rows, [line("NEW", 500, "w1", "2026-11"), line("OLD", 500, "w1", "2026-10")]);
  assert.deepEqual(rows[0].deductionBreakdown.map((l) => l.recoveryKey), ["2026-09|OLD|workforce:w1"]);
});

test("a database without the recovery function loads payouts without losses", () => {
  assert.equal(isMissingLossRecoveryFunction({ code: "PGRST202", message: "Could not find the function public.nl_loss_recovery_due" }), true);
  assert.equal(isMissingLossRecoveryFunction({ code: "57014", message: "canceling statement due to statement timeout" }), false);
  assert.equal(isMissingLossRecoveryFunction(null), false);
});

test("legacy percentage caps are ignored; available pay is still enforced", () => {
  const capped = (key, amount, extra = {}) => ({ ...line(key, amount), cap_percent: "50", ...extra });
  const rows = [row("a", "w1", 1000)];
  const { carried } = applyWorkforceLossRecoveries(rows, [capped("A", 300), capped("B", 300)]);
  assert.deepEqual(rows[0].deductionBreakdown.map((l) => l.amount), [300, 300]);
  assert.deepEqual(carried.map((l) => l.case_key), []);
  assert.equal(rows[0].netAmount, 400);
  const exemptRows = [row("a", "w1", 1000)];
  applyWorkforceLossRecoveries(exemptRows, [capped("A", 300), capped("B", 600, { cap_exempt: true, final_settlement: true })]);
  assert.equal(exemptRows[0].netAmount, 100);
  const over = [row("a", "w1", 500)];
  assert.equal(applyWorkforceLossRecoveries(over, [capped("A", 600, { cap_exempt: true })]).carried.length, 1);
});

test("an instalment line keeps its own recovery key", () => {
  const rows = [row("a", "w1", 1000)];
  applyWorkforceLossRecoveries(rows, [{ ...line("A", 250), recovery_key: "2026-09|A|workforce:w1|2", installment_no: 2, installment_count: 4 }]);
  assert.equal(rows[0].deductionBreakdown[0].recoveryKey, "2026-09|A|workforce:w1|2");
});

test("recalculation does not repeat a case when the largest station row changes", () => {
  const rows = [row("a", "w1", 1100), row("b", "w1", 1000)];
  applyWorkforceLossRecoveries(rows, [line("A", 300)]);
  applyWorkforceLossRecoveries(rows, [line("A", 300)]);
  assert.equal(rows.reduce((n, r) => n + r.deductions, 0), 300);
  assert.equal(rows.reduce((n, r) => n + r.netAmount, 0), 1800);
});


test("display groups shipment losses without modifying payroll keys or totals", async () => {
  const { groupWorkforceDeductionDisplay } = await import("./workforce-loss-recovery.ts");
  const rows = [row("a", "w1", 2000)];
  applyWorkforceLossRecoveries(rows, [line("A", 300), line("B", 600)]);
  const before = JSON.stringify(rows);
  const display = groupWorkforceDeductionDisplay([{ code: "TDS", label: "TDS", amount: 100 }, ...rows[0].deductionBreakdown]);
  assert.equal(display.lossTotal, 900);
  assert.equal(display.losses.length, 2);
  assert.deepEqual(display.other.map(item => item.code), ["TDS"]);
  assert.equal(JSON.stringify(rows), before);
  applyWorkforceLossRecoveries(rows, [line("A", 300), line("B", 600)]);
  assert.equal(rows[0].netAmount, 1100);
});
