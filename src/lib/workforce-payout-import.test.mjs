import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import {
  buildWorkforcePayoutImportTemplate,
  parseWorkforcePayoutWorkbook,
  resolveWorkforcePayoutImportRows
} from "./workforce-payout-import.ts";

const headers = ["ACTION", "DROPX_ID", "LOCATION", "INPUT_TYPE", "FIELD_CODE", "EFFECTIVE_DATE", "EFFECTIVE_TO", "VALUE", "REMARK"];

function payoutRow({
  action = "UPSERT",
  dropxId = "DX1001",
  location = "",
  inputType,
  fieldCode,
  effectiveDate = "01/09/2026",
  effectiveTo = effectiveDate,
  value = "",
  remark = ""
}) {
  return [action, dropxId, location, inputType, fieldCode, effectiveDate, effectiveTo, value, remark];
}

function workbookBytes(rows, workbookHeaders = headers) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([workbookHeaders, ...rows]), "Upload");
  return new Uint8Array(XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }));
}

const options = { batchFrom: "2026-09-01", batchTo: "2026-09-30" };
const references = {
  workers: [{
    id: "worker-1",
    dropxId: "DX1001",
    fullName: "Database Person",
    locationId: "station-1",
    dateOfJoin: "2026-01-01",
    lastWorkingDate: null,
    isActive: true
  }],
  paymentFields: [
    { id: "field-rate", code: "BASE_RATE", label: "Base rate", fieldType: "amount", calculationType: "manual_input", isCustomProduction: false, isActive: true },
    { id: "field-units", code: "EXTRA_UNITS", label: "Extra units", fieldType: "production", calculationType: "count_x_rate", isCustomProduction: true, isActive: true },
    { id: "field-cps", code: "DELIVERY", label: "Delivery", fieldType: "production", calculationType: "count_x_rate", isCustomProduction: false, isActive: true }
  ],
  additionalFields: [
    { id: "extra-1", code: "BONUS", name: "Bonus", calculationType: "manual_amount", defaultRateValue: null, isActive: true },
    { id: "extra-2", code: "KM_INCENTIVE", name: "Kilometre incentive", calculationType: "units_x_rate", defaultRateValue: 3, isActive: true }
  ],
  deductionHeads: [
    { id: "deduction-1", code: "LOAN_RECOVERY", name: "Loan recovery", calculationType: "manual", isSystem: false, isActive: true },
    { id: "deduction-2", code: "TDS", name: "TDS", calculationType: "percentage", isSystem: true, isActive: true }
  ],
  setups: [{ workforceId: "worker-1", locationId: "station-1", effectiveFrom: "2026-01-01", effectiveTo: null, fieldCodes: ["BASE_RATE", "EXTRA_UNITS", "DELIVERY"] }],
  locations: [{ id: "station-1", code: "ST1" }, { id: "station-2", code: "ST2" }],
  allowedLocationIds: new Set(["station-1"])
};

test("parses all supported payout input types and preserves an explicit zero", () => {
  const parsed = parseWorkforcePayoutWorkbook(workbookBytes([
    payoutRow({ dropxId: "dx1001", inputType: "attendance", fieldCode: "work_days", effectiveDate: "01/09/2026", effectiveTo: "15/09/2026", value: 10.5, remark: "range days" }),
    payoutRow({ action: "", inputType: "production units", fieldCode: "extra_units", effectiveDate: "02-09-2026", value: 0, remark: "explicit zero" }),
    payoutRow({ inputType: "payment field value", fieldCode: "base_rate", effectiveTo: "30/09/2026", value: 650 }),
    payoutRow({ inputType: "additional payment", fieldCode: "bonus", effectiveTo: "30/09/2026", value: 1200 }),
    payoutRow({ inputType: "deduction", fieldCode: "loan_recovery", effectiveTo: "30/09/2026", value: 250 })
  ]), options);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.rows[0].textValue, null);
  assert.equal(parsed.rows[0].numericValue, 10.5);
  assert.equal(parsed.rows[0].attendanceBasis, "days");
  assert.equal(parsed.rows[0].workDays, 10.5);
  assert.equal(parsed.rows[0].effectiveFrom, "2026-09-01");
  assert.equal(parsed.rows[0].effectiveTo, "2026-09-15");
  assert.equal(parsed.rows[1].numericValue, 0);
  assert.equal(parsed.rows[1].action, "UPSERT");
  assert.equal(parsed.rows[1].effectiveFrom, "2026-09-02");
  assert.equal(parsed.rows[2].effectiveFrom, "2026-09-01");
  assert.equal(parsed.rows[2].effectiveTo, "2026-09-30");
  assert.equal(parsed.rows[3].effectiveFrom, "2026-09-01");
  assert.equal(parsed.rows[3].effectiveTo, "2026-09-30");
});

