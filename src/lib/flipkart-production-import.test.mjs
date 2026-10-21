import assert from "node:assert/strict";
import test from "node:test";

import * as XLSX from "xlsx";

import {
  aggregateFlipkartDailyProduction,
  flipkartMetricForSheetType,
  normalizeFlipkartProviderId,
  parseFlipkartProductionMatrix,
  stationCodeFromFlipkartHub,
  validateFlipkartImportCycle
} from "./flipkart-production-import.ts";

function workbookRows(rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
  const bytes = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
  const reopened = XLSX.read(bytes, { cellDates: true, type: "buffer" });
  return XLSX.utils.sheet_to_json(reopened.Sheets.Sheet1, { defval: "", header: 1, raw: true });
}

const HEADERS = [
  "id",
  "agent_name",
  "casper_employee_id",
  "sheet_create_date_time",
  "sheet_update_date_time",
  "sheet_id",
  "sheet_type",
  "hub_name",
  "assigned",
  "completed"
];

test("parses header aliases, sheet types and hub station suffixes", () => {
  const rows = workbookRows([
    ["Flipkart cycle report"],
    [
      "Record ID",
      "Agent Name",
      "Casper Employee ID",
      "Sheet Created At",
      "Sheet Updated At",
      "Sheet ID",
      "Sheet Type",
      "Hub Name",
      "Assigned Count",
      "Completed Count"
    ],
    [1, "Worker One", "001234", "16/09/2026 00:00:00", "16/09/2026 10:00:00", "RUN-1", "BP_RUNSHEET", "PHULNAKHARAMDH_PHN", 12, 10],
    [2, "Worker One", "001234", "16/09/2026 00:00:00", "16/09/2026 10:05:00", "PICK-1", "BP_PICKUPSHEET", "PHULNAKHARAMDH_PHN", 3, 2]
  ]);

  const parsed = parseFlipkartProductionMatrix(rows, { allowedStationCodes: ["PHN"] });

  assert.equal(parsed.headerRowNumber, 2);
  assert.equal(parsed.cycle.key, "2026-09-H2");
  assert.equal(parsed.rows[0].providerEmployeeId, "001234");
  assert.equal(parsed.rows[0].stationCode, "PHN");
  assert.equal(parsed.rows[0].metric, "delivery");
  assert.equal(parsed.rows[1].metric, "customer_return");
  assert.deepEqual(parsed.issues, []);
  assert.deepEqual(parsed.daily, [{
    assignedCount: 15,
    customerReturn: 2,
    delivery: 10,
    providerEmployeeId: "001234",
    providerEmployeeName: "Worker One",
    rawRowCount: 2,
    sheetIds: ["RUN-1", "PICK-1"],
    sheetTypes: ["BP_RUNSHEET", "BP_PICKUPSHEET"],
    sourceRowNumbers: [3, 4],
    stationCode: "PHN",
    totalActivity: 12,
    workDate: "2026-09-16"
  }]);
});

test("keeps the newest sheet revision even when Flipkart corrects its worker or type", () => {
  const parsed = parseFlipkartProductionMatrix(workbookRows([
    HEADERS,
    [1, "Old name", "90001", "17/09/2026", "17/09/2026 09:00:00", "SHEET-7", "BP_RUNSHEET", "SASPERAMBRAODH_PMB", 20, 7],
    [2, "New name", "90002", "17/09/2026", "17/09/2026 11:00:00", "SHEET-7", "BP_PICKUPSHEET", "SASPERAMBRAODH_PMB", 20, 11],
    [3, "Tie wins by later source row", "90003", "17/09/2026", "17/09/2026 11:00:00", "SHEET-7", "BP_PICKUPSHEET", "SASPERAMBRAODH_PMB", 20, 12]
  ]));

  assert.equal(parsed.deduplicatedRowCount, 2);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].providerEmployeeId, "90003");
  assert.equal(parsed.rows[0].completed, 12);
  assert.equal(parsed.rows[0].providerEmployeeName, "Tie wins by later source row");
  assert.equal(parsed.daily[0].customerReturn, 12);
  assert.equal(parsed.daily[0].delivery, 0);
});

