import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync(
  new URL("../supabase/migrations/20261002070249_custom_production_payment_field.sql", import.meta.url),
  "utf8"
);
const formSource = readFileSync(new URL("../src/components/payment-field-form.tsx", import.meta.url), "utf8");
const actionSource = readFileSync(new URL("../src/app/master/payment-methods/actions.ts", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("../src/app/master/payment-methods/page.tsx", import.meta.url), "utf8");

assert.match(formSource, /name="is_custom_production"/);
assert.match(formSource, /disabled=\{customProduction\}/);
assert.match(formSource, /Provider\/model production counts are not required\./);
assert.match(actionSource, /is_custom_production:\s*isCustomProduction/);
assert.match(actionSource, /saveProviderMetricSelections\([^)]*payload\.is_custom_production\)/);
assert.match(actionSource, /if \(isCustomProduction\) return;/);
assert.match(pageSource, /provider_calculation_sources, is_custom_production, is_active/);
assert.doesNotMatch(actionSource, /if \(isCustomProduction\)[\s\S]{0,300}payment_field_provider_metrics[\s\S]{0,100}delete/);

const db = new PGlite();

await db.exec(`
  create schema if not exists public;
  create table public.payment_fields (
    id uuid primary key,
    field_type text not null,
    calculation_type text not null
  );
  ${migration.replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "")}
`);

await db.query(`
  insert into public.payment_fields (id, field_type, calculation_type)
  values
    ('00000000-0000-4000-8000-000000000001', 'amount', 'fixed_monthly'),
    ('00000000-0000-4000-8000-000000000002', 'production', 'count_x_rate')
`);

const defaults = await db.query(`
  select id::text, is_custom_production
  from public.payment_fields
  order by id
`);
assert.deepEqual(defaults.rows.map((row) => row.is_custom_production), [false, false]);

await db.query(`
  update public.payment_fields
  set is_custom_production = true
  where id = '00000000-0000-4000-8000-000000000002'
`);

await assert.rejects(
  db.query(`
    update public.payment_fields
    set is_custom_production = true
    where id = '00000000-0000-4000-8000-000000000001'
  `),
  /payment_fields_custom_production_type_check/
);

await assert.rejects(
  db.query(`
    update public.payment_fields
    set calculation_type = 'manual_input'
    where id = '00000000-0000-4000-8000-000000000002'
  `),
  /payment_fields_custom_production_type_check/
);

console.log("Custom production payment-field schema verification passed.");
