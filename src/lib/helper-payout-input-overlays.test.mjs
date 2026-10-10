import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import {
  calculateHelperPayoutAdjustments,
  helperPayoutAttendanceInputForDate,
  helperPayoutAttendancePeriodForDate
} from "./helper-payout-input-overlays.ts";
import { buildWorkforcePayoutImportTemplate } from "./workforce-payout-import.ts";

const attendancePeriod = {
  id: "attendance-1",
  helper_id: "helper-1",
  station_id: "station-1",
  attendance_basis: "days",
  effective_from: "2026-10-01",
  effective_to: "2026-10-10",
  quantity: 8
};

test("Helper aggregate attendance resolves one owning range and fails closed on ambiguity", () => {
  assert.equal(helperPayoutAttendancePeriodForDate([attendancePeriod], {
    helperId: "helper-1",
    stationId: "station-1",
    date: "2026-10-05"
  })?.id, "attendance-1");
  assert.equal(helperPayoutAttendancePeriodForDate([
    attendancePeriod,
    { ...attendancePeriod, id: "attendance-2", effective_from: "2026-10-05" }
  ], {
    helperId: "helper-1",
    stationId: "station-1",
    date: "2026-10-05"
  }), undefined);
});

test("Helper aggregate attendance settles the range total once on its final date", () => {
  assert.deepEqual(helperPayoutAttendanceInputForDate(attendancePeriod, "2026-10-01"), {
    basis: "days",
    quantity: 0
  });
  assert.deepEqual(helperPayoutAttendanceInputForDate(attendancePeriod, "2026-10-10"), {
    basis: "days",
    quantity: 8
  });
});

test("Helper additions increase gross before automatic and manual deductions", () => {
  const result = calculateHelperPayoutAdjustments({
    baseAmount: 1_000,
    additionalFields: [{
      id: "bonus",
      code: "BONUS",
      name: "Bonus",
      calculation_type: "manual_amount",
      default_rate_value: null,
      is_active: true
    }],
    additionalValues: [{
      id: "bonus-value",
      helper_id: "helper-1",
      station_id: "station-1",
      additional_payment_field_id: "bonus",
      field_code_snapshot: "BONUS",
      field_name_snapshot: "Bonus",
      calculation_type_snapshot: "manual_amount",
      input_value: 100,
      rate_value: null,
      final_amount: 100
    }],
    deductionHeads: [{
      id: "tds",
      code: "TDS",
      name: "TDS",
      calculation_type: "percentage",
      default_value: 10,
      percentage_without_pan: 20,
      workforce_category_codes: ["workers"],
      applies_to_all: true,
      is_system: true,
      is_active: true
    }],
    deductionValues: [{
      id: "manual-value",
      helper_id: "helper-1",
      station_id: "station-1",
      deduction_head_id: "manual-head",
      head_code_snapshot: "RECOVERY",
      head_name_snapshot: "Recovery",
      amount: 50
    }],
    deductionContext: { categoryCode: "workers", panNumber: "ABCDE1234F" }
  });

  assert.equal(result.additions, 100);
  assert.equal(result.grossPayment, 1_100);
  assert.deepEqual(result.deductionBreakdown.map((line) => [line.code, line.amount]), [
    ["TDS", 110],
    ["RECOVERY", 50]
  ]);
  assert.equal(result.deductions, 160);
  assert.equal(result.netAmount, 940);
});

test("Helper workbook guidance exposes only supported input families", () => {
  const bytes = buildWorkforcePayoutImportTemplate([
    { code: "BONUS", label: "Bonus", inputType: "ADDITIONAL_PAYMENT", calculation: "manual_amount", valueMeaning: "Final amount" },
    { code: "RECOVERY", label: "Recovery", inputType: "DEDUCTION", calculation: "manual", valueMeaning: "Manual deduction" }
  ], {
    effectiveFrom: "2026-10-01",
    effectiveTo: "2026-10-31",
    subjectLabel: "Helper",
    supportedInputTypes: ["ATTENDANCE", "ADDITIONAL_PAYMENT", "DEDUCTION"]
  });
  const workbook = XLSX.read(bytes, { type: "array" });
  const instructionText = XLSX.utils.sheet_to_json(workbook.Sheets.Instructions, { header: 1, defval: "" }).flat().join("\n");
  assert.match(instructionText, /HELPER PAYOUT BULK UPLOAD/);
  assert.match(instructionText, /company Helper DROPX_ID/);
  assert.doesNotMatch(instructionText, /PRODUCTION_UNITS/);
  assert.doesNotMatch(instructionText, /PAYMENT_FIELD_VALUE/);
});