test("binds authoritative files to the company vendor and requires both sheet types", () => {
  const vendorHeaders = [...HEADERS, "ODH Vendor"];
  const valid = parseFlipkartProductionMatrix(workbookRows([
    vendorHeaders,
    [1, "Worker", "90001", "16/09/2026", "16/09/2026 09:00:00", "RUN-1", "BP_RUNSHEET", "HUB_PHN", 1, 1, "DROPX LOGISTICS"],
    [2, "Worker", "90001", "16/09/2026", "16/09/2026 09:05:00", "PICK-1", "BP_PICKUPSHEET", "HUB_PHN", 1, 1, "DROPX LOGISTICS"]
  ]), {
    allowedStationCodes: ["PHN"],
    expectedVendorNames: ["DROPX_LOGISTICS", "DROPX LOGISTICS"],
    rejectInvalidRows: true,
    requireBothSheetTypes: true
  });
  assert.equal(valid.rows.length, 2);

  assert.throws(
    () => parseFlipkartProductionMatrix(workbookRows([
      vendorHeaders,
      [1, "Worker", "90001", "16/09/2026", "16/09/2026 09:00:00", "RUN-1", "BP_RUNSHEET", "HUB_PHN", 1, 1, "OTHER VENDOR"],
      [2, "Worker", "90001", "16/09/2026", "16/09/2026 09:05:00", "PICK-1", "BP_PICKUPSHEET", "HUB_PHN", 1, 1, "OTHER VENDOR"]
    ]), {
      allowedStationCodes: ["PHN"],
      expectedVendorNames: ["DROPX LOGISTICS"],
      rejectInvalidRows: true,
      requireBothSheetTypes: true
    }),
    /ODH Vendor must match DROPX LOGISTICS/i
  );

  assert.throws(
    () => parseFlipkartProductionMatrix(workbookRows([
      vendorHeaders,
      [1, "Worker", "90001", "16/09/2026", "16/09/2026 09:00:00", "RUN-1", "BP_RUNSHEET", "HUB_PHN", 1, 1, "DROPX LOGISTICS"]
    ]), {
      allowedStationCodes: ["PHN"],
      expectedVendorNames: ["DROPX LOGISTICS"],
      rejectInvalidRows: true,
      requireBothSheetTypes: true
    }),
    /missing BP_PICKUPSHEET/i
  );

  assert.throws(
    () => parseFlipkartProductionMatrix(workbookRows([
      vendorHeaders,
      [1, "PHN worker", "90001", "16/09/2026", "16/09/2026 09:00:00", "PHN-RUN", "BP_RUNSHEET", "HUB_PHN", 1, 1, "DROPX LOGISTICS"],
      [2, "PHN worker", "90001", "16/09/2026", "16/09/2026 09:05:00", "PHN-PICK", "BP_PICKUPSHEET", "HUB_PHN", 1, 1, "DROPX LOGISTICS"],
      [3, "PMB worker", "90002", "16/09/2026", "16/09/2026 09:10:00", "PMB-RUN", "BP_RUNSHEET", "HUB_PMB", 1, 1, "DROPX LOGISTICS"]
    ]), {
      allowedStationCodes: ["PHN", "PMB"],
      expectedVendorNames: ["DROPX LOGISTICS"],
      rejectInvalidRows: true,
      requireBothSheetTypes: true
    }),
    /PMB is missing BP_PICKUPSHEET/i
  );
});

test("uses sheet create dates to validate first and second half-month cycles", () => {
  assert.deepEqual(validateFlipkartImportCycle(["2026-02-01", "2026-02-15"]), {
    cycle: 1,
    endDate: "2026-02-15",
    key: "2026-02-H1",
    month: 2,
    observedEndDate: "2026-02-15",
    observedStartDate: "2026-02-01",
    startDate: "2026-02-01",
    year: 2026
  });
  assert.equal(validateFlipkartImportCycle(["2026-09-16", "2026-09-30"]).endDate, "2026-09-30");
  assert.equal(validateFlipkartImportCycle(["2026-10-16", "2026-10-31"]).endDate, "2026-10-31");
  assert.throws(
    () => validateFlipkartImportCycle(["2026-09-15", "2026-09-16"]),
    /one cycle only/i
  );
  assert.throws(
    () => validateFlipkartImportCycle(["2026-09-16", "2026-10-16"]),
    /one cycle only/i
  );
});

