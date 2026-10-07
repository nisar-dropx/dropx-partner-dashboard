import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkforceAdvanceCsv,
  filterWorkforceAdvanceRows,
  matchesWorkforceAdvanceFilters,
  summarizeWorkforceAdvanceRows,
  workforceAdvanceExportFilename,
  workforceAdvanceFacetValues
} from "./workforce-advance-register-view.ts";

const rows = [
  {
    advanceNumber: "WA-001",
    advanceDate: "2026-09-01",
    dropxId: "2000031112340",
    workforceName: "Boundary One",
    designation: "Delivery Associate",
    location: "NLRF",
    paidLocation: "NLRF",
    total: 1000,
    deducted: 200,
    pending: 800,
    status: "Pending",
    linkStatus: "linked",
    paymentMode: "bank_transfer",
    paymentReference: "001234",
    externalReference: "EXT,001",
    remark: "First boundary",
    source: "manual",
    createdAt: "2026-09-01T09:00:00.000Z"
  },
  {
    advanceNumber: "WA-002",
    advanceDate: "2026-09-30",
    dropxId: "JDBD1002",
    workforceName: "Boundary Two",
    designation: "Driver",
    location: "NLRF",
    paidLocation: "JDBD",
    total: 500,
    deducted: 500,
    pending: 0,
    status: "Fully deducted",
    linkStatus: "linked",
    paymentMode: "upi",
    paymentReference: "UPI-002",
    externalReference: "EXT-002",
    remark: "Quoted \"remark\", with comma\nand newline",
    source: "bulk_import",
    createdAt: "2026-09-30T18:30:00.000Z"
  },
  {
    advanceNumber: "WA-003",
    advanceDate: "2026-10-01",
    dropxId: "DROPX1003",
    workforceName: "Awaiting Workforce registration",
    designation: "",
    location: "—",
    paidLocation: "—",
    total: 2000,
    deducted: 0,
    pending: 2000,
    status: "Awaiting Workforce registration",
    linkStatus: "pending",
    paymentMode: "cash",
    paymentReference: "CASH-003",
    externalReference: "@external-command",
    remark: "=SUM(1,1)",
    source: "bulk_import",
    createdAt: "2026-10-01T08:00:00.000Z"
  },
  {
    advanceNumber: "WA-004",
    advanceDate: "2026-10-15",
    dropxId: "DROPX1004",
    workforceName: "Partial Person",
    designation: "Delivery Associate",
    location: "JDBD",
    paidLocation: "NLRF",
    total: 750.1,
    deducted: 250.05,
    pending: 500.05,
    status: "Partially deducted",
    linkStatus: "linked",
    paymentMode: "bank_transfer",
    paymentReference: "BANK-004",
    externalReference: "EXT-004",
    remark: "-not-a-number",
    source: "manual",
    createdAt: "2026-10-15T08:00:00.000Z"
  }
];

const all = {
  designations: [],
  locations: [],
  paidLocations: [],
  paymentModes: [],
  statuses: [],
  sources: [],
  registrationStatuses: [],
  dateFrom: "",
  dateTo: ""
};

test("empty selections retain every advance and text search covers register details", () => {
  assert.equal(filterWorkforceAdvanceRows(rows, "", all).length, 4);
  assert.equal(matchesWorkforceAdvanceFilters(rows[1], "ext-002", all), true);
  assert.equal(matchesWorkforceAdvanceFilters(rows[1], "missing value", all), false);
});

test("multiple values inside a facet use OR matching", () => {
  const filtered = filterWorkforceAdvanceRows(rows, "", {
    ...all,
    statuses: ["Pending", "Partially deducted"],
    locations: ["NLRF", "JDBD"]
  });
  assert.deepEqual(filtered.map((row) => row.advanceNumber), ["WA-001", "WA-004"]);
});

test("different facets combine with AND matching", () => {
  const filtered = filterWorkforceAdvanceRows(rows, "", {
    ...all,
    designations: ["Delivery Associate", "Driver"],
    locations: ["NLRF"],
    paymentModes: ["upi"],
    statuses: ["Fully deducted", "Partially deducted"],
    sources: ["bulk_import"]
  });
  assert.deepEqual(filtered.map((row) => row.advanceNumber), ["WA-002"]);
});

test("current location and historical paid location are separate facets", () => {
  assert.deepEqual(filterWorkforceAdvanceRows(rows, "", { ...all, locations: ["NLRF"] }).map((row) => row.advanceNumber), ["WA-001", "WA-002"]);
  assert.deepEqual(filterWorkforceAdvanceRows(rows, "", { ...all, paidLocations: ["NLRF"] }).map((row) => row.advanceNumber), ["WA-001", "WA-004"]);
  assert.deepEqual(filterWorkforceAdvanceRows(rows, "", { ...all, locations: ["NLRF"], paidLocations: ["JDBD"] }).map((row) => row.advanceNumber), ["WA-002"]);
});

