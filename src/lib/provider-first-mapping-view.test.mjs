import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as XLSX from "xlsx";
import {
  canonicalizeProviderFirstMembers,
  filterProviderFirstRowIndexes,
  isScientificProviderMemberId,
  providerFirstPageWindow,
  providerFirstValidationStatus,
  providerMemberIdFromSpreadsheetCells,
  providerMemberKey,
  providerSourceMemberKey,
  scientificProviderIdCouldRepresent
} from "./provider-first-mapping-view.ts";

const method = { id: "method-1", components: [{ code: "DELIVERY", label: "Delivery rate" }], productionThresholdConfig: null };
const worker = {
  id: "worker-1",
  dropxId: "DROPX1",
  fullName: "Asha Devi",
  stationId: "station-1",
  providerId: "provider-1",
  dateOfJoin: "2026-09-01",
  mappingId: "mapping-1",
  paymentMethodId: method.id,
  paymentValues: { DELIVERY: "12" },
  productionThresholdConfig: null,
  productionThresholdMinimumUnits: "",
  effectiveFrom: "2026-09-01",
  effectiveTo: "",
  mappedProviderMemberId: "member-1",
  locationLabel: "KOZA",
  onboardingStatus: "Active"
};
const row = {
  providerMemberId: "member-1",
  providerMemberName: "Asha Devi",
  stationId: "station-1",
  stationLabel: "KOZA - Kozhikode",
  providerId: "provider-1",
  workforceId: worker.id,
  dropxId: worker.dropxId,
  dropxName: worker.fullName,
  mappingId: worker.mappingId,
  paymentMethodId: method.id,
  paymentValues: { DELIVERY: "12" },
  productionThresholdConfig: null,
  productionThresholdMinimumUnits: "",
  effectiveFrom: "2026-09-01",
  effectiveTo: ""
};

test("keys provider members by station and normalized member ID", () => {
  assert.equal(providerMemberKey("station-1", " abc "), "station-1|ABC");
  assert.notEqual(providerMemberKey("station-1", "ABC"), providerMemberKey("station-2", "ABC"));
});

test("recognizes scientific provider IDs without fabricating missing digits", () => {
  assert.equal(isScientificProviderMemberId("2.00001E+12"), true);
  assert.equal(isScientificProviderMemberId(" 2000014627340 "), false);
  assert.equal(scientificProviderIdCouldRepresent("2.00003E+12", "2000033019000"), true);
  assert.equal(scientificProviderIdCouldRepresent("2.00003E+12", "2000039999999"), false);
  assert.equal(scientificProviderIdCouldRepresent("2.00003E+12", "2000029999999"), true);
  assert.equal(scientificProviderIdCouldRepresent("2E+12", "2000033019000"), false);
  assert.equal(scientificProviderIdCouldRepresent(`${"9".repeat(129)}E+12`, "2000033019000"), false);
  assert.equal(scientificProviderIdCouldRepresent("2.00003E+12", "9".repeat(129)), false);
});

test("raw spreadsheet reads preserve provider ID evidence", () => {
  for (const [source, expected] of [
    ["2.00003E+12", "2.00003E+12"],
    ["\"2.00003E+12\"", "2.00003E+12"],
    ["0012345", "0012345"]
  ]) {
    const workbook = XLSX.read(`PROVIDER_MEMBER_ID\n${source}`, { type: "string", raw: true });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "", raw: true });
    assert.equal(rows[0].PROVIDER_MEMBER_ID, expected);
  }

  const sheet = XLSX.utils.aoa_to_sheet([["PROVIDER_MEMBER_ID"], [2000033019000], [Number.MAX_SAFE_INTEGER + 1]]);
  sheet.A2.z = "0.00000E+00";
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Sheet1");
  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const parsed = XLSX.read(bytes, { type: "buffer", raw: true });
  const rows = XLSX.utils.sheet_to_json(parsed.Sheets.Sheet1, { defval: "", raw: true });
  assert.equal(rows[0].PROVIDER_MEMBER_ID, 2000033019000);
  assert.equal(Number.isSafeInteger(rows[0].PROVIDER_MEMBER_ID), true);
  assert.equal(Number.isSafeInteger(rows[1].PROVIDER_MEMBER_ID), false);

  assert.deepEqual(providerMemberIdFromSpreadsheetCells("2.00003E+12", 2000033019000), {
    providerMemberId: "2000033019000",
    providerMemberIdUnsafeNumber: false
  });
  assert.deepEqual(providerMemberIdFromSpreadsheetCells("0012345", 12345), {
    providerMemberId: "0012345",
    providerMemberIdUnsafeNumber: false
  });
  assert.deepEqual(providerMemberIdFromSpreadsheetCells("9.00720E+15", Number.MAX_SAFE_INTEGER + 1), {
    providerMemberId: String(Number.MAX_SAFE_INTEGER + 1),
    providerMemberIdUnsafeNumber: true
  });
  assert.equal(providerMemberIdFromSpreadsheetCells("1.23457E+15", 1234567890123450).providerMemberIdUnsafeNumber, true);
});