test("validates attendance quantities, duplicate facts and values on CLEAR rows", () => {
  const parsed = parseWorkforcePayoutWorkbook(workbookBytes([
    payoutRow({ inputType: "ATTENDANCE", fieldCode: "", value: 8 }),
    payoutRow({ inputType: "PRODUCTION_UNITS", fieldCode: "EXTRA_UNITS", effectiveDate: "03/09/2026", value: 3 }),
    payoutRow({ action: "CLEAR", inputType: "PRODUCTION_UNITS", fieldCode: "EXTRA_UNITS", effectiveDate: "03/09/2026", value: 0 }),
    payoutRow({ inputType: "ATTENDANCE", fieldCode: "WORK_HOURS", effectiveDate: "04/09/2026", value: "" })
  ]), options);
  const messages = parsed.issues.map((issue) => issue.message).join("\n");
  assert.match(messages, /FIELD_CODE must be WORK_HOURS or WORK_DAYS/i);
  assert.match(messages, /duplicates row/i);
  assert.match(messages, /CLEAR rows must leave VALUE blank/i);
  assert.match(messages, /Attendance VALUE must be a valid number/i);
});

test("rejects WORK_HOURS and WORK_DAYS rows for the same attendance period", () => {
  const parsed = parseWorkforcePayoutWorkbook(workbookBytes([
    payoutRow({ inputType: "ATTENDANCE", fieldCode: "WORK_HOURS", effectiveDate: "05/09/2026", effectiveTo: "10/09/2026", value: 30 }),
    payoutRow({ inputType: "ATTENDANCE", fieldCode: "WORK_DAYS", effectiveDate: "05/09/2026", effectiveTo: "10/09/2026", value: 5 })
  ]), options);

  assert.match(parsed.issues.map((issue) => issue.message).join("\n"), /duplicates row 2/i);
});

test("accepts attendance hours above one day and derives compatibility minutes", () => {
  const parsed = parseWorkforcePayoutWorkbook(workbookBytes([
    payoutRow({ inputType: "ATTENDANCE", fieldCode: "WORK_HOURS", effectiveDate: "05/09/2026", effectiveTo: "10/09/2026", value: 30 })
  ]), options);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.rows[0].attendanceBasis, "hours");
  assert.equal(parsed.rows[0].numericValue, 30);
  assert.equal(parsed.rows[0].workHours, 30);
  assert.equal(parsed.rows[0].workMinutes, 1800);
  assert.equal(parsed.rows[0].textValue, null);
});

test("attendance range totals cannot exceed the available days or hours", () => {
  const parsed = parseWorkforcePayoutWorkbook(workbookBytes([
    payoutRow({ inputType: "ATTENDANCE", fieldCode: "WORK_HOURS", effectiveDate: "05/09/2026", effectiveTo: "06/09/2026", value: 49 }),
    payoutRow({ inputType: "ATTENDANCE", fieldCode: "WORK_DAYS", effectiveDate: "05/09/2026", effectiveTo: "06/09/2026", value: 2.5 })
  ]), options);
  const messages = parsed.issues.map((issue) => issue.message).join("\n");
  assert.match(messages, /cannot exceed 48 hours/i);
  assert.match(messages, /cannot exceed 2 days/i);
});

