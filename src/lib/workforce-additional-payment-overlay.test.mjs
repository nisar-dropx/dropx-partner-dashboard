import assert from "node:assert/strict";
import test from "node:test";
import { workforceAdditionalPaymentLines, workforceAdditionalPaymentTotal } from "./workforce-additional-payment-overlay.ts";

const fields = [
  { id: "manual", code: "BONUS", name: "Bonus", calculation_type: "manual_amount", default_rate_value: null, is_active: true },
  { id: "units", code: "KM", name: "Kilometre incentive", calculation_type: "units_x_rate", default_rate_value: 3, is_active: true }
];

test("uploaded manual and unit values use their stored amount and rate snapshots once", () => {
  const lines = workforceAdditionalPaymentLines(1_000, fields, [
    { id: "v1", additional_payment_field_id: "manual", workforce_id: "w", field_code_snapshot: "BONUS", field_name_snapshot: "Bonus", calculation_type_snapshot: "manual_amount", input_value: 250, rate_value: null, final_amount: 250 },
    { id: "v2", additional_payment_field_id: "units", workforce_id: "w", field_code_snapshot: "KM", field_name_snapshot: "Kilometre incentive", calculation_type_snapshot: "units_x_rate", input_value: 20, rate_value: 3, final_amount: 60 }
  ]);
  assert.deepEqual(lines.map((line) => [line.code, line.rateValue, line.amount]), [["BONUS", null, 250], ["KM", 3, 60]]);
  assert.equal(workforceAdditionalPaymentTotal(lines), 310);
});

test("definitions never create a payout without a saved person-and-period value", () => {
  assert.deepEqual(workforceAdditionalPaymentLines(500, fields, []), []);
});

test("an inactive definition still renders its saved historical snapshots", () => {
  const lines = workforceAdditionalPaymentLines(500, [{ ...fields[1], name: "Renamed", default_rate_value: 9, is_active: false }], [
    { id: "v", additional_payment_field_id: "units", workforce_id: "w", field_code_snapshot: "KM", field_name_snapshot: "Kilometre incentive", calculation_type_snapshot: "units_x_rate", input_value: 20, rate_value: 3, final_amount: 60 }
  ]);
  assert.deepEqual(lines.map((line) => [line.label, line.rateValue, line.amount]), [["Kilometre incentive", 3, 60]]);
});

test("a saved historical value remains visible after its field is no longer returned by the master query", () => {
  const lines = workforceAdditionalPaymentLines(0, [], [
    { id: "v", additional_payment_field_id: "retired", workforce_id: "w", field_code_snapshot: "OLD_BONUS", field_name_snapshot: "Old bonus", calculation_type_snapshot: "manual_amount", input_value: 75, rate_value: null, final_amount: 75 }
  ]);
  assert.equal(lines[0].amount, 75);
  assert.equal(lines[0].label, "Old bonus");
});
