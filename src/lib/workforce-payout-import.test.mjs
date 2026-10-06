import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import {
  buildWorkforcePayoutImportTemplate,
  parseWorkforcePayoutWorkbook,
  resolveWorkforcePayoutImportRows
} from "./workforce-payout-import.ts";

const headers = ["ACTION", "DROPX_ID", "LOCATION", "INPUT_TYPE", "FIELD_CODE", "EFFECTIVE_FROM", "EFFECTIVE_TO", "VALUE", "WORK_MINUTES", "REMARK"];

function workbookBytes(rows) {
  const workbook = XLSX.utils.book_new();
  const normalizedRows = rows.map((row) => row.length === 9 ? [...row.slice(0, 2), "", ...row.slice(2)] : row);
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, ...normalizedRows]), "Upload");
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
  setups: [{ workforceId: "worker-1", locationId: "station-1", effectiveFrom: "2026-01-01", effectiveTo: null, fieldCodes: ["BASE_RATE", "EXTRA_UNITS", "DELIVERY"] }],
  locations: [{ id: "station-1", code: "ST1" }, { id: "station-2", code: "ST2" }],
  allowedLocationIds: new Set(["station-1"])
};

test("parses all supported payout input types and preserves an explicit zero", () => {
  const parsed = parseWorkforcePayoutWorkbook(workbookBytes([
    ["UPSERT", "dx1001", "attendance", "", "2026-09-01", "2026-09-01", "HD", 240, "half day"],
    ["", "DX1001", "production units", "extra_units", "02/09/2026", "02/09/2026", 0, "", "explicit zero"],
    ["UPSERT", "DX1001", "payment field value", "base_rate", "2026-09-01", "2026-09-30", 650, "", ""],
    ["UPSERT", "DX1001", "additional payment", "bonus", "2026-09-01", "2026-09-30", 1200, "", ""]
  ]), options);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.rows[0].textValue, "HD");
  assert.equal(parsed.rows[0].workMinutes, 240);
  assert.equal(parsed.rows[1].numericValue, 0);
  assert.equal(parsed.rows[1].action, "UPSERT");
  assert.equal(parsed.rows[1].effectiveFrom, "2026-09-02");
});

test("rejects duplicate facts, ambiguous periods, and values on CLEAR rows", () => {
  const parsed = parseWorkforcePayoutWorkbook(workbookBytes([
    ["UPSERT", "DX1001", "ATTENDANCE", "", "2026-09-01", "2026-09-02", "P", "", ""],
    ["UPSERT", "DX1001", "PRODUCTION_UNITS", "EXTRA_UNITS", "2026-09-03", "2026-09-03", 3, "", ""],
    ["CLEAR", "DX1001", "PRODUCTION_UNITS", "EXTRA_UNITS", "2026-09-03", "2026-09-03", 0, "", ""],
    ["UPSERT", "DX1001", "ADDITIONAL_PAYMENT", "BONUS", "2026-09-10", "2026-09-30", 100, "", ""]
  ]), options);
  assert.match(parsed.issues.map((issue) => issue.message).join("\n"), /one work date per row/i);
  assert.match(parsed.issues.map((issue) => issue.message).join("\n"), /duplicates row/i);
  assert.match(parsed.issues.map((issue) => issue.message).join("\n"), /CLEAR rows/i);
  assert.match(parsed.issues.map((issue) => issue.message).join("\n"), /exact selected payout period/i);
});

test("matches only canonical DropX IDs and validates field kinds, setup, and scope", () => {
  const parsed = parseWorkforcePayoutWorkbook(workbookBytes([
    ["UPSERT", "DX1001", "PRODUCTION_UNITS", "EXTRA_UNITS", "2026-09-03", "2026-09-03", 5, "", ""],
    ["UPSERT", "DX1001", "PRODUCTION_UNITS", "DELIVERY", "2026-09-04", "2026-09-04", 5, "", ""],
    ["UPSERT", "MISSING", "ADDITIONAL_PAYMENT", "BONUS", "2026-09-01", "2026-09-30", 50, "", ""]
  ]), options);
  const matched = resolveWorkforcePayoutImportRows(parsed, references);
  assert.equal(matched.canCommit, false);
  assert.equal(matched.rows[0].workforceId, "worker-1");
  assert.equal(matched.rows[0].paymentFieldId, "field-units");
  assert.match(matched.issues.map((issue) => issue.message).join("\n"), /not a custom-production field/i);
  assert.match(matched.issues.map((issue) => issue.message).join("\n"), /No company Workforce record/i);

  const outsideScope = resolveWorkforcePayoutImportRows(
    parseWorkforcePayoutWorkbook(workbookBytes([
      ["UPSERT", "DX1001", "PAYMENT_FIELD_VALUE", "BASE_RATE", "2026-09-01", "2026-09-30", 500, "", ""]
    ]), options),
    { ...references, allowedLocationIds: new Set(["other-station"]) }
  );
  assert.match(outsideScope.issues.map((issue) => issue.message).join("\n"), /outside your location scope/i);
});

test("accepts unit-based additional-payment inputs with the configured rate", () => {
  const parsed = parseWorkforcePayoutWorkbook(workbookBytes([
    ["UPSERT", "DX1001", "ADDITIONAL_PAYMENT", "KM_INCENTIVE", "2026-09-01", "2026-09-30", 1000, "", ""]
  ]), options);
  const matched = resolveWorkforcePayoutImportRows(parsed, references);
  assert.equal(matched.canCommit, true);
  assert.equal(matched.rows[0].additionalCalculationType, "units_x_rate");
});

