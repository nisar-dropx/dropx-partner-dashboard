import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../people/category/[code]/page.tsx", import.meta.url), "utf8");
const panel = readFileSync(new URL("../../components/helper-bulk-upload.tsx", import.meta.url), "utf8");
const action = readFileSync(new URL("../field-executive/actions.ts", import.meta.url), "utf8");

test("Helpers page exposes a permission-gated, Helper-routed bulk upload", () => {
  assert.match(page, /code === "helpers"/);
  assert.match(page, /hasPermission\(authorization, pageCode, "add"\)/);
  assert.match(page, /<HelperBulkUpload \/>/);
  assert.match(panel, /name="return_path" type="hidden" value="\/helpers"/);
  assert.match(panel, /kind=helper/);
});

test("Helper import uses active lifecycle, Helper ID series, bank fields, and worker biometric cleanup", () => {
  assert.match(action, /peopleBulkImportLifecycle\(config\.profileType\)/);
  assert.match(action, /table === "helpers" \? "helpers" : config\.category/);
  assert.match(action, /bank_account_no: row\.bankAccountNo/);
  assert.match(action, /ifsc_code: row\.ifscCode/);
  assert.match(action, /\.eq\("profile_type", config\.profileType\)\.in\("account_id", insertedIds\)/);
});
