import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import * as XLSX from "xlsx";
import {
  buildProviderFirstWorkerSelectionIndex,
  canonicalizeProviderFirstMembers,
  filterProviderFirstRowIndexes,
  isScientificProviderMemberId,
  providerFirstPageWindow,
  providerFirstLocationRemap,
  providerFirstLocationNeedsDates,
  providerFirstLocationIsAllowed,
  providerFirstMappingReferenceForRow,
  providerFirstMappingReplacement,
  providerFirstMappingReplacementMessage,
  providerFirstNamesMatch,
  providerFirstRowForMappingPeriod,
  providerFirstRowIssue,
  providerFirstValidationStatus,
  providerFirstWorkerIsSelectable,
  providerMemberIdFromSpreadsheetCells,
  providerMemberIdentityKey,
  providerMemberKey,
  providerSourceMemberKey,
  scientificProviderIdCouldRepresent
} from "./provider-first-mapping-view.ts";

test('legacy DropX prefixes do not block a parent/XPT mapping; missing dates get a specific prompt', () => {
  const parentMapping = { mappingId: 'parent-mapping', stationId: 'JUGD-id', locationLabel: 'JUGD',
    providerId: 'amazon', mappedProviderMemberId: '2000051462860', effectiveFrom: '2026-09-01', effectiveTo: '', status: 'active' };
  const person = { id: 'pritam', dropxId: 'SDGH140021', fullName: 'PRITAM KUMAR BHAISAL',
    profileStationId: 'JUGD-id', profileLocationLabel: 'JUGD', stationId: 'JUGD-id',
    registeredLocationMappings: [parentMapping], currentMappings: [parentMapping] };
  const assignment = { workforceId: 'pritam', stationId: 'JUGF-id', stationLabel: 'JUGF',
    relatedStationIds: ['JUGD-id','JUGF-id'], providerId: 'amazon', providerMemberId: '2000051462860',
    effectiveFrom: '', effectiveTo: '' };
  assert.equal(providerFirstLocationNeedsDates(assignment, person), true);
  assert.match(providerFirstRowIssue(assignment, person), /Enter Effective from/);
  assert.equal(providerFirstLocationIsAllowed(assignment, person), false);
  const dated = {...assignment, effectiveFrom: '2026-10-01'};
  assert.equal(providerFirstLocationNeedsDates(dated, person), false);
  assert.equal(providerFirstLocationIsAllowed(dated, person), true);
  assert.equal(providerFirstLocationRemap(dated, person)?.allowMove, false);
  assert.equal(providerFirstLocationIsAllowed({...dated,effectiveFrom:'2026-08-01'}, person), false);
  assert.equal(providerFirstLocationNeedsDates({...assignment,providerMemberId:'someone-else'}, person), false);
  assert.equal(providerFirstLocationIsAllowed({...dated,providerMemberId:'someone-else'}, person), false);
});

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
  profileStationId: "station-1",
  profileLocationLabel: "KOZA",
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

test("keys history across locations by exact provider and member identity without changing mapping identity", () => {
  const oldStationMappingKey = providerMemberKey("station-old", " 2000080007500 ");
  const newStationMappingKey = providerMemberKey("station-new", "2000080007500");
  assert.notEqual(oldStationMappingKey, newStationMappingKey, "mapping ownership must remain station-specific");

  const oldStationHistoryKey = providerMemberIdentityKey(" Provider-A ", " 2000080007500 ");
  const newStationHistoryKey = providerMemberIdentityKey("provider-a", "2000080007500");
  assert.equal(oldStationHistoryKey, newStationHistoryKey, "the same provider identity should expose its prior-location history");
  assert.notEqual(
    oldStationHistoryKey,
    providerMemberIdentityKey("provider-b", "2000080007500"),
    "the same member ID at a different provider must not leak history"
  );
  assert.notEqual(
    oldStationHistoryKey,
    providerMemberIdentityKey("provider-a", "2000080007501"),
    "a different member at the same provider must not leak history"
  );
});

test("provider mapping page preserves inactive-location history without inferring a new location mapping", async () => {
  const page = await readFile(new URL("../app/provider-id-mapping/page.tsx", import.meta.url), "utf8");
  assert.match(page, /from\("stations"\)[^\n]+\.eq\("company_id", companyId\)\.order\("station_code"\)/);
  assert.doesNotMatch(page, /from\("stations"\)[^\n]+\.eq\("is_active", true\)/);
  assert.match(page, /const link = mappingByMember\.get\(providerMemberKey\(member\.stationId, member\.id\)\)/);
  assert.match(page, /historyByProviderMember\.get\(providerMemberIdentityKey\(member\.providerId, member\.id\)\)/);
  assert.match(page, /workforceId: worker\?\.id \?\? ""/);
});