test("authoritative uploads reject invalid rows and incomplete cycle boundaries", () => {
  assert.throws(
    () => parseFlipkartProductionMatrix(workbookRows([
      HEADERS,
      [1, "Valid", "70001", "16/09/2026", "16/09/2026 10:00:00", "GOOD-1", "BP_RUNSHEET", "HUB_PHN", 1, 1],
      [2, "Invalid", "70002", "30/09/2026", "30/09/2026 10:00:00", "BAD-1", "OTHER", "HUB_PHN", 1, 1]
    ]), { allowedStationCodes: ["PHN"], rejectInvalidRows: true, requireCompleteCycle: true }),
    /1 invalid row[\s\S]*row 3[\s\S]*BP_RUNSHEET or BP_PICKUPSHEET/i
  );

  assert.throws(
    () => parseFlipkartProductionMatrix(workbookRows([
      HEADERS,
      [1, "Partial", "70001", "17/09/2026", "17/09/2026 10:00:00", "PART-1", "BP_RUNSHEET", "HUB_PHN", 1, 1],
      [2, "Partial", "70001", "29/09/2026", "29/09/2026 10:00:00", "PART-2", "BP_RUNSHEET", "HUB_PHN", 1, 1]
    ]), { allowedStationCodes: ["PHN"], rejectInvalidRows: true, requireCompleteCycle: true }),
    /incomplete[\s\S]*2026-09-16 to 2026-09-30[\s\S]*2026-09-17 to 2026-09-29/i
  );

  const rowsWithInteriorGap = [HEADERS];
  for (let day = 16; day <= 30; day += 1) {
    if (day === 23) continue;
    rowsWithInteriorGap.push([
      day,
      "Gap",
      "70001",
      `${day}/09/2026`,
      `${day}/09/2026 10:00:00`,
      `GAP-${day}`,
      "BP_RUNSHEET",
      "HUB_PHN",
      1,
      1
    ]);
  }
  assert.throws(
    () => parseFlipkartProductionMatrix(workbookRows(rowsWithInteriorGap), {
      allowedStationCodes: ["PHN"],
      rejectInvalidRows: true,
      requireCompleteCycle: true
    }),
    /1 cycle date is missing \(2026-09-23\)/i
  );

});

test("keeps the Excel date-only business day in positive timezones", () => {
  const parsed = parseFlipkartProductionMatrix(workbookRows([
    HEADERS,
    [1, "Date cell", "70001", new Date(2026, 8, 16), new Date(2026, 8, 16, 10), "DATE-1", "BP_RUNSHEET", "HUB_PHN", 1, 1]
  ]));
  assert.equal(parsed.rows[0].workDate, "2026-09-16");
  assert.equal(parsed.cycle.key, "2026-09-H2");
});

test("preserves zero completed and skips invalid production rows with field issues", () => {
  const parsed = parseFlipkartProductionMatrix(workbookRows([
    HEADERS,
    [1, "Zero", "70001", "18/09/2026", "18/09/2026 10:00:00", "ZERO-1", "BP_RUNSHEET", "MEPPAYURMDH_MEP", 2, 0],
    [2, "Fraction", "70002", "18/09/2026", "18/09/2026 10:00:00", "BAD-1", "BP_RUNSHEET", "MEPPAYURMDH_MEP", 2, 1.5],
    [3, "Negative", "70003", "18/09/2026", "18/09/2026 10:00:00", "BAD-2", "BP_PICKUPSHEET", "MEPPAYURMDH_MEP", 2, -1],
    [4, "Unknown type", "70004", "18/09/2026", "18/09/2026 10:00:00", "BAD-3", "OTHER", "MEPPAYURMDH_MEP", 2, 1],
    [5, "Unknown hub", "70005", "18/09/2026", "18/09/2026 10:00:00", "BAD-4", "BP_RUNSHEET", "OTHER_XXX", 2, 1]
  ]), { allowedStationCodes: ["MEP"] });

  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].completed, 0);
  assert.equal(parsed.daily[0].totalActivity, 0);
  assert.deepEqual(parsed.issues.map((issue) => issue.field), ["completed", "completed", "sheet_type", "hub_name"]);
});