test("accepts only DD-MM-YYYY, DD/MM/YYYY or a genuine Excel date cell", () => {
  const strictText = parseWorkforcePayoutWorkbook(workbookBytes([
    payoutRow({ inputType: "PRODUCTION_UNITS", fieldCode: "EXTRA_UNITS", effectiveDate: "2026-09-03", effectiveTo: "03/09/2026", value: 3 }),
    payoutRow({ inputType: "PRODUCTION_UNITS", fieldCode: "EXTRA_UNITS", effectiveDate: "03/09/2026", effectiveTo: "3/09/2026", value: 3 })
  ]), options);
  assert.equal(strictText.issues.filter((issue) => /DD-MM-YYYY/.test(issue.message)).length, 2);

  const excelDate = new Date(Date.UTC(2026, 8, 4));
  const typedCell = parseWorkforcePayoutWorkbook(workbookBytes([
    payoutRow({ inputType: "PRODUCTION_UNITS", fieldCode: "EXTRA_UNITS", effectiveDate: excelDate, effectiveTo: excelDate, value: 3 })
  ]), options);
  assert.deepEqual(typedCell.issues, []);
  assert.equal(typedCell.rows[0].effectiveDate, "2026-09-04");
  assert.equal(typedCell.rows[0].effectiveTo, "2026-09-04");
});

test("requires EFFECTIVE_TO and validates the inclusive effective range", () => {
  const parsed = parseWorkforcePayoutWorkbook(workbookBytes([
    payoutRow({ inputType: "PRODUCTION_UNITS", fieldCode: "EXTRA_UNITS", effectiveDate: "03/09/2026", effectiveTo: "", value: 3 }),
    payoutRow({ inputType: "PRODUCTION_UNITS", fieldCode: "EXTRA_UNITS", effectiveDate: "10/09/2026", effectiveTo: "09/09/2026", value: 3 }),
    payoutRow({ inputType: "PRODUCTION_UNITS", fieldCode: "EXTRA_UNITS", effectiveDate: "03/09/2026", effectiveTo: "01/10/2026", value: 3 })
  ]), options);
  const messages = parsed.issues.map((issue) => issue.message).join("\n");
  assert.match(messages, /EFFECTIVE_TO is compulsory/i);
  assert.match(messages, /cannot be earlier than EFFECTIVE_DATE/i);
  assert.match(messages, /EFFECTIVE_TO must fall within the selected/i);
});

test("attendance UPSERT ranges stay within one calendar month while CLEAR remains repairable", () => {
  const crossMonthOptions = { batchFrom: "2026-09-01", batchTo: "2026-10-31" };
  const parsed = parseWorkforcePayoutWorkbook(workbookBytes([
    payoutRow({ inputType: "ATTENDANCE", fieldCode: "WORK_DAYS", effectiveDate: "20/09/2026", effectiveTo: "10/10/2026", value: 15 }),
    payoutRow({ action: "CLEAR", inputType: "ATTENDANCE", fieldCode: "WORK_DAYS", effectiveDate: "20/09/2026", effectiveTo: "10/10/2026" })
  ]), crossMonthOptions);

  const monthIssues = parsed.issues.filter((issue) => /one calendar month/i.test(issue.message));
  assert.deepEqual(monthIssues.map((issue) => issue.rowNumber), [2]);
});

test("preserves the existing period rules for daily production and period-wide adjustments", () => {
  const parsed = parseWorkforcePayoutWorkbook(workbookBytes([
    payoutRow({ inputType: "PRODUCTION_UNITS", fieldCode: "EXTRA_UNITS", effectiveDate: "03/09/2026", effectiveTo: "04/09/2026", value: 3 }),
    payoutRow({ inputType: "ADDITIONAL_PAYMENT", fieldCode: "BONUS", effectiveDate: "05/09/2026", effectiveTo: "20/09/2026", value: 50 }),
    payoutRow({ inputType: "DEDUCTION", fieldCode: "LOAN_RECOVERY", effectiveDate: "05/09/2026", effectiveTo: "20/09/2026", value: 25 })
  ]), options);
  const messages = parsed.issues.map((issue) => issue.message).join("\n");
  assert.match(messages, /PRODUCTION_UNITS must use the same date/i);
  assert.match(messages, /ADDITIONAL_PAYMENT must use the complete selected payout period/i);
  assert.match(messages, /DEDUCTION must use the complete selected payout period/i);
});