test("replaces rounded duplicate IDs only when one full provider ID is unambiguous", () => {
  const pokala = {
    stationCode: "GDRD",
    providerMemberName: "POKALA BHARATH / SPVAN _DROP / 111839719"
  };
  assert.deepEqual(canonicalizeProviderFirstMembers([
    { ...pokala, providerMemberId: "2.00003E+12", workDate: "2026-07-26" },
    { ...pokala, providerMemberId: "2000033019000", workDate: "2026-10-01" }
  ]), [{ ...pokala, providerMemberId: "2000033019000", workDate: "2026-10-01" }]);

  const unresolved = { stationCode: "KOZA", providerMemberName: "UNKNOWN / DROP", providerMemberId: "2.00001E+12", workDate: "2026-07-26" };
  assert.deepEqual(canonicalizeProviderFirstMembers([unresolved]), [unresolved]);

  const incompatible = { ...pokala, providerMemberId: "2000099999999", workDate: "2026-10-01" };
  assert.deepEqual(canonicalizeProviderFirstMembers([
    { ...pokala, providerMemberId: "2.00003E+12", workDate: "2026-07-26" },
    incompatible
  ]), [incompatible, { ...pokala, providerMemberId: "2.00003E+12", workDate: "2026-07-26" }]);

  const protectedScientific = { ...pokala, providerMemberId: "2.00003E+12", workDate: "2026-07-26" };
  assert.deepEqual(canonicalizeProviderFirstMembers([
    protectedScientific,
    { ...pokala, providerMemberId: "2000033019000", workDate: "2026-10-01" }
  ], new Set([providerSourceMemberKey("GDRD", "2.00003E+12")])), [
    { ...pokala, providerMemberId: "2000033019000", workDate: "2026-10-01" },
    protectedScientific
  ]);
  assert.deepEqual(canonicalizeProviderFirstMembers([
    protectedScientific,
    { ...pokala, providerMemberId: "2000033019000", workDate: "2026-10-01" }
  ], new Set([providerSourceMemberKey("*", "2.00003E+12")])), [
    { ...pokala, providerMemberId: "2000033019000", workDate: "2026-10-01" },
    protectedScientific
  ]);

  const compatiblePlusUnrelated = [
    { ...pokala, providerMemberId: "2.00003E+12", workDate: "2026-07-26" },
    { ...pokala, providerMemberId: "2000033019000", workDate: "2026-10-01" },
    { ...pokala, providerMemberId: "2000099999999", workDate: "2026-10-02" }
  ];
  assert.deepEqual(canonicalizeProviderFirstMembers(compatiblePlusUnrelated), compatiblePlusUnrelated.slice(1));

  const ambiguous = [
    { ...pokala, providerMemberId: "2.00003E+12", workDate: "2026-07-26" },
    { ...pokala, providerMemberId: "2000033019000", workDate: "2026-10-01" },
    { ...pokala, providerMemberId: "2000032000000", workDate: "2026-10-02" }
  ];
  assert.deepEqual(canonicalizeProviderFirstMembers(ambiguous), [ambiguous[1], ambiguous[2], ambiguous[0]]);

  const punctuationDistinct = [
    { stationCode: "GDRD", providerMemberName: "AB / C", providerMemberId: "2.00003E+12", workDate: "2026-07-26" },
    { stationCode: "GDRD", providerMemberName: "A / BC", providerMemberId: "2000033019000", workDate: "2026-10-01" }
  ];
  assert.deepEqual(canonicalizeProviderFirstMembers(punctuationDistinct), punctuationDistinct);

  const unnamed = [
    { stationCode: "GDRD", providerMemberName: "", providerMemberId: "2.00003E+12", workDate: "2026-07-26" },
    { stationCode: "GDRD", providerMemberName: "", providerMemberId: "2000033019000", workDate: "2026-10-01" }
  ];
  assert.deepEqual(canonicalizeProviderFirstMembers(unnamed), unnamed);
});

test("classifies every required mapped-row field consistently", () => {
  assert.equal(providerFirstValidationStatus(row, worker, method), "ready");
  assert.equal(providerFirstValidationStatus(row, { ...worker, mappedProviderMemberId: " MEMBER-1 " }, method), "ready");
  assert.equal(providerFirstValidationStatus({ ...row, workforceId: "" }, undefined, undefined), "unmapped");
  for (const invalid of [
    { ...row, providerId: "" },
    { ...row, paymentMethodId: "" },
    { ...row, effectiveFrom: "" },
    { ...row, effectiveTo: "2026-08-31" },
    { ...row, paymentValues: {} },
    { ...row, paymentValues: { DELIVERY: "-1" } }
  ]) assert.equal(providerFirstValidationStatus(invalid, worker, method), "needs_attention");
});

