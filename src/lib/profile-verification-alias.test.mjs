import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  preferredProfileVerificationRows,
  verificationProfileTypeAliases
} from "./profile-verification-alias.ts";

test("workforce verification reads include the legacy field executive alias in both directions", () => {
  assert.deepEqual(verificationProfileTypeAliases("workforce"), ["workforce", "field_executive"]);
  assert.deepEqual(verificationProfileTypeAliases("field_executive"), ["workforce", "field_executive"]);
  assert.deepEqual(verificationProfileTypeAliases("employee"), ["employee"]);
});

test("verification aliases choose the newest row per kind and canonical workforce on a tie", () => {
  const rows = preferredProfileVerificationRows([
    { kind: "pan", profile_type: "workforce", input_key: "OLD", updated_at: "2026-10-01T00:00:00Z" },
    { kind: "pan", profile_type: "field_executive", input_key: "NEW", updated_at: "2026-10-02T00:00:00Z" },
    { kind: "dl", profile_type: "field_executive", input_key: "LEGACY", updated_at: "2026-10-03T00:00:00Z" },
    { kind: "dl", profile_type: "workforce", input_key: "CANONICAL", updated_at: "2026-10-03T00:00:00Z" },
    { kind: "bank", profile_type: "workforce", input_key: "BANK", updated_at: "2026-10-04T00:00:00Z" }
  ]);

  assert.deepEqual(rows.map((row) => [row.kind, row.input_key]), [
    ["bank", "BANK"],
    ["dl", "CANONICAL"],
    ["pan", "NEW"]
  ]);
});

test("both Connect verification GET routes retain company/account scope while reading aliases", () => {
  for (const path of [
    "../app/api/connect/verification/route.ts",
    "../../apps/connect/app/api/connect/verification/route.ts"
  ]) {
    const route = fs.readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(route, /\.eq\("company_id", account\.companyId\)/);
    assert.match(route, /\.in\("profile_type", verificationProfileTypeAliases\(/);
    assert.match(route, /\.eq\("account_id", account(?:Id|\.id)\)/);
    assert.match(route, /preferredProfileVerificationRows\(result\.data \?\? \[\]\)/);
  }
});