test("uses an explicit station code to disambiguate simultaneous payment locations", () => {
  const parsed = parseWorkforcePayoutWorkbook(workbookBytes([
    ["UPSERT", "DX1001", "ST2", "PAYMENT_FIELD_VALUE", "BASE_RATE", "2026-09-01", "2026-09-30", 700, "", ""]
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

test("rejects duplicate stored inputs after blank and explicit locations resolve to the same station", () => {
  const parsed = parseWorkforcePayoutWorkbook(workbookBytes([
    ["UPSERT", "DX1001", "", "PAYMENT_FIELD_VALUE", "BASE_RATE", "2026-09-01", "2026-09-30", 650, "", ""],
    ["UPSERT", "DX1001", "ST1", "PAYMENT_FIELD_VALUE", "BASE_RATE", "2026-09-01", "2026-09-30", 700, "", ""],
    ["UPSERT", "DX1001", "", "PRODUCTION_UNITS", "EXTRA_UNITS", "2026-09-03", "2026-09-03", 3, "", ""],
    ["UPSERT", "DX1001", "ST1", "PRODUCTION_UNITS", "EXTRA_UNITS", "2026-09-03", "2026-09-03", 4, "", ""],
    ["UPSERT", "DX1001", "", "ATTENDANCE", "", "2026-09-04", "2026-09-04", "P", "", ""],
    ["UPSERT", "DX1001", "ST1", "ATTENDANCE", "", "2026-09-04", "2026-09-04", "HD", 240, ""],
    ["UPSERT", "DX1001", "", "ADDITIONAL_PAYMENT", "BONUS", "2026-09-01", "2026-09-30", 100, "", ""],
    ["UPSERT", "DX1001", "ST1", "ADDITIONAL_PAYMENT", "BONUS", "2026-09-01", "2026-09-30", 200, "", ""]
  ]), options);
  const matched = resolveWorkforcePayoutImportRows(parsed, references);
  const resolvedDuplicateIssues = matched.issues.filter((issue) => issue.message.startsWith("After Workforce, field and location matching"));

  assert.equal(matched.canCommit, false);
  assert.deepEqual(resolvedDuplicateIssues.map((issue) => issue.rowNumber), [3, 5, 7, 9]);
  assert.deepEqual(resolvedDuplicateIssues.map((issue) => issue.message.match(/this (\S+) input/i)?.[1]), [
    "PAYMENT_FIELD_VALUE",
    "PRODUCTION_UNITS",
    "ATTENDANCE",
    "ADDITIONAL_PAYMENT"
  ]);
  assert.ok(matched.rows.every((row) => row.locationId === "station-1"));
});

test("additional payment defaults to the Workforce current location without requiring a payment setup", () => {
  const parsed = parseWorkforcePayoutWorkbook(workbookBytes([
    ["UPSERT", "DX1001", "", "ADDITIONAL_PAYMENT", "BONUS", "2026-09-01", "2026-09-30", 500, "", ""]
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
      ["UPSERT", "DX1001", locationCode, "ADDITIONAL_PAYMENT", "BONUS", "2026-09-01", "2026-09-30", 500, "", ""]
    ]), options);
    const matched = resolveWorkforcePayoutImportRows(parsed, splitReferences);

    assert.equal(matched.canCommit, true);
    assert.equal(matched.rows[0].locationId, expectedLocation);
  }

  const outOfScope = resolveWorkforcePayoutImportRows(parseWorkforcePayoutWorkbook(workbookBytes([
    ["UPSERT", "DX1001", "ST1", "ADDITIONAL_PAYMENT", "BONUS", "2026-09-01", "2026-09-30", 500, "", ""]
  ]), options), { ...splitReferences, allowedLocationIds: new Set(["station-2"]) });
  assert.equal(outOfScope.canCommit, false);
  assert.match(outOfScope.issues.map((issue) => issue.message).join("\n"), /outside your location scope/i);
});

test("additional payment rejects an explicit location with no current or historical ownership", () => {
  const parsed = parseWorkforcePayoutWorkbook(workbookBytes([
    ["UPSERT", "DX1001", "ST2", "ADDITIONAL_PAYMENT", "BONUS", "2026-09-01", "2026-09-30", 500, "", ""]
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

test("creates the four-sheet dynamic workbook contract", () => {
  const bytes = buildWorkforcePayoutImportTemplate([
    { code: "BASE_RATE", label: "Base rate", inputType: "PAYMENT_FIELD_VALUE", calculation: "manual_input", valueMeaning: "Configured rate/input override" },
    { code: "BONUS", label: "Bonus", inputType: "ADDITIONAL_PAYMENT", calculation: "manual_amount", valueMeaning: "Final amount" }
  ], { ...options, locations: [{ code: "ST1" }, { code: "ST2" }] });
  const workbook = XLSX.read(bytes, { type: "array" });
  assert.deepEqual(workbook.SheetNames, ["Upload", "Field Reference", "Locations", "Instructions"]);
  const upload = XLSX.utils.sheet_to_json(workbook.Sheets.Upload, { header: 1, defval: "" });
  assert.deepEqual(upload[0], headers);
  const fieldReference = XLSX.utils.sheet_to_json(workbook.Sheets["Field Reference"], { header: 1, defval: "" });
  assert.equal(fieldReference[1][0], "BASE_RATE");
  const locations = XLSX.utils.sheet_to_json(workbook.Sheets.Locations, { header: 1, defval: "" });
  assert.equal(locations[1][0], "ST1");
});
