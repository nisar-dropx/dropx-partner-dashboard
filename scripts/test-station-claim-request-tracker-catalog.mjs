import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const seed = readFileSync(
  new URL("../supabase/migrations/20260928123000_dashboard_request_tracker.sql", import.meta.url),
  "utf8"
).replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");
const migration = readFileSync(
  new URL("../supabase/migrations/20261021141000_station_claim_request_tracker_catalog.sql", import.meta.url),
  "utf8"
);

const db = new PGlite();
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;
  create schema auth;
  create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
  ${seed}
`);
await db.exec(migration);
await db.exec(migration);

const row = (await db.query(`
  select kind, portal, source_table, aliases, history
  from request_tracker_sources where kind = 'loss'
`)).rows[0];
assert.equal(row.portal, "Ops");
assert.equal(row.source_table, "ops_station_loss_claims");
assert.deepEqual(row.aliases, ["reference"]);
assert.equal(row.history[0].table, "ops_station_loss_claim_events");
console.log("station claim request-tracker catalog migration ok");
