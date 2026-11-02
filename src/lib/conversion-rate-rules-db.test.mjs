import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
test("migration is repeatable, rules are future-only and immutable, scopes and overlaps are enforced", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table cps_shipment_daily(total_delivery numeric, delivery_assigned_count numeric, future_completed_count numeric, future_base_count numeric, provider_employee_id text);
      create table companies(id uuid primary key);
      create table providers(id uuid primary key, company_id uuid, is_active boolean);
      create table location_models(id uuid primary key, company_id uuid, provider_id uuid, is_active boolean);
      create table stations(id uuid primary key, company_id uuid, provider_id uuid, location_model_id uuid);
      create table payment_methods(id uuid primary key, company_id uuid, is_active boolean);
      create table payment_fields(id uuid primary key, company_id uuid, field_type text, is_active boolean);
      create table payment_method_components(company_id uuid, payment_method_id uuid, payment_field_id uuid, is_active boolean);
      insert into companies values ('${id(1)}'), ('${id(9)}');
      insert into providers values ('${id(2)}','${id(1)}',true);
      insert into location_models values ('${id(3)}','${id(1)}','${id(2)}',true);
      insert into stations values ('${id(4)}','${id(1)}','${id(2)}','${id(3)}');
      insert into payment_methods values ('${id(5)}','${id(1)}',true);
      insert into payment_fields values ('${id(6)}','${id(1)}','production',true), ('${id(7)}','${id(1)}','amount',true);
      insert into payment_method_components values ('${id(1)}','${id(5)}','${id(6)}',true), ('${id(1)}','${id(5)}','${id(7)}',true);
    `);
    const sql = await readFile(new URL("../../supabase/migrations/20261102064011_conversion_rate_rules.sql", import.meta.url), "utf8");
    await db.exec(sql); await db.exec(sql);
    const insert = (changes = {}) => {
      const row = { company: id(1), method: id(5), field: id(6), provider: id(2), model: id(3), station: id(4), from: "2099-01-01", to: "2099-01-31", tiers: [{ minimum: 0, rate: 12 }, { minimum: 80, rate: 14 }], ...changes };
      return db.query(`insert into payment_conversion_rate_rules(company_id,name,payment_method_id,payment_field_id,provider_id,location_model_id,station_id,effective_from,effective_to,tiers,numerator_source,denominator_source) values ($1,'Rule',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [row.company, row.method, row.field, row.provider, row.model, row.station, row.from, row.to, JSON.stringify(row.tiers), row.numerator ?? "total_delivery", row.denominator ?? "delivery_assigned_count"]);
    };
    await insert();
    const combinationMigration = await readFile(new URL("../../supabase/migrations/20261102095731_conversion_metric_combinations.sql", import.meta.url), "utf8");
    await db.exec(combinationMigration); await db.exec(combinationMigration);
    assert.equal((await db.query("select numerator_source from payment_conversion_rate_rules")).rows[0].numerator_source, "total_delivery");
    await assert.rejects(insert({ from: "2099-01-31", to: "2099-02-02" }), /already covers/);
    await insert({ from: "2099-02-01", to: "2099-02-28", numerator: "future_completed_count", denominator: "future_base_count" });
    await insert({ from: "2099-03-01", to: "2099-03-31", numerator: "total_delivery+future_completed_count", denominator: "delivery_assigned_count+future_base_count" });
    for (const numerator of ["total_delivery+total_delivery", "total_delivery+provider_employee_id", "total_delivery++future_completed_count", "total_delivery+nonexistent", "total_delivery;drop"]) {
      await assert.rejects(insert({ from: "2099-04-01", to: "2099-04-30", numerator }), /distinct valid numeric|check constraint/);
    }
    await assert.rejects(insert({ numerator: "provider_employee_id" }), /numeric production inputs/);
    await assert.rejects(insert({ denominator: "nonexistent" }), /numeric production inputs/);
    assert.ok((await db.query("select * from payment_conversion_metric_options()")).rows.some(row => row.source_key === "future_base_count"));
    await assert.rejects(insert({ from: "2000-01-01", to: "2000-01-31" }), /after today/);
    await assert.rejects(insert({ field: id(7) }), /production field/);
    await assert.rejects(insert({ company: id(9) }), /company/);
    await assert.rejects(insert({ model: id(8) }), /scope/);
    for (const tiers of [[{ minimum: 10, rate: 12 }], [{ minimum: 0, rate: -1 }], [{ minimum: 0, rate: 12 }, { minimum: 0, rate: 14 }], [{ minimum: 0 }]]) await assert.rejects(insert({ tiers }), /slab|Slab/);
    await assert.rejects(db.exec("update payment_conversion_rate_rules set name='Changed'"), /immutable/);
    await assert.rejects(db.exec("delete from payment_conversion_rate_rules"), /immutable/);
    assert.equal((await db.query("select count(*)::int as count from payment_conversion_rate_rules")).rows[0].count, 3);
    assert.equal((await db.query("select relrowsecurity from pg_class where oid='payment_conversion_rate_rules'::regclass")).rows[0].relrowsecurity, true);
    assert.equal((await db.query("select has_table_privilege('anon','payment_conversion_rate_rules','select') as allowed")).rows[0].allowed, false);
    assert.equal((await db.query("select has_table_privilege('service_role','payment_conversion_rate_rules','update') as allowed")).rows[0].allowed, false);
  } finally { await db.close(); }
});