test("requires the new header contract and rejects legacy attendance columns", () => {
  const legacyHeaders = ["ACTION", "DROPX_ID", "LOCATION", "INPUT_TYPE", "FIELD_CODE", "EFFECTIVE_DATE", "VALUE", "WORK_HOURS", "WORK_DAYS", "REMARK"];
  assert.throws(() => parseWorkforcePayoutWorkbook(workbookBytes([
    ["UPSERT", "DX1001", "", "ATTENDANCE", "", "01/09/2026", "", 8, "", ""]
  ], legacyHeaders), options), /EFFECTIVE_TO/i);

  const withLegacyColumn = parseWorkforcePayoutWorkbook(workbookBytes([
    [...payoutRow({ inputType: "ATTENDANCE", fieldCode: "WORK_HOURS", value: 30 }), 8]
  ], [...headers, "WORK_HOURS"]), options);
  assert.match(withLegacyColumn.issues.map((issue) => issue.message).join("\n"), /Unknown column “WORK_HOURS”/i);
});

test("matches only canonical DropX IDs and allows field-scoped provider production overrides", () => {
  const parsed = parseWorkforcePayoutWorkbook(workbookBytes([
    payoutRow({ inputType: "PRODUCTION_UNITS", fieldCode: "EXTRA_UNITS", effectiveDate: "03/09/2026", value: 5 }),
    payoutRow({ inputType: "PRODUCTION_UNITS", fieldCode: "DELIVERY", effectiveDate: "04/09/2026", value: 5 }),
    payoutRow({ dropxId: "MISSING", inputType: "ADDITIONAL_PAYMENT", fieldCode: "BONUS", effectiveTo: "30/09/2026", value: 50 })
  ]), options);
  const matched = resolveWorkforcePayoutImportRows(parsed, references);
  assert.equal(matched.canCommit, false);
  assert.equal(matched.rows[0].workforceId, "worker-1");
  assert.equal(matched.rows[0].paymentFieldId, "field-units");
  assert.equal(matched.rows[1].paymentFieldId, "field-cps");
  assert.doesNotMatch(matched.issues.map((issue) => issue.message).join("\n"), /custom-production|provider-derived production cannot/i);
  assert.match(matched.issues.map((issue) => issue.message).join("\n"), /No company Workforce record/i);

  const outsideScope = resolveWorkforcePayoutImportRows(
    parseWorkforcePayoutWorkbook(workbookBytes([
      payoutRow({ inputType: "PAYMENT_FIELD_VALUE", fieldCode: "BASE_RATE", effectiveTo: "30/09/2026", value: 500 })
    ]), options),
    { ...references, allowedLocationIds: new Set(["other-station"]) }
  );
  assert.match(outsideScope.issues.map((issue) => issue.message).join("\n"), /outside your location scope/i);
});

test("accepts unit-based additional-payment inputs with the configured rate", () => {
  const parsed = parseWorkforcePayoutWorkbook(workbookBytes([
    payoutRow({ inputType: "ADDITIONAL_PAYMENT", fieldCode: "KM_INCENTIVE", effectiveTo: "30/09/2026", value: 1000 })
  ]), options);
  const matched = resolveWorkforcePayoutImportRows(parsed, references);
  assert.equal(matched.canCommit, true);
  assert.equal(matched.rows[0].additionalCalculationType, "units_x_rate");
});

test("accepts only active manual deductions for the selected payout period", () => {
  const parsed = parseWorkforcePayoutWorkbook(workbookBytes([
    payoutRow({ inputType: "DEDUCTION", fieldCode: "LOAN_RECOVERY", effectiveTo: "30/09/2026", value: 250 }),
    payoutRow({ inputType: "DEDUCTION", fieldCode: "TDS", effectiveTo: "30/09/2026", value: 100 })
  ]), options);
  const matched = resolveWorkforcePayoutImportRows(parsed, references);

  assert.equal(matched.canCommit, false);
  assert.equal(matched.rows[0].deductionHeadId, "deduction-1");
  assert.match(matched.issues.map((issue) => issue.message).join("\n"), /not an active manual deduction/i);
});

test("deductions use currency precision and an old head can still be cleared", () => {
  const tooPrecise = parseWorkforcePayoutWorkbook(workbookBytes([
    payoutRow({ inputType: "DEDUCTION", fieldCode: "LOAN_RECOVERY", effectiveTo: "30/09/2026", value: 12.3456 })
  ]), options);
  assert.match(tooPrecise.issues.map((issue) => issue.message).join("\n"), /at most two decimal places/i);

  const clear = resolveWorkforcePayoutImportRows(parseWorkforcePayoutWorkbook(workbookBytes([
    payoutRow({ action: "CLEAR", inputType: "DEDUCTION", fieldCode: "TDS", effectiveTo: "30/09/2026", remark: "remove historical manual value" })
  ]), options), references);
  assert.equal(clear.canCommit, true);
  assert.equal(clear.rows[0].deductionHeadId, "deduction-2");
});