test("requests an exact confirmation only when an existing provider mapping changes DropX owner", () => {
  const replacement = providerFirstMappingReplacement(row, {
    ...row,
    workforceId: "worker-2",
    dropxId: "DROPX1234",
    dropxName: "New Associate",
    mappingId: ""
  });
  assert.deepEqual(replacement, {
    kind: "owner",
    mappingId: "mapping-1",
    providerMemberId: "member-1",
    providerMemberName: "Asha Devi",
    existingDropxId: "DROPX1",
    existingDropxName: "Asha Devi"
  });
  assert.equal(
    providerFirstMappingReplacementMessage(replacement),
    "Provider ID member-1 - Asha Devi already mapped to DROPX1 - Asha Devi.\nDo you want to replace this mapping?"
  );
  assert.equal(providerFirstMappingReplacement(row, { ...row, paymentValues: { DELIVERY: "15" } }), null);
  assert.equal(providerFirstMappingReplacement({ ...row, mappingId: "" }, { ...row, workforceId: "worker-2" }), null);
});

test("permits only an exact same-provider, same-member location remap", () => {
  const destination = {
    ...row,
    stationId: "station-2",
    stationLabel: "JUGF - Sundergarh",
    effectiveFrom: "2026-09-01"
  };
  const sourceWorker = { ...worker, locationLabel: "JUGD - Jharsuguda" };
  const remap = providerFirstLocationRemap(destination, sourceWorker);
  assert.deepEqual(remap, {
    kind: "location",
    allowKeepAll: true,
    allowMove: false,
    mappingId: "mapping-1",
    providerMemberId: "member-1",
    providerMemberName: "Asha Devi",
    existingDropxId: "DROPX1",
    existingDropxName: "Asha Devi",
    existingLocationLabel: "JUGD - Jharsuguda",
    newLocationLabel: "JUGF - Sundergarh",
    effectiveFrom: "2026-09-01"
  });
  assert.equal(remap.allowMove, false);
  assert.equal(
    providerFirstMappingReplacementMessage(remap),
    "Provider ID member-1 - Asha Devi is already mapped to DROPX1 - Asha Devi at its registered location JUGD - Jharsuguda.\nUse Keep all to add JUGF - Sundergarh from 2026-09-01 for the same DropX ID while preserving the verified registered-location mapping for that period."
  );
  assert.equal(providerFirstValidationStatus(destination, sourceWorker, method), "ready");
  assert.equal(
    providerFirstRowIssue({ ...destination, effectiveTo: "2026-09-30" }, sourceWorker, method),
    "Move or Keep all requires an ongoing mapping. Leave Effective to blank."
  );
  assert.equal(providerFirstLocationRemap({ ...destination, providerId: "provider-2" }, sourceWorker), null);
  assert.equal(providerFirstLocationRemap({ ...destination, providerMemberId: "member-2" }, sourceWorker), null);
  assert.equal(providerFirstLocationRemap({ ...destination, mappingId: "stale-mapping" }, sourceWorker), null);
  assert.equal(providerFirstLocationRemap({ ...destination, effectiveFrom: "2026-08-31" }, sourceWorker), null);
  assert.equal(providerFirstValidationStatus({ ...destination, providerId: "provider-2" }, sourceWorker, method), "needs_attention");
});

test("offers cross-location candidates while retaining ownership and draft-conflict guards", () => {
  const available = {
    ...worker,
    id: "worker-2",
    dropxId: "DROPX2",
    stationId: "station-2",
    profileStationId: "station-2",
    locationLabel: "KLZA",
    profileLocationLabel: "KLZA",
    mappingId: "",
    providerId: "",
    mappedProviderMemberId: "",
    effectiveFrom: "",
    paymentMethodId: "",
    paymentValues: {},
    currentMappings: [],
    mappingHistory: []
  };
  const unmappedRow = {
    ...row,
    workforceId: "",
    dropxId: "",
    dropxName: "",
    mappingId: "",
    relatedStationIds: ["station-1"]
  };

  assert.equal(providerFirstWorkerIsSelectable(unmappedRow, available, [unmappedRow]), true);
  assert.equal(providerFirstWorkerIsSelectable(unmappedRow, { ...available, hasRestrictedMapping: true }, [unmappedRow]), false);

  const occupiedMapping = {
    mappingId: "occupied",
    stationId: available.stationId,
    locationLabel: available.locationLabel,
    providerId: "provider-2",
    mappedProviderMemberId: "member-2",
    paymentMethodId: method.id,
    paymentValues: { DELIVERY: "10" },
    productionThresholdConfig: null,
    productionThresholdMinimumUnits: "",
    effectiveFrom: "2026-09-01",
    effectiveTo: "",
    status: "active"
  };
  assert.equal(providerFirstWorkerIsSelectable(unmappedRow, { ...available, currentMappings: [occupiedMapping] }, [unmappedRow]), false);

  const conflictingDraft = {
    ...unmappedRow,
    providerId: "provider-2",
    providerMemberId: "member-2",
    workforceId: available.id
  };
  assert.equal(providerFirstWorkerIsSelectable(unmappedRow, available, [unmappedRow, conflictingDraft]), false);
});