test("keeps provider IDs as text and refuses unsafe or scientific numeric identities", () => {
  assert.equal(normalizeFlipkartProviderId("  00008006  "), "00008006");
  assert.equal(normalizeFlipkartProviderId(20_000_743_121_95), "2000074312195");
  assert.equal(normalizeFlipkartProviderId(Number.MAX_SAFE_INTEGER + 1), null);
  assert.equal(normalizeFlipkartProviderId("2.000074312195E+12"), null);
});

test("exposes exact sheet and station mappings for route integration", () => {
  assert.equal(flipkartMetricForSheetType("bp-runsheet"), "delivery");
  assert.equal(flipkartMetricForSheetType(" BP PICKUPSHEET "), "customer_return");
  assert.equal(flipkartMetricForSheetType("other"), null);
  assert.equal(stationCodeFromFlipkartHub("SASCHEMPANODAMDH_CHM"), "CHM");
  assert.equal(stationCodeFromFlipkartHub("SASCHEMPANODAMDH_CHM", ["PHN"]), null);
});

test("keeps explicit zero assigned and rejects a missing Assigned column", () => {
  const withZero = parseFlipkartProductionMatrix(workbookRows([
    HEADERS,
    [1, "Worker", "90001", "16/09/2026", "16/09/2026 09:00:00", "RUN-1", "BP_RUNSHEET", "HUB_PHN", 0, 0],
    [2, "Worker", "90001", "16/09/2026", "16/09/2026 09:05:00", "PICK-1", "BP_PICKUPSHEET", "HUB_PHN", 0, 0]
  ]), { allowedStationCodes: ["PHN"], requireBothSheetTypes: true });
  assert.equal(withZero.rows[0].assigned, 0);
  assert.equal(withZero.daily[0].assignedCount, 0);

  assert.throws(
    () => parseFlipkartProductionMatrix(workbookRows([
      ["casper_employee_id", "sheet_create_date_time", "sheet_update_date_time", "sheet_id", "sheet_type", "hub_name", "completed"],
      ["90001", "16/09/2026", "16/09/2026 09:00:00", "RUN-1", "BP_RUNSHEET", "HUB_PHN", 1]
    ]), { allowedStationCodes: ["PHN"] }),
    /missing required columns:[\s\S]*assigned/i
  );

  const blankAssigned = parseFlipkartProductionMatrix(workbookRows([
    HEADERS,
    [1, "Worker", "90001", "16/09/2026", "16/09/2026 09:00:00", "RUN-1", "BP_RUNSHEET", "HUB_PHN", "", 1],
    [2, "Worker", "90001", "16/09/2026", "16/09/2026 09:05:00", "PICK-1", "BP_PICKUPSHEET", "HUB_PHN", 2, 1]
  ]), { allowedStationCodes: ["PHN"] });
  assert.equal(blankAssigned.rows.length, 1);
  assert.equal(blankAssigned.rows[0].assigned, 2);
  assert.ok(blankAssigned.issues.some((issue) => /Assigned must be a non-negative whole number/i.test(issue.message)));
});

test("daily aggregation is separate for date, station and provider ID", () => {
  const base = {
    assigned: 1,
    completed: 1,
    metric: "delivery",
    providerEmployeeName: "Worker",
    rowNumber: 2,
    sheetId: "A",
    sheetType: "BP_RUNSHEET",
    sourceId: null,
    updatedAt: "2026-09-16T10:00:00.000Z"
  };
  const daily = aggregateFlipkartDailyProduction([
    { ...base, providerEmployeeId: "1", stationCode: "PHN", workDate: "2026-09-16" },
    { ...base, providerEmployeeId: "1", stationCode: "PMB", workDate: "2026-09-16", sheetId: "B", rowNumber: 3 },
    { ...base, providerEmployeeId: "2", stationCode: "PHN", workDate: "2026-09-16", sheetId: "C", rowNumber: 4 },
    { ...base, providerEmployeeId: "1", stationCode: "PHN", workDate: "2026-09-17", sheetId: "D", rowNumber: 5 }
  ]);
  assert.equal(daily.length, 4);
  assert.deepEqual(daily[0].sheetTypes, ["BP_RUNSHEET"]);
});