test("uses an explicit station code to disambiguate simultaneous payment locations", () => {
  const parsed = parseWorkforcePayoutWorkbook(workbookBytes([
    payoutRow({ location: "ST2", inputType: "PAYMENT_FIELD_VALUE", fieldCode: "BASE_RATE", effectiveTo: "30/09/2026", value: 700 })
  ]), options);
  const matched = resolveWorkforcePayoutImportRows(parsed, {
    ...references,
    setups: [
      ...references.setups,
      { workforceId: "worker-1", locationId: "station-2", effectiveFrom: "2026-01-01", effectiveTo: null, fieldCodes: ["BASE_RATE"] }
    ],
    allowedLocationIds: new Set(["station-2"])
  });
  assert.equal(matched.canCommit, true);
  assert.equal(matched.rows[0].locationId, "station-2");
  assert.equal(matched.rows[0].locationCode, "ST2");
});

test("requires an attendance range to stay within one assigned location", () => {
  const transferReferences = {
    ...references,
    workers: [{ ...references.workers[0], locationId: "station-2" }],
    setups: [
      { workforceId: "worker-1", locationId: "station-1", effectiveFrom: "2026-01-01", effectiveTo: "2026-09-15", fieldCodes: [] },
      { workforceId: "worker-1", locationId: "station-2", effectiveFrom: "2026-09-16", effectiveTo: null, fieldCodes: [] }
    ],
    allowedLocationIds: new Set(["station-1", "station-2"])
  };
  const blankLocation = resolveWorkforcePayoutImportRows(parseWorkforcePayoutWorkbook(workbookBytes([
    payoutRow({ inputType: "ATTENDANCE", fieldCode: "WORK_DAYS", effectiveDate: "01/09/2026", effectiveTo: "30/09/2026", value: 20 })
  ]), options), transferReferences);
  assert.match(blankLocation.issues.map((issue) => issue.message).join("\n"), /crosses payment locations/i);

  const partialLocation = resolveWorkforcePayoutImportRows(parseWorkforcePayoutWorkbook(workbookBytes([
    payoutRow({ location: "ST1", inputType: "ATTENDANCE", fieldCode: "WORK_DAYS", effectiveDate: "01/09/2026", effectiveTo: "30/09/2026", value: 20 })
  ]), options), transferReferences);
  assert.equal(partialLocation.rows.length, 0);
  assert.match(partialLocation.issues.map((issue) => issue.message).join("\n"), /not assigned to the selected location during this payout period/i);
});