test("offers an exact second-location candidate when its registered-location mapping covers the period", () => {
  const secondLocationRow = {
    ...row,
    stationId: "station-2",
    stationLabel: "KLZA",
    relatedStationIds: ["station-2"],
    workforceId: "",
    dropxId: "",
    dropxName: "",
    mappingId: ""
  };

  assert.equal(providerFirstWorkerIsSelectable(secondLocationRow, worker, [secondLocationRow]), true);
});

test("indexed worker selection preserves conflict rules without rescanning every draft", () => {
  const unmappedRow = {
    ...row,
    workforceId: "",
    dropxId: "",
    dropxName: "",
    mappingId: ""
  };
  const available = {
    ...worker,
    id: "available",
    mappingId: "",
    providerId: "",
    mappedProviderMemberId: "",
    currentMappings: [],
    mappingHistory: []
  };
  const occupied = {
    ...available,
    id: "occupied",
    currentMappings: [{
      mappingId: "other-mapping",
      stationId: "station-1",
      locationLabel: "KOZA",
      providerId: "provider-2",
      mappedProviderMemberId: "member-2",
      paymentMethodId: method.id,
      paymentValues: {},
      productionThresholdConfig: null,
      productionThresholdMinimumUnits: "",
      effectiveFrom: "2026-09-01",
      effectiveTo: "",
      status: "active"
    }]
  };
  const conflictingDraft = {
    ...unmappedRow,
    providerId: "provider-3",
    providerMemberId: "member-3",
    workforceId: available.id
  };
  const drafts = [unmappedRow, conflictingDraft];
  const workers = [available, occupied, { ...available, id: "restricted", hasRestrictedMapping: true }];
  const selectionIndex = buildProviderFirstWorkerSelectionIndex(workers, drafts, "2026-10-15");

  for (const candidate of workers) {
    assert.equal(
      providerFirstWorkerIsSelectable(unmappedRow, candidate, drafts, selectionIndex),
      providerFirstWorkerIsSelectable(unmappedRow, candidate, drafts),
      `indexed selection should match legacy rules for ${candidate.id}`
    );
  }
});

test("uses the effective mapping station and keeps both relocation choices when the Workforce profile already moved", () => {
  const driftedWorker = {
    ...worker,
    stationId: "station-1",
    locationLabel: "JUGD",
    profileStationId: "station-2",
    profileLocationLabel: "JUGF"
  };
  assert.equal(providerFirstLocationRemap({ ...row, stationId: "station-1" }, driftedWorker), null);
  assert.deepEqual(
    providerFirstLocationRemap({
      ...row,
      stationId: "station-2",
      stationLabel: "JUGF",
      effectiveFrom: "2026-10-04"
    }, driftedWorker),
    {
      kind: "location",
      allowKeepAll: true,
      allowMove: true,
      mappingId: "mapping-1",
      providerMemberId: "member-1",
      providerMemberName: "Asha Devi",
      existingDropxId: "DROPX1",
      existingDropxName: "Asha Devi",
      existingLocationLabel: "JUGD",
      newLocationLabel: "JUGF",
      effectiveFrom: "2026-10-04"
    }
  );
  const moveToProfile = providerFirstLocationRemap({
    ...row,
    stationId: "station-2",
    stationLabel: "JUGF",
    effectiveFrom: "2026-10-04"
  }, driftedWorker);
  assert.equal(moveToProfile?.allowKeepAll, true);
  assert.equal(moveToProfile?.allowMove, true);
  assert.match(providerFirstMappingReplacementMessage(moveToProfile), /move it to JUGF/i);
  assert.match(providerFirstMappingReplacementMessage(moveToProfile), /keep both location mappings/i);
  assert.match(providerFirstMappingReplacementMessage(moveToProfile), /Keep all preserves both locations from this date/);
});

