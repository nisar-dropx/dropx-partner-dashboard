import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL("../supabase/migrations/20261028170000_provider_mapping_summary_access.sql", import.meta.url), "utf8");

test("mapping summary creates independent Dashboard and Ops permissions", () => {
  assert.match(migration, /'provider_mapping_summary'/);
  assert.match(migration, /'ops_provider_mapping_summary'/);
  assert.match(migration, /role\.code = 'OWNER'/);
  assert.doesNotMatch(migration, /source_page|src\.can_view|code\s*=\s*'ops_provider_mapping'/);
});
