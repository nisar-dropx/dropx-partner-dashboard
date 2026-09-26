import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

test("dashboard verification is scoped to the operator location and designation", () => {
  assert.match(route, /location_id, designation_id, employee_code/);
  assert.match(route, /location_id, \$\{designationField\}, dropx_id/);
  assert.match(route, /!isCompanyOwner\(authorization\) && !authorization\.hasAllLocationAccess/);
  assert.match(route, /authorization\.locationScopeIds\.includes\(locationId\)/);
  assert.match(route, /const designationField = \["employee", "workforce", "field_executive"\]\.includes\(profileType\)/);
  assert.match(route, /from\("designations"\)[\s\S]*?\.select\("id, name, portal_permissions"\)/);
  assert.match(route, /canAccessDesignationPortal\(designation, "dashboard", "edit", \{ isOwner: isCompanyOwner\(authorization\) \}\)/);
});

test("provider results are persisted by the server before they are returned", () => {
  assert.match(route, /async function persistResult\(result: Record<string, unknown>\)/);
  assert.match(route, /await saveProfileVerification\(\{/);
  assert.match(route, /accountId,[\s\S]*?companyId: account\.companyId,[\s\S]*?kind,[\s\S]*?profileType:/);
  assert.match(route, /result: \{ \.\.\.result, registeredName \}/);
  assert.equal((route.match(/return await persistResult\(result\);/g) ?? []).length, 6);
});