test("a future source location cannot be moved before its own effective date", () => {
  const futureSource = {
    mappingId: "mapping-future-source",
    stationId: "station-1",
    locationLabel: "JUGD",
    providerId: row.providerId,
    mappedProviderMemberId: row.providerMemberId,
    paymentMethodId: method.id,
    paymentValues: { DELIVERY: "12" },
    productionThresholdConfig: null,
    productionThresholdMinimumUnits: "",
    effectiveFrom: "2026-10-15",
    effectiveTo: "",
    status: "active"
  };
  const futureSourceWorker = {
    ...worker,
    stationId: futureSource.stationId,
    locationLabel: futureSource.locationLabel,
    profileStationId: "station-2",
    profileLocationLabel: "JUGF",
    mappingId: futureSource.mappingId,
    paymentMethodId: futureSource.paymentMethodId,
    paymentValues: futureSource.paymentValues,
    effectiveFrom: futureSource.effectiveFrom,
    mappedProviderMemberId: futureSource.mappedProviderMemberId,
    currentMappings: [futureSource],
    mappingHistory: [futureSource]
  };
  const destination = {
    ...row,
    stationId: "station-2",
    stationLabel: "JUGF",
    mappingId: "",
    effectiveFrom: "2026-10-01",
    effectiveTo: ""
  };

  assert.equal(providerFirstLocationIsAllowed(destination, futureSourceWorker), false);
  assert.equal(providerFirstLocationRemap(destination, futureSourceWorker), null);
  assert.equal(providerFirstRowIssue(destination, futureSourceWorker, method), "Location mismatch.");
  const validFromSourceStart = { ...destination, effectiveFrom: "2026-10-15" };
  assert.equal(providerFirstLocationIsAllowed(validFromSourceStart, futureSourceWorker), true);
  assert.equal(providerFirstLocationRemap(validFromSourceStart, futureSourceWorker)?.mappingId, futureSource.mappingId);
});

test("relocation selects the latest mapping effective on the requested start instead of a later scheduled mapping", () => {
  const earlierSource = {
    mappingId: "mapping-september-source",
    stationId: "station-1",
    locationLabel: "JUGD",
    providerId: row.providerId,
    mappedProviderMemberId: row.providerMemberId,
    paymentMethodId: method.id,
    paymentValues: { DELIVERY: "12" },
    productionThresholdConfig: null,
    productionThresholdMinimumUnits: "",
    effectiveFrom: "2026-09-01",
    effectiveTo: "",
    status: "active"
  };
  const futureSource = {
    ...earlierSource,
    mappingId: "mapping-october-15-source",
    stationId: "station-3",
    locationLabel: "KLZA",
    effectiveFrom: "2026-10-15"
  };
  const multiLocationWorker = {
    ...worker,
    stationId: futureSource.stationId,
    locationLabel: futureSource.locationLabel,
    profileStationId: "station-2",
    profileLocationLabel: "JUGF",
    mappingId: futureSource.mappingId,
    paymentMethodId: futureSource.paymentMethodId,
    paymentValues: futureSource.paymentValues,
    effectiveFrom: futureSource.effectiveFrom,
    mappedProviderMemberId: futureSource.mappedProviderMemberId,
    currentMappings: [futureSource, earlierSource],
    mappingHistory: [futureSource, earlierSource]
  };
  const destination = {
    ...row,
    stationId: "station-2",
    stationLabel: "JUGF",
    mappingId: "",
    effectiveFrom: "2026-10-01",
    effectiveTo: ""
  };

  assert.equal(providerFirstMappingReferenceForRow(destination, multiLocationWorker)?.mappingId, earlierSource.mappingId);
  assert.equal(providerFirstLocationRemap(destination, multiLocationWorker)?.mappingId, earlierSource.mappingId);
  assert.equal(providerFirstLocationRemap(destination, multiLocationWorker)?.allowMove, true);
});

test("does not reuse a future current mapping for an earlier bounded period", () => {
  const futureMapping = {
    mappingId: "mapping-october",
    stationId: row.stationId,
    locationLabel: row.stationLabel,
    providerId: row.providerId,
    mappedProviderMemberId: row.providerMemberId,
    paymentMethodId: method.id,
    paymentValues: { DELIVERY: "12" },
    productionThresholdConfig: null,
    productionThresholdMinimumUnits: "",
    effectiveFrom: "2026-10-01",
    effectiveTo: "",
    status: "active"
  };
  const futureWorker = {
    ...worker,
    mappingId: futureMapping.mappingId,
    effectiveFrom: futureMapping.effectiveFrom,
    currentMappings: [futureMapping],
    mappingHistory: [futureMapping],
    registeredLocationMappings: [futureMapping]
  };
  const septemberRow = {
    ...row,
    mappingId: futureMapping.mappingId,
    effectiveFrom: "2026-09-01",
    effectiveTo: "2026-09-30"
  };

  assert.equal(providerFirstMappingReferenceForRow(septemberRow, futureWorker), undefined);
  assert.deepEqual(providerFirstRowForMappingPeriod(septemberRow, futureWorker), {
    ...septemberRow,
    mappingId: "",
    paymentMethodId: "",
    paymentValues: {},
    productionThresholdConfig: null,
    productionThresholdMinimumUnits: ""
  });
});