test("rejects duplicate stored inputs after blank and explicit locations resolve to the same station", () => {
  const parsed = parseWorkforcePayoutWorkbook(workbookBytes([
    payoutRow({ inputType: "PAYMENT_FIELD_VALUE", fieldCode: "BASE_RATE", effectiveTo: "30/09/2026", value: 650 }),
    payoutRow({ location: "ST1", inputType: "PAYMENT_FIELD_VALUE", fieldCode: "BASE_RATE", effectiveTo: "30/09/2026", value: 700 }),
    payoutRow({ inputType: "PRODUCTION_UNITS", fieldCode: "EXTRA_UNITS", effectiveDate: "03/09/2026", value: 3 }),
    payoutRow({ location: "ST1", inputType: "PRODUCTION_UNITS", fieldCode: "EXTRA_UNITS", effectiveDate: "03/09/2026", value: 4 }),
    payoutRow({ inputType: "ATTENDANCE", fieldCode: "WORK_HOURS", effectiveDate: "04/09/2026", effectiveTo: "10/09/2026", value: 30 }),
    payoutRow({ location: "ST1", inputType: "ATTENDANCE", fieldCode: "WORK_HOURS", effectiveDate: "04/09/2026", effectiveTo: "10/09/2026", value: 31 }),
    payoutRow({ inputType: "ADDITIONAL_PAYMENT", fieldCode: "BONUS", effectiveTo: "30/09/2026", value: 100 }),
    payoutRow({ location: "ST1", inputType: "ADDITIONAL_PAYMENT", fieldCode: "BONUS", effectiveTo: "30/09/2026", value: 200 }),
    payoutRow({ inputType: "DEDUCTION", fieldCode: "LOAN_RECOVERY", effectiveTo: "30/09/2026", value: 250 }),
    payoutRow({ location: "ST1", inputType: "DEDUCTION", fieldCode: "LOAN_RECOVERY", effectiveTo: "30/09/2026", value: 300 })
  ]), options);
  const matched = resolveWorkforcePayoutImportRows(parsed, references);
  const resolvedDuplicateIssues = matched.issues.filter((issue) => issue.message.startsWith("After Workforce, field and location matching"));

  assert.equal(matched.canCommit, false);
  assert.deepEqual(resolvedDuplicateIssues.map((issue) => issue.rowNumber), [3, 5, 7, 9, 11]);
  assert.deepEqual(resolvedDuplicateIssues.map((issue) => issue.message.match(/this (\S+) input/i)?.[1]), [
    "PAYMENT_FIELD_VALUE",
    "PRODUCTION_UNITS",
    "ATTENDANCE",
    "ADDITIONAL_PAYMENT",
    "DEDUCTION"
  ]);
  assert.ok(matched.rows.every((row) => row.locationId === "station-1"));
});

test("additional payment defaults to the Workforce current location without requiring a payment setup", () => {
  const parsed = parseWorkforcePayoutWorkbook(workbookBytes([
    payoutRow({ inputType: "ADDITIONAL_PAYMENT", fieldCode: "BONUS", effectiveTo: "30/09/2026", value: 500 })
  ]), options);
  const matched = resolveWorkforcePayoutImportRows(parsed, {
    ...references,
    workers: [{ ...references.workers[0], locationId: "station-2" }],
    setups: [{ workforceId: "worker-1", locationId: "station-1", effectiveFrom: "2026-01-01", effectiveTo: "2026-09-30", fieldCodes: ["BASE_RATE"] }],
    allowedLocationIds: new Set(["station-2"])
  });
  assert.equal(matched.canCommit, true);
  assert.equal(matched.rows[0].locationId, "station-2");
});

test("additional payment accepts either side of a transfer and keeps location scope enforcement", () => {
  const splitReferences = {
    ...references,
    workers: [{ ...references.workers[0], locationId: "station-2" }],
    setups: [
      { workforceId: "worker-1", locationId: "station-1", effectiveFrom: "2026-01-01", effectiveTo: "2026-09-15", fieldCodes: [] },
      { workforceId: "worker-1", locationId: "station-2", effectiveFrom: "2026-09-16", effectiveTo: null, fieldCodes: [] }
    ],
    allowedLocationIds: new Set(["station-1", "station-2"])
  };

  for (const [locationCode, expectedLocation] of [["ST1", "station-1"], ["ST2", "station-2"], ["", "station-2"]]) {
    const parsed = parseWorkforcePayoutWorkbook(workbookBytes([
      payoutRow({ location: locationCode, inputType: "ADDITIONAL_PAYMENT", fieldCode: "BONUS", effectiveTo: "30/09/2026", value: 500 })
    ]), options);
    const matched = resolveWorkforcePayoutImportRows(parsed, splitReferences);

    assert.equal(matched.canCommit, true);
    assert.equal(matched.rows[0].locationId, expectedLocation);
  }

  const outOfScope = resolveWorkforcePayoutImportRows(parseWorkforcePayoutWorkbook(workbookBytes([
    payoutRow({ location: "ST1", inputType: "ADDITIONAL_PAYMENT", fieldCode: "BONUS", effectiveTo: "30/09/2026", value: 500 })
  ]), options), { ...splitReferences, allowedLocationIds: new Set(["station-2"]) });
  assert.equal(outOfScope.canCommit, false);
  assert.match(outOfScope.issues.map((issue) => issue.message).join("\n"), /outside your location scope/i);
});

