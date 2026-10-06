import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveWorkforcePayoutDeductionContext,
  workforcePayoutDeductionLines,
  workforcePayoutDeductionTotal
} from "./workforce-deduction-overlay.ts";

const heads = [
  {
    id: "tds-id",
    code: "TDS",
    name: "TDS deduction",
    calculation_type: "percentage",
    default_value: 1,
    percentage_without_pan: 1,
    workforce_category_codes: ["workforce"],
    applies_to_all: true,
    is_system: true,
    is_active: true
  },
  {
    id: "damage-id",
    code: "DAMAGE",
    name: "Damage recovery",
    calculation_type: "manual",
    default_value: 0,
    percentage_without_pan: 0,
    workforce_category_codes: [],
    applies_to_all: false,
    is_system: false,
    is_active: true
  }
];

test("adds one uploaded manual deduction without changing automatic deductions", () => {
  const lines = workforcePayoutDeductionLines(10_000, heads, { categoryCode: "workforce" }, [{
    id: "value-1",
    deduction_head_id: "damage-id",
    workforce_id: "worker-1",
    station_id: "station-1",
    head_code_snapshot: "DAMAGE",
    head_name_snapshot: "Damage recovery",
    amount: 250
  }]);

  assert.deepEqual(lines, [
    { code: "TDS", label: "TDS deduction", amount: 100 },
    { code: "DAMAGE", label: "Damage recovery", amount: 250 }
  ]);
  assert.equal(workforcePayoutDeductionTotal(lines), 350);
});

test("preserves an explicit zero and historical snapshots", () => {
  const lines = workforcePayoutDeductionLines(0, [], {}, [{
    id: "value-2",
    deduction_head_id: "retired-head",
    workforce_id: "worker-1",
    station_id: "station-1",
    head_code_snapshot: "OTHER",
    head_name_snapshot: "Historical deduction",
    amount: 0
  }]);

  assert.deepEqual(lines, [{ code: "OTHER", label: "Historical deduction", amount: 0 }]);
  assert.equal(workforcePayoutDeductionTotal(lines), 0);
});

test("a stored manual value suppresses the same head after it is changed to automatic", () => {
  const editedHeads = heads.map((head) => head.id === "damage-id"
    ? {
        ...head,
        calculation_type: "fixed",
        default_value: 75,
        workforce_category_codes: ["workforce"],
        applies_to_all: true
      }
    : head);
  const lines = workforcePayoutDeductionLines(10_000, editedHeads, { categoryCode: "workforce" }, [{
    id: "value-3",
    deduction_head_id: "damage-id",
    workforce_id: "worker-1",
    station_id: "station-1",
    head_code_snapshot: "DAMAGE",
    head_name_snapshot: "Historical damage recovery",
    amount: 250
  }]);

  assert.deepEqual(lines, [
    { code: "TDS", label: "TDS deduction", amount: 100 },
    { code: "DAMAGE", label: "Historical damage recovery", amount: 250 }
  ]);
  assert.equal(workforcePayoutDeductionTotal(lines), 350);
});

test("manual-only payout rows exclude unrelated automatic deductions", () => {
  const lines = workforcePayoutDeductionLines(10_000, heads, { categoryCode: "workforce" }, [{
    id: "value-4",
    deduction_head_id: "damage-id",
    workforce_id: "worker-1",
    station_id: "station-1",
    head_code_snapshot: "DAMAGE",
    head_name_snapshot: "Damage recovery",
    amount: 250
  }], { includeAutomaticDeductions: false });

  assert.deepEqual(lines, [{ code: "DAMAGE", label: "Damage recovery", amount: 250 }]);
  assert.equal(workforcePayoutDeductionTotal(lines), 250);
});

test("attendance incentive preserves a canonical provider payout's workforce TDS context", () => {
  const payoutRowId = "provider-worker-1-station-1";
  const canonicalWorker = { source_profile_type: "contractor" };
  const canonicalMapping = { workforce_id: "worker-1", contractor_id: null, employee_id: null };
  const providerCategory = canonicalMapping.contractor_id
    ? "contractors"
    : canonicalMapping.employee_id
      ? "employees"
      : "workforce";
  const canonicalFallback = {
    categoryCode: canonicalWorker.source_profile_type === "contractor" ? "contractors" : "workforce",
    panNumber: "EQGPP2087A"
  };
  const context = resolveWorkforcePayoutDeductionContext(
    payoutRowId,
    new Map([[payoutRowId, { categoryCode: providerCategory, panNumber: "EQGPP2087A" }]]),
    canonicalFallback
  );
  const basePayment = 22_971;
  const attendanceIncentive = 1_767;
  const lines = workforcePayoutDeductionLines(basePayment + attendanceIncentive, heads, context);

  assert.equal(context.categoryCode, "workforce");
  assert.deepEqual(lines, [{ code: "TDS", label: "TDS deduction", amount: 247.38 }]);
});

test("adjustment-only payouts keep their canonical fallback deduction context", () => {
  const fallback = { categoryCode: "contractors", panNumber: null };
  assert.equal(
    resolveWorkforcePayoutDeductionContext("adjustment-only", new Map(), fallback),
    fallback
  );
});