test("keeps a current mapping reference when the requested period overlaps it", () => {
  const futureMapping = {
    mappingId: "mapping-october",
    stationId: row.stationId,
    locationLabel: row.stationLabel,
    providerId: row.providerId,
    mappedProviderMemberId: row.providerMemberId,
    paymentMethodId: method.id,
    paymentValues: { DELIVERY: "12" },
    productionThresholdConfig: null,
    productionThresholdMinimumUnits: "",
    effectiveFrom: "2026-10-01",
    effectiveTo: "",
    status: "active"
  };
  const futureWorker = {
    ...worker,
    mappingId: futureMapping.mappingId,
    effectiveFrom: futureMapping.effectiveFrom,
    currentMappings: [futureMapping],
    mappingHistory: [futureMapping],
    registeredLocationMappings: [futureMapping]
  };

  assert.equal(
    providerFirstMappingReferenceForRow({
      ...row,
      mappingId: futureMapping.mappingId,
      effectiveFrom: "2026-09-01",
      effectiveTo: ""
    }, futureWorker)?.mappingId,
    futureMapping.mappingId
  );
  assert.equal(
    providerFirstMappingReferenceForRow({
      ...row,
      mappingId: futureMapping.mappingId,
      effectiveFrom: "2026-09-01",
      effectiveTo: "2026-10-15"
    }, futureWorker)?.mappingId,
    futureMapping.mappingId
  );
});

test("matches controlled provider-report spelling variants without weakening global identity matching", () => {
  assert.equal(providerFirstNamesMatch(
    "Bhuwneshwar Bhardwaj / DROP / 205470133",
    "BHUWANESWAR BHARADWAJ"
  ), true);
  assert.equal(providerFirstNamesMatch("Rithesh Kumar / SPVAN_DROP / 1001", "RITESH KUMAR"), true);
  assert.equal(providerFirstNamesMatch("Asha Devi / DROP / 1002", "ASHA DEVI"), true);
  assert.equal(providerFirstNamesMatch("KUMAR RITHESH / DROP / 1004", "RITHESH KUMAR"), true);
  assert.equal(providerFirstNamesMatch("R Kumar / DROP / 1005", "R KUMAR"), true);
  assert.equal(providerFirstNamesMatch("Thaha mohammad B / SPVAN-DROP / 206139406", "MOHAMMED THAHA"), true);
  assert.equal(providerFirstNamesMatch("Suresh Chandran / DROP / 1011", "CHANDRAN"), true);
  assert.equal(providerFirstNamesMatch("Rajesh Sharma / DROP / 1003", "Ramesh Varma"), false);
  assert.equal(providerFirstNamesMatch("Bhuwneshwar", "Bhuwaneswar"), false);
});