test("registration status, payment mode, deduction status and source all filter independently", () => {
  assert.deepEqual(filterWorkforceAdvanceRows(rows, "", { ...all, registrationStatuses: ["pending"] }).map((row) => row.advanceNumber), ["WA-003"]);
  assert.deepEqual(filterWorkforceAdvanceRows(rows, "", { ...all, paymentModes: ["bank_transfer"] }).map((row) => row.advanceNumber), ["WA-001", "WA-004"]);
  assert.deepEqual(filterWorkforceAdvanceRows(rows, "", { ...all, statuses: ["Partially deducted"] }).map((row) => row.advanceNumber), ["WA-004"]);
  assert.deepEqual(filterWorkforceAdvanceRows(rows, "", { ...all, sources: ["bulk_import"] }).map((row) => row.advanceNumber), ["WA-002", "WA-003"]);
});

test("paid-on date range includes both boundaries", () => {
  const filtered = filterWorkforceAdvanceRows(rows, "", { ...all, dateFrom: "2026-09-01", dateTo: "2026-09-30" });
  assert.deepEqual(filtered.map((row) => row.advanceNumber), ["WA-001", "WA-002"]);
});

test("one-sided paid-on date filters apply from and through bounds", () => {
  assert.deepEqual(
    filterWorkforceAdvanceRows(rows, "", { ...all, dateFrom: "2026-10-01" }).map((row) => row.advanceNumber),
    ["WA-003", "WA-004"]
  );
  assert.deepEqual(
    filterWorkforceAdvanceRows(rows, "", { ...all, dateTo: "2026-09-30" }).map((row) => row.advanceNumber),
    ["WA-001", "WA-002"]
  );
});

test("summary totals use only supplied filtered rows and preserve explicit pending amounts", () => {
  const filtered = filterWorkforceAdvanceRows(rows, "", { ...all, dateFrom: "2026-09-01", dateTo: "2026-09-30" });
  assert.deepEqual(summarizeWorkforceAdvanceRows(filtered), {
    records: 2,
    awaitingRegistration: 0,
    total: 1500,
    deducted: 700,
    pending: 800
  });
  assert.deepEqual(summarizeWorkforceAdvanceRows([]), {
    records: 0,
    awaitingRegistration: 0,
    total: 0,
    deducted: 0,
    pending: 0
  });
  assert.deepEqual(summarizeWorkforceAdvanceRows([rows[2]]), {
    records: 1,
    awaitingRegistration: 1,
    total: 2000,
    deducted: 0,
    pending: 2000
  });
});

test("facet values are unique, sorted and cover registration plus current and paid locations", () => {
  assert.deepEqual(workforceAdvanceFacetValues(rows, "designation"), ["—", "Delivery Associate", "Driver"]);
  assert.deepEqual(workforceAdvanceFacetValues(rows, "location"), ["—", "JDBD", "NLRF"]);
  assert.deepEqual(workforceAdvanceFacetValues(rows, "paidLocation"), ["—", "JDBD", "NLRF"]);
  assert.deepEqual(workforceAdvanceFacetValues(rows, "registrationStatus"), ["linked", "pending"]);
});

test("CSV exports exactly the rows supplied rather than a page-sized or unfiltered set", () => {
  const filtered = filterWorkforceAdvanceRows(rows, "", { ...all, statuses: ["Fully deducted"] });
  const filteredCsv = buildWorkforceAdvanceCsv(filtered);
  assert.match(filteredCsv, /WA-002/);
  assert.doesNotMatch(filteredCsv, /WA-001|WA-003|WA-004/);

  const allCsv = buildWorkforceAdvanceCsv(rows);
  for (const row of rows) assert.match(allCsv, new RegExp(row.advanceNumber));
});

test("CSV is Excel-friendly, escapes free text, blocks formulas and preserves long numeric IDs", () => {
  const csv = buildWorkforceAdvanceCsv(rows);
  assert.equal(csv.startsWith("\uFEFF"), true);
  assert.match(csv, /"'2000031112340"/);
  assert.match(csv, /"'001234"/);
  assert.match(csv, /"'@external-command"/);
  assert.match(csv, /"'=SUM\(1,1\)"/);
  assert.match(csv, /"'-not-a-number"/);
  assert.match(csv, /"EXT,001"/);
  assert.match(csv, /"Quoted ""remark"", with comma\nand newline"/);
  assert.match(csv, /\r\n/);
});

test("export filenames describe the selected paid-on date boundary", () => {
  assert.equal(workforceAdvanceExportFilename(), "workforce-advances.csv");
  assert.equal(workforceAdvanceExportFilename("2026-09-01"), "workforce-advances-from-2026-09-01.csv");
  assert.equal(workforceAdvanceExportFilename("", "2026-09-30"), "workforce-advances-through-2026-09-30.csv");
  assert.equal(workforceAdvanceExportFilename("2026-09-01", "2026-09-30"), "workforce-advances-2026-09-01-to-2026-09-30.csv");
});
