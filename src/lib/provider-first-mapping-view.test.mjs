import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  filterProviderFirstRowIndexes,
  providerFirstPageWindow,
  providerFirstValidationStatus,
  providerMemberKey
} from "./provider-first-mapping-view.ts";

const method = { id: "method-1", components: [{ code: "DELIVERY", label: "Delivery rate" }] };
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
  effectiveFrom: "2026-09-01",
  effectiveTo: ""
};

test("keys provider members by station and normalized member ID", () => {
  assert.equal(providerMemberKey("station-1", " abc "), "station-1|ABC");
  assert.notEqual(providerMemberKey("station-1", "ABC"), providerMemberKey("station-2", "ABC"));
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
  assert.doesNotMatch(component, /<form action=\{saveProviderFirstMappingWorksheet\}/);
  const start = actions.indexOf("export async function saveProviderFirstMappingsInline");
  const end = actions.indexOf("/** Links an imported provider member", start);
  const inlineAction = actions.slice(start, end);
  assert.match(inlineAction, /getAuthorization\(\)/);
  assert.match(inlineAction, /hasPermission\(authorization, "provider_mapping", "edit"\)/);
  assert.match(inlineAction, /saveExecutiveMappingRow/);
  assert.doesNotMatch(inlineAction, /redirect\(|revalidatePath\(/);
});