test("requires one positive whole-number combined minimum for a threshold method", () => {
  const thresholdMethod = {
    ...method,
    components: [
      { code: "DELIVERY", label: "Delivery rate" },
      { code: "CUSTOMER_RETURN", label: "Customer return rate" }
    ],
    productionThresholdConfig: { period: "month", component_codes: ["DELIVERY", "CUSTOMER_RETURN"] }
  };
  const thresholdRow = {
    ...row,
    paymentValues: { DELIVERY: "12", CUSTOMER_RETURN: "8" },
    productionThresholdConfig: null,
    productionThresholdMinimumUnits: ""
  };
  assert.match(providerFirstValidationStatus(thresholdRow, worker, thresholdMethod), /needs_attention/);
  assert.equal(providerFirstValidationStatus({ ...thresholdRow, productionThresholdMinimumUnits: "1000" }, worker, thresholdMethod), "ready");
  assert.equal(providerFirstValidationStatus({ ...thresholdRow, productionThresholdMinimumUnits: "10.5" }, worker, thresholdMethod), "needs_attention");
});

test("combines filter groups with AND and selections within a group with OR", () => {
  const second = { ...row, providerMemberId: "member-2", providerMemberName: "Ravi Kumar", workforceId: "", dropxId: "", dropxName: "", paymentMethodId: "", mappingId: "", paymentValues: {} };
  const indexes = filterProviderFirstRowIndexes({
    rows: [row, second],
    workerById: new Map([[worker.id, worker]]),
    paymentMethodById: new Map([[method.id, method]]),
    filters: {
      query: "  ASHA ",
      stationIds: ["station-1", "station-2"],
      paymentMethodIds: [method.id],
      mappingStatuses: ["mapped"],
      validationStatuses: ["ready"]
    }
  });
  assert.deepEqual(indexes, [0]);

  const unassigned = filterProviderFirstRowIndexes({
    rows: [row, second],
    workerById: new Map([[worker.id, worker]]),
    paymentMethodById: new Map([[method.id, method]]),
    filters: { query: "ravi", stationIds: [], paymentMethodIds: ["unassigned"], mappingStatuses: [], validationStatuses: ["unmapped"] }
  });
  assert.deepEqual(unassigned, [1]);
});

test("paginates 1,103 filtered rows with every supported size", () => {
  assert.deepEqual(providerFirstPageWindow(1103, 1, 50), { page: 1, totalPages: 23, fromIndex: 0, toIndex: 50, shownFrom: 1, shownTo: 50 });
  assert.equal(providerFirstPageWindow(1103, 99, 100).page, 12);
  assert.equal(providerFirstPageWindow(1103, 1, 500).totalPages, 3);
  assert.equal(providerFirstPageWindow(1103, 1, 1000).totalPages, 2);
  assert.deepEqual(providerFirstPageWindow(1103, 4, "all"), { page: 1, totalPages: 1, fromIndex: 0, toIndex: 1103, shownFrom: 1, shownTo: 1103 });
  assert.equal(providerFirstPageWindow(0, 3, 50).shownFrom, 0);
});

test("provider-first renders only the selected page and saves without navigation", async () => {
  const [component, actions] = await Promise.all([
    readFile(new URL("../components/provider-first-mapping-worksheet.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/provider-mapping/actions.ts", import.meta.url), "utf8")
  ]);
  assert.match(component, /paginatedIndexes\.map/);
  assert.match(component, /isScientificProviderMemberId\(row\.providerMemberId\)/);
  assert.match(component, /formData\.set\(`\$\{prefix\}\[provider_member_id\]`, row\.providerMemberId\)/);
  assert.match(component, /Combined minimum \/ \{productionThresholdConfig\.period\}/);
  assert.match(component, /production_threshold_minimum_units/);
  assert.doesNotMatch(component, /<form action=\{saveProviderFirstMappingWorksheet\}/);
  const start = actions.indexOf("export async function saveProviderFirstMappingsInline");
  const end = actions.indexOf("/** Links an imported provider member", start);
  const inlineAction = actions.slice(start, end);
  assert.match(inlineAction, /getAuthorization\(\)/);
  assert.match(inlineAction, /canEditProviderMappings\(authorization\)/);
  assert.match(inlineAction, /saveExecutiveMappingRow/);
  assert.doesNotMatch(inlineAction, /redirect\(|revalidatePath\(/);
  assert.match(actions, /isScientificProviderMemberId\(providerMemberId\)/);
  assert.match(actions, /XLSX\.read\(await file\.arrayBuffer\(\), \{ type: "array", raw: true \}\)/);
  assert.match(actions, /identifierRows = XLSX\.utils\.sheet_to_json[\s\S]*raw: true/);
  assert.match(actions, /providerMemberIdUnsafeNumber/);
  assert.match(actions, /memberNameByStationAndId\.get\(`\$\{station\.stationCode\}\|\$\{uploadRow\.providerMemberId\}`\)/);
  assert.match(actions, /providerHolderMatches\(holderName, worker\.fullName\)/);
  assert.match(actions, /production_threshold_config: productionThresholdConfig/);
  assert.match(actions, /Changes to an existing monthly combined minimum must start on the first day of a month/);
  assert.match(actions, /const providerId = String\(station\.provider_id/);
  assert.match(actions, /worker's current location is not allocated to your account/);
});
