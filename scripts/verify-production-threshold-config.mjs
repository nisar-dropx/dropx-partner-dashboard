import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync(
  new URL("../supabase/migrations/20261005031907_combined_production_threshold_config.sql", import.meta.url),
  "utf8"
).replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");
const formSource = readFileSync(new URL("../src/components/payment-method-form.tsx", import.meta.url), "utf8");
const actionSource = readFileSync(new URL("../src/app/master/payment-methods/actions.ts", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("../src/app/master/payment-methods/page.tsx", import.meta.url), "utf8");

assert.match(formSource, /name="production_threshold_enabled"/);
assert.match(formSource, /name="production_threshold_period"/);
assert.match(formSource, /name="production_threshold_component_codes"/);
assert.match(formSource, /minimum unit count is entered separately for each person in ID Mapping/i);
assert.match(actionSource, /buildProductionThresholdConfig/);
assert.match(actionSource, /production_threshold_config:\s*productionThresholdConfig/g);
assert.match(pageSource, /production_threshold_config/);

const db = new PGlite();
await db.exec(`
  create schema if not exists public;
  create table public.payment_methods (
    id uuid primary key,
    code text not null
  );
  ${migration}
`);

await db.query(`
  insert into public.payment_methods (id, code, production_threshold_config)
  values
    ('00000000-0000-4000-8000-000000000001', 'STANDARD', null),
    ('00000000-0000-4000-8000-000000000002', 'DAILY', '{"period":"day","component_codes":["DELIVERY","CUSTOMER_RETURN"]}'::jsonb),
    ('00000000-0000-4000-8000-000000000003', 'MONTHLY', '{"period":"month","component_codes":["DELIVERY"]}'::jsonb)
`);

for (const invalidConfig of [
  '{"period":"week","component_codes":["DELIVERY"]}',
  '{"period":"month","component_codes":[]}',
  '{"period":"month","component_codes":[1]}',
  '{"period":"month"}',
  '["DELIVERY"]'
]) {
  await assert.rejects(
    db.query(`
      insert into public.payment_methods (id, code, production_threshold_config)
      values (gen_random_uuid(), 'INVALID', $1::jsonb)
    `, [invalidConfig]),
    /payment_methods_production_threshold_config_check/
  );
}

const stored = await db.query(`
  select code, production_threshold_config
  from public.payment_methods
  order by code
`);
assert.deepEqual(stored.rows.map((row) => row.code), ["DAILY", "MONTHLY", "STANDARD"]);

console.log("Combined production threshold configuration verification passed.");
