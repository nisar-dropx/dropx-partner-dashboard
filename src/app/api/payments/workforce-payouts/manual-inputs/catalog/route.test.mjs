import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

test("manual input catalog requires payout edit permission on the active access surface", () => {
  assert.match(source, /currentAdminAccessSurface\(\) === "ops" \? "ops_workforce_payouts" : "workforce_payouts"/);
  assert.match(source, /hasPermission\(authorization, payoutPageCode\(\), "edit"\)/);
  assert.match(source, /requireCompanyId\(authorization\)/);
  assert.match(source, /Cache-Control": "private, no-store"/);
});

test("manual input catalog returns every supported type but excludes system deductions", () => {
  assert.match(source, /code: "WORK_HOURS"[\s\S]*?inputType: "ATTENDANCE"/);
  assert.match(source, /code: "WORK_DAYS"[\s\S]*?inputType: "ATTENDANCE"/);
  assert.match(source, /inputType: "PAYMENT_FIELD_VALUE"/);
  assert.match(source, /inputType: "PRODUCTION_UNITS"/);
  assert.match(source, /inputType: "ADDITIONAL_PAYMENT"/);
  assert.match(source, /inputType: "DEDUCTION"/);
  assert.match(source, /\.eq\("calculation_type", "manual"\)/);
  assert.match(source, /\.eq\("is_system", false\)/);
  assert.match(source, /\.neq\("code", "ADVANCE"\)/);
});

test("manual input catalog respects the caller's location scope", () => {
  assert.match(source, /authorization\.hasAllLocationAccess \|\| isCompanyOwner\(authorization\)/);
  assert.match(source, /new Set\(authorization\.locationScopeIds\)/);
  assert.match(source, /allLocations \|\| allowedLocationIds\.has\(String\(station\.id\)\)/);
});
