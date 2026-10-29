import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const migration = readFileSync("supabase/migrations/20261029213000_vendor_service_lifecycle.sql", "utf8");
const company = "11111111-1111-1111-1111-111111111111";

try {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create table companies(id uuid primary key);
    create table profiles(id uuid primary key);
    create table stations(id uuid primary key);
    create table payment_heads(id uuid primary key);
    create table payment_contacts(id uuid primary key);
    create table payment_requests(id uuid primary key);
    create table vendors(id uuid primary key default gen_random_uuid());
    create table fleet_vehicles(id uuid primary key default gen_random_uuid(), company_id uuid);
    insert into companies values ('${company}');
  `);
  await db.exec(migration);
  await db.exec(migration);

  const categories = await db.query("select code,operating_model,allowed_payout_months from vendor_service_categories order by sort_order");
  assert.deepEqual(categories.rows.map(row => row.code), ["VAN_VENDOR", "SECURITY_GUARD", "HOUSEKEEPING", "PEST_CONTROL"]);
  assert.equal(categories.rows[0].operating_model, "fleet_attendance");
  assert.deepEqual(categories.rows[1].allowed_payout_months, [1, 3, 6, 12]);
  assert.equal(Number((await db.query("select count(*) n from information_schema.columns where table_name='vendors' and column_name='deleted_at'")).rows[0].n), 1);
  assert.equal(Number((await db.query("select count(*) n from information_schema.columns where table_name='fleet_vehicles' and column_name='vendor_id'")).rows[0].n), 1);
  assert.equal(Number((await db.query("select count(*) n from pg_policies where tablename in ('vendor_service_categories','vendor_service_contracts','vendor_billing_cycles','vendor_lifecycle_events')")).rows[0].n), 4);
  assert.equal(Number((await db.query("select count(*) n from information_schema.role_table_grants where table_name in ('vendor_service_categories','vendor_service_contracts','vendor_billing_cycles','vendor_lifecycle_events') and grantee in ('anon','authenticated')")).rows[0].n), 0);
  console.log("PASS: vendor lifecycle schema is repeatable, private and seeded from master data.");
} finally {
  await db.close();
}