test("additional payment rejects an explicit location with no current or historical ownership", () => {
  const parsed = parseWorkforcePayoutWorkbook(workbookBytes([
    payoutRow({ location: "ST2", inputType: "ADDITIONAL_PAYMENT", fieldCode: "BONUS", effectiveTo: "30/09/2026", value: 500 })
  ]), options);
  const matched = resolveWorkforcePayoutImportRows(parsed, {
    ...references,
    allowedLocationIds: new Set(["station-2"])
  });
  assert.equal(matched.canCommit, false);
  assert.equal(matched.rows.length, 0);
  assert.match(matched.issues.map((issue) => issue.message).join("\n"), /current location or an overlapping historical payment location/i);
  assert.doesNotMatch(matched.issues.map((issue) => issue.message).join("\n"), /Database Person/);
});

test("creates a dynamic workbook with plain-language guidance and safe examples", () => {
  const bytes = buildWorkforcePayoutImportTemplate([
    { code: "BASE_RATE", label: "Base rate", inputType: "PAYMENT_FIELD_VALUE", calculation: "manual_input", valueMeaning: "Configured rate/input override" },
    { code: "EXTRA_UNITS", label: "Extra units", inputType: "PRODUCTION_UNITS", calculation: "count_x_rate", valueMeaning: "Units for one date" },
    { code: "BONUS", label: "Bonus", inputType: "ADDITIONAL_PAYMENT", calculation: "manual_amount", valueMeaning: "Final amount" },
    { code: "LOAN_RECOVERY", label: "Loan recovery", inputType: "DEDUCTION", calculation: "manual", valueMeaning: "Manual deduction amount" }
  ], { effectiveFrom: options.batchFrom, effectiveTo: options.batchTo, locations: [{ code: "ST1" }, { code: "ST2" }] });
  const workbook = XLSX.read(bytes, { type: "array" });
  assert.deepEqual(workbook.SheetNames, ["Upload", "Field Reference", "Locations", "Examples", "Instructions"]);
  const upload = XLSX.utils.sheet_to_json(workbook.Sheets.Upload, { header: 1, defval: "" });
  assert.deepEqual(upload[0], headers);
  const fieldReference = XLSX.utils.sheet_to_json(workbook.Sheets["Field Reference"], { header: 1, defval: "" });
  assert.equal(fieldReference[1][0], "WORK_HOURS");
  assert.equal(fieldReference[2][0], "WORK_DAYS");
  assert.ok(fieldReference.some((row) => row[0] === "BASE_RATE"));
  const locations = XLSX.utils.sheet_to_json(workbook.Sheets.Locations, { header: 1, defval: "" });
  assert.equal(locations[1][0], "ST1");
  const examples = XLSX.utils.sheet_to_json(workbook.Sheets.Examples, { header: 1, defval: "" });
  assert.match(examples[0][0], /EXAMPLES ONLY/i);
  assert.deepEqual(examples[1], headers);
  assert.deepEqual(examples[2].slice(3, 8), ["ATTENDANCE", "WORK_HOURS", "01/09/2026", "30/09/2026", 30]);
  assert.deepEqual(examples[3].slice(3, 8), ["ATTENDANCE", "WORK_DAYS", "01/09/2026", "30/09/2026", 5]);
  assert.ok(examples.some((row) => row[3] === "PRODUCTION_UNITS" && row[4] === "EXTRA_UNITS"));
  assert.ok(examples.some((row) => row[3] === "PAYMENT_FIELD_VALUE" && row[4] === "BASE_RATE"));
  assert.ok(examples.some((row) => row[3] === "ADDITIONAL_PAYMENT" && row[4] === "BONUS"));
  assert.ok(examples.some((row) => row[3] === "DEDUCTION" && row[4] === "LOAN_RECOVERY"));
  const instructions = XLSX.utils.sheet_to_json(workbook.Sheets.Instructions, { header: 1, defval: "" });
  const instructionText = instructions.flat().join("\n");
  assert.match(instructionText, /EFFECTIVE_DATE and EFFECTIVE_TO/i);
  assert.match(instructionText, /Both dates are compulsory/i);
  assert.match(instructionText, /DD-MM-YYYY or DD\/MM\/YYYY/i);
  assert.match(instructionText, /Set FIELD_CODE to WORK_HOURS or WORK_DAYS/i);
  assert.match(instructionText, /total quantity for the effective range in VALUE/i);
  assert.match(instructionText, /Inputs not represented by an uploaded row remain unchanged/i);
});
