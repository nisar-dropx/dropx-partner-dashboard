import assert from "node:assert/strict";
import test from "node:test";

import {
  contractorRegisterViewFrom,
  filterContractorRegisterRows
} from "./contractor-register-visibility.ts";

const rows = [
  { id: "active-contractor", is_active: true },
  { id: "inactive-contractor", is_active: false },
  { id: "inactive-workforce-shadow", is_active: false },
  { id: "unexpected-active-shadow", is_active: true }
];
const compatibilityIds = new Set(["inactive-workforce-shadow", "unexpected-active-shadow"]);

test("defaults the operational contractor register to active records", () => {
  assert.equal(contractorRegisterViewFrom(undefined), "active");
  assert.equal(contractorRegisterViewFrom("unexpected"), "active");
});

test("shows active independent contractors without Workforce compatibility shadows", () => {
  assert.deepEqual(
    filterContractorRegisterRows(rows, compatibilityIds, "active").map((row) => row.id),
    ["active-contractor"]
  );
});

test("keeps genuine inactive contractors separate from compatibility shadows", () => {
  assert.deepEqual(
    filterContractorRegisterRows(rows, compatibilityIds, "inactive").map((row) => row.id),
    ["inactive-contractor"]
  );
});

test("retains linked legacy rows in a dedicated compatibility view", () => {
  assert.deepEqual(
    filterContractorRegisterRows(rows, compatibilityIds, "compatibility").map((row) => row.id),
    ["inactive-workforce-shadow", "unexpected-active-shadow"]
  );
});