test("rejects provider mappings supported only by an initial or a common name token", () => {
  assert.equal(providerFirstNamesMatch("Thaha mohammed B / SPVAN_DROP / 206139406", "ABDULKADER BASHEER"), false);
  assert.equal(providerFirstNamesMatch("Arun Kumar / DROP / 1006", "RAJESH KUMAR"), false);
  assert.equal(providerFirstNamesMatch("Arun Muhamed / DROP / 1012", "RAJESH MUHAMED"), false);
  assert.equal(providerFirstNamesMatch("Arun Mohammed / DROP / 1013", "RAJESH MOHAMMED"), false);
  assert.equal(providerFirstNamesMatch("Arun Abdul / DROP / 1014", "RAJESH ABDUL"), false);
  assert.equal(providerFirstNamesMatch("Arun Singh / DROP / 1015", "RAJESH SINGH"), false);
  assert.equal(providerFirstNamesMatch("B / DROP / 1007", "BASHEER"), false);
  assert.equal(providerFirstNamesMatch("R Kumar / DROP / 1008", "RITESH KUMAR"), false);
  assert.equal(providerFirstNamesMatch("Mohammed A / DROP / 1009", "MOHAMMED ABDUL"), false);
  assert.equal(providerFirstNamesMatch("M Kumar / DROP / 1010", "MANOJ KUMAR"), false);
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

test("allows an existing mapping to be cleared without selecting another worker", () => {
  assert.equal(providerFirstRowIssue({
    ...row,
    workforceId: "",
    dropxId: "",
    dropxName: "",
    paymentMethodId: "",
    paymentValues: {},
    effectiveFrom: ""
  }, undefined, undefined), null);
  assert.match(providerFirstRowIssue({ ...row, workforceId: "", mappingId: "" }, undefined, undefined), /Select a DropX workforce ID/);
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
  const [component, page, actions, replacementMigration, locationRemapMigration, correctionMigration, multiLocationMigration] = await Promise.all([
    readFile(new URL("../components/provider-first-mapping-worksheet.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/provider-id-mapping/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/provider-mapping/actions.ts", import.meta.url), "utf8"),
    readFile(new URL("../../supabase/migrations/20261005083434_provider_mapping_confirmed_replacement.sql", import.meta.url), "utf8"),
    readFile(new URL("../../supabase/migrations/20261005102002_provider_mapping_location_remap.sql", import.meta.url), "utf8"),
    readFile(new URL("../../supabase/migrations/20261005124958_provider_mapping_drift_and_period_corrections.sql", import.meta.url), "utf8"),
    readFile(new URL("../../supabase/migrations/20261009173118_workforce_provider_mapping_multi_location.sql", import.meta.url), "utf8")
  ]);
  assert.match(component, /paginatedIndexes\.map/);
  assert.match(component, /isScientificProviderMemberId\(row\.providerMemberId\)/);
  assert.match(component, /formData\.set\(`\$\{prefix\}\[provider_member_id\]`, row\.providerMemberId\)/);
  assert.match(component, /Combined minimum \/ \{productionThresholdConfig\.period\}/);
  assert.match(component, /production_threshold_minimum_units/);
  assert.match(component, /mappingId: mappingReference\?\.mappingId \?\? ""/);
  assert.match(component, /Replace existing mapping\?/);
  assert.match(component, /Choose location mapping action/);
  assert.match(component, />Keep all<\/button>/);
  assert.match(component, /\[clear_mapping\]/);
  assert.match(component, /Replace mapping/);
  assert.match(component, /providerFirstLocationRemap/);
  assert.match(component, /Mapped: \$\{worker\.locationLabel\} · Profile:/);
  assert.match(component, /saved\?\.profileStationId/);
  assert.match(page, /mapping\?\.station_id \?\? profileStationId/);
  assert.match(page, /return allowed\(worker\.location_id\)/);
  assert.match(component, /\[replace_mapping_id\]/);
  assert.match(component, /\[replacement_confirmed\]/);
  assert.match(component, /replacement && !confirmedMappingIds\[index\]/);
  assert.doesNotMatch(component, /<form action=\{saveProviderFirstMappingWorksheet\}/);
  const start = actions.indexOf("export async function saveProviderFirstMappingsInline");
  const end = actions.indexOf("/** Links an imported provider member", start);
  const inlineAction = actions.slice(start, end);
  assert.match(inlineAction, /getAuthorization\(\)/);
  assert.match(inlineAction, /canEditProviderMappings\(authorization\)/);
  assert.match(inlineAction, /saveExecutiveMappingRow/);
  assert.match(inlineAction, /providerFirstReplacementState/);
  assert.doesNotMatch(inlineAction, /redirect\(/);
  assert.match(inlineAction, /revalidatePath\("\/payments\/workforce-payouts"\)/);
  assert.match(actions, /isScientificProviderMemberId\(providerMemberId\)/);
  assert.match(actions, /XLSX\.read\(await file\.arrayBuffer\(\), \{ type: "array", raw: true \}\)/);
  assert.match(actions, /identifierRows = XLSX\.utils\.sheet_to_json[\s\S]*raw: true/);
  assert.match(actions, /providerMemberIdUnsafeNumber/);
  assert.match(actions, /memberNameByStationAndId\.get\(`\$\{station\.stationCode\}\|\$\{uploadRow\.providerMemberId\}`\)/);
  assert.match(actions, /providerHolderMatches\(holderName, worker\.fullName\)/);
  assert.match(actions, /providerFirstNamesMatch\(holderName, workerName\)/);
  assert.doesNotMatch(actions, /import \{ matchNames \} from "@\/lib\/name-match"/);
  assert.match(actions, /production_threshold_config: productionThresholdConfig/);
  assert.match(actions, /Changes to an existing monthly combined minimum must start on the first day of a month/);
  assert.match(actions, /const providerId = String\(station\.provider_id/);
  assert.match(actions, /worker's current location is not allocated to your account/);
  assert.match(actions, /currentMappingLocationDriftEdit/);
  assert.match(actions, /profileStationId/);
  assert.match(actions, /workforce_replace_joining_mapping/);
  assert.match(actions, /expectedReplacementId === existingMapping\.id/);
  assert.match(actions, /workforce_active_provider_member_mappings/);
  assert.match(actions, /providerMemberIdentity\(currentMapping\.provider_member_id\)[\s\S]*providerMemberIdentity\(providerMemberId\)/);
  assert.doesNotMatch(actions, /\.eq\("provider_member_id", providerMemberId\)/);
  assert.match(actions, /workforce_keep_joining_mapping/);
  assert.match(actions, /workforce_clear_joining_mapping/);
  assert.match(replacementMigration, /create or replace function public\.workforce_replace_joining_mapping/);
  assert.match(replacementMigration, /p_expected_old_mapping uuid/);
  assert.match(replacementMigration, /old_mapping\.status <> 'active'/);
  assert.match(replacementMigration, /set status = 'cancelled'/);
  assert.match(replacementMigration, /A replacement mapping cannot start in the future/);
  assert.match(replacementMigration, /target\.status <> 'cancelled'/);
  assert.match(replacementMigration, /daterange\(new_start, 'infinity'::date, '\[\]'\)/);
  assert.match(replacementMigration, /perform public\.workforce_save_joining_mapping/);
  assert.match(replacementMigration, /from public, anon, authenticated/);
  assert.match(replacementMigration, /to service_role/);
  assert.match(locationRemapMigration, /create or replace function public\.workforce_rebase_payment_policy_location/);
  assert.match(locationRemapMigration, /is_location_move := old_mapping\.workforce_id = p_workforce/);
  assert.match(locationRemapMigration, /target\.id <> old_mapping\.id/);
  assert.match(locationRemapMigration, /provider_mapping_location_moved/);
  assert.match(locationRemapMigration, /Payment-policy history contains a later location change/);
  assert.match(locationRemapMigration, /from public, anon, authenticated/);
  assert.match(locationRemapMigration, /to service_role/);
  assert.match(correctionMigration, /provider_mapping_start_corrected/);
  assert.match(correctionMigration, /effective_from = m\.effective_from/);
  assert.match(correctionMigration, /Finalized Workforce payroll uses this mapping period/);
  assert.match(correctionMigration, /coalesce\(payroll_item\.status, ''\) <> 'excluded'/);
  assert.match(correctionMigration, /least\(new_start, old_mapping\.effective_from\)/);
  assert.match(correctionMigration, /w\.location_id is distinct from v_old\.station_id/);
  assert.match(correctionMigration, /person\.location_id is distinct from new_station_id/);
  assert.match(correctionMigration, /policy\.station_id is distinct from p_new_station/);
  assert.match(multiLocationMigration, /field_executive_provider_mappings_one_current_member_station_idx/);
  assert.match(multiLocationMigration, /create or replace function public\.workforce_active_provider_member_mappings/);
  assert.match(multiLocationMigration, /upper\(btrim\(mapping\.provider_member_id\)\)[\s\S]*upper\(btrim\(p_provider_member_id\)\)/);
  assert.match(multiLocationMigration, /create or replace function public\.workforce_keep_joining_mapping/);
  assert.match(multiLocationMigration, /create or replace function public\.workforce_clear_joining_mapping/);
  assert.match(multiLocationMigration, /workforce_provider_mapping_person/);
  assert.match(multiLocationMigration, /submitted DropX ID does not match/);
  assert.match(multiLocationMigration, /begin;[\s\S]*commit;/);
});

test("locks provider mappings only across the associate's finalized payout dates", async () => {
  const migration = await readFile(
    new URL("../../supabase/migrations/20261005160446_provider_mapping_finalized_payout_period_guard.sql", import.meta.url),
    "utf8"
  );
  const guardStart = migration.indexOf("create or replace function public.workforce_joining_mapping_guard");
  const guardEnd = migration.indexOf("comment on function public.workforce_joining_mapping_guard", guardStart);
  const guard = migration.slice(guardStart, guardEnd);

  assert.match(guard, /lower\(coalesce\(payroll_run\.status, ''\)\) in \('approved', 'paid'\)/);
  assert.match(guard, /coalesce\(payroll_item\.status, ''\) <> 'excluded'/);
  assert.match(guard, /daterange\(payroll_run\.period_start, payroll_run\.period_end, '\[\]'\)[\s\S]*\* old_range/);
  assert.match(guard, /\* old_range[\s\S]*is distinct from[\s\S]*\* new_range/);
  assert.doesNotMatch(guard, /in \('review', 'approved', 'paid'\)/);
  assert.match(migration, /create trigger field_executive_provider_mappings_01_finalized_payout_guard/);
  assert.match(migration, /create or replace function public\.workforce_provider_mapping_person/);
  assert.match(migration, /workforce\.source_profile_type = 'employee'/);
  assert.doesNotMatch(migration, /daterange\(least\(new_start, old_mapping\.effective_from\)/);
  assert.doesNotMatch(migration, /Finalized Workforce payroll uses this mapping period/);
});

test("multi-location migration enforces one canonical DropX owner across stations", async () => {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create table public.workforce (
      id uuid primary key,
      company_id uuid not null,
      dropx_id text,
      full_name text,
      location_id uuid,
      deleted_at timestamptz,
      migration_state text default 'canonical',
      last_working_date date,
      lifecycle_status text,
      source_profile_type text,
      source_profile_id uuid,
      provider_employee_id text,
      provider_id_status text,
      updated_at timestamptz default now()
    );
    create table public.stations (
      id uuid primary key,
      company_id uuid not null,
      provider_id uuid not null
    );
    create table public.field_executive_provider_mappings (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null,
      workforce_id uuid,
      field_executive_id uuid,
      employee_id uuid,
      contractor_id uuid,
      provider_id uuid,
      station_id uuid,
      provider_member_id text,
      effective_from date not null,
      effective_to date,
      payment_method_id uuid,
      payment_values jsonb default '{}'::jsonb,
      production_threshold_config jsonb,
      pay_type text,
      status text not null default 'active',
      created_by uuid,
      created_at timestamptz default now(),
      updated_at timestamptz default now()
    );
    create unique index field_executive_provider_mappings_one_current_member_idx
      on public.field_executive_provider_mappings(company_id, provider_id, upper(btrim(provider_member_id)))
      where effective_to is null and status = 'active';
    create table public.workforce_joining_events (
      company_id uuid,
      workforce_id uuid,
      event_code text,
      actor_id uuid,
      actor_name text,
      details jsonb
    );
    create function public.workforce_provider_mapping_person(uuid, uuid, uuid, uuid, uuid)
    returns uuid language sql immutable as $$ select coalesce($2, $3, $4, $5) $$;
  `);
  const migration = await readFile(new URL("../../supabase/migrations/20261009173118_workforce_provider_mapping_multi_location.sql", import.meta.url), "utf8");
  await db.exec(migration);

  const company = "10000000-0000-4000-8000-000000000001";
  const provider = "10000000-0000-4000-8000-000000000002";
  const workerA = "10000000-0000-4000-8000-000000000003";
  const workerB = "10000000-0000-4000-8000-000000000004";
  const stationA = "10000000-0000-4000-8000-000000000005";
  const stationB = "10000000-0000-4000-8000-000000000006";
  const mappingA = "10000000-0000-4000-8000-000000000007";
  const mappingB = "10000000-0000-4000-8000-000000000008";
  await db.exec(`
    insert into public.workforce(id,company_id,dropx_id,location_id) values
      ('${workerA}','${company}','DX-A','${stationA}'),
      ('${workerB}','${company}','DX-B','${stationB}');
    insert into public.stations(id,company_id,provider_id) values
      ('${stationA}','${company}','${provider}'),
      ('${stationB}','${company}','${provider}');
    insert into public.field_executive_provider_mappings(
      id,company_id,workforce_id,provider_id,station_id,provider_member_id,effective_from
    ) values ('${mappingA}','${company}','${workerA}','${provider}','${stationA}','  MeMbEr-1  ','2026-09-01');
  `);
  const normalizedLookup = await db.query(`
    select id, provider_member_id
    from public.workforce_active_provider_member_mappings(
      '${company}', '${provider}', ' member-1 '
    )
  `);
  assert.equal(normalizedLookup.rows.length, 1);
  assert.equal(normalizedLookup.rows[0].id, mappingA);
  assert.equal(normalizedLookup.rows[0].provider_member_id, "  MeMbEr-1  ");
  await assert.rejects(db.exec(`
    insert into public.field_executive_provider_mappings(
      id,company_id,workforce_id,provider_id,station_id,provider_member_id,effective_from
    ) values ('${mappingB}','${company}','${workerB}','${provider}','${stationB}','member-1','2026-09-01');
  `), /same DropX ID/);
  const kept = await db.query(`
    select public.workforce_keep_joining_mapping(
      '${company}',
      '${workerA}',
      '${workerA}',
      '${mappingA}',
      'DX-A',
      jsonb_build_object(
        'status', 'active',
        'provider_id', '${provider}',
        'station_id', '${stationB}',
        'provider_member_id', ' member-1 ',
        'effective_from', '2026-09-01',
        'payment_method_id', '${provider}',
        'payment_values', jsonb_build_object('DELIVERY', 10)
      ),
      null,
      'Test reviewer'
    ) as id
  `);
  const keptMappingId = kept.rows[0].id;
  const result = await db.query(`select count(*)::int as count from public.field_executive_provider_mappings where status='active'`);
  assert.equal(result.rows[0].count, 2);
  const keptIdentity = await db.query(`
    select provider_member_id
    from public.field_executive_provider_mappings
    where id = '${keptMappingId}'
  `);
  assert.equal(keptIdentity.rows[0].provider_member_id, "member-1");
  await db.query(`select public.workforce_clear_joining_mapping(
    '${company}', '${workerA}', '${workerA}', '${keptMappingId}', null, 'Test reviewer'
  )`);
  const afterClear = await db.query(`select count(*)::int as count from public.field_executive_provider_mappings where status='active'`);
  assert.equal(afterClear.rows[0].count, 1);
  await db.close();
});
