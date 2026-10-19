import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migrationUrl = new URL("../supabase/migrations/20261019101000_replace_flipkart_production_cycle.sql", import.meta.url);
const companyId = "00000000-0000-0000-0000-000000000010";
const batchId = "00000000-0000-0000-0000-000000000020";

const db = new PGlite();
try {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create table providers(id uuid primary key, company_id uuid not null, code text, name text);
    create table stations(id uuid primary key, company_id uuid not null, provider_id uuid, station_code text, is_active boolean);
    create table report_import_batches(id uuid primary key, company_id uuid not null, source_type text not null);
    create table cps_shipment_daily(
      id uuid primary key default gen_random_uuid(), company_id uuid not null, source_batch_id uuid,
      client text not null default 'Amazon', work_date date not null, station_code text not null,
      provider_employee_id text not null, provider_employee_name text, shipment_type text,
      amazon_delivery numeric not null default 0, swa_delivery numeric not null default 0,
      c_return numeric not null default 0, mfn numeric not null default 0, mfn_return numeric not null default 0,
      total_delivery numeric not null default 0, total_activity numeric not null default 0,
      pay_type text, del_rate numeric not null default 0, c_return_rate numeric not null default 0,
      mfn_rate numeric not null default 0, mfn_return_rate numeric not null default 0,
      mg_salary numeric not null default 0, fuel_rate numeric not null default 0,
      variable_pay numeric not null default 0, mg_pay numeric not null default 0,
      fuel_pay numeric not null default 0, da_total_pay numeric not null default 0,
      assigned_count numeric not null default 0, raw_row_count integer not null default 0,
      mapping_status text not null default 'Unmapped', mapped_at timestamptz,
      updated_at timestamptz not null default now()
    );
    create table cps_fuel_daily(company_id uuid not null, transaction_date date not null, station_code text, amount numeric not null default 0);
    create table cps_cashbook_daily(company_id uuid not null, expense_date date not null, station_code text not null, cps_head text not null, amount numeric not null default 0);
    create table cps_station_targets(company_id uuid not null, station_code text not null, target_cps numeric not null default 0, effective_from date not null, is_active boolean not null default true);
    create table cps_cost_breakup_daily(
      company_id uuid not null, work_date date not null, station_code text not null,
      head text not null, sub_head text not null, source text not null,
      amount numeric not null default 0, count numeric not null default 0,
      cps numeric not null default 0, notes text
    );
    create table cps_station_daily(
      company_id uuid not null, work_date date not null, station_code text not null,
      total_delivery numeric not null default 0, total_activity numeric not null default 0,
      c_return numeric not null default 0, mfn numeric not null default 0, mfn_return numeric not null default 0,
      da_pay_cost numeric not null default 0, staff_cost numeric not null default 0,
      utr_cost numeric not null default 0, fuel_cost numeric not null default 0,
      vehicle_cost numeric not null default 0, van_cost numeric not null default 0,
      rent_cost numeric not null default 0, other_cost numeric not null default 0,
      total_cost numeric not null default 0, da_cps numeric not null default 0,
      staff_cps numeric not null default 0, fuel_cps numeric not null default 0,
      other_cps numeric not null default 0, overall_cps numeric not null default 0,
      target_cps numeric not null default 0, target_gap numeric not null default 0,
      target_impact numeric not null default 0, calculated_at timestamptz not null default now(),
      updated_at timestamptz not null default now(), unique(company_id,work_date,station_code)
    );
    insert into providers values
      ('00000000-0000-0000-0000-000000000030', '${companyId}', 'FLIPKART', 'Flipkart'),
      ('00000000-0000-0000-0000-000000000031', '${companyId}', 'AMAZON', 'Amazon');
    insert into stations values
      ('00000000-0000-0000-0000-000000000040', '${companyId}', '00000000-0000-0000-0000-000000000030', 'CHM', true),
      ('00000000-0000-0000-0000-000000000042', '${companyId}', '00000000-0000-0000-0000-000000000030', 'OLD', false),
      ('00000000-0000-0000-0000-000000000041', '${companyId}', '00000000-0000-0000-0000-000000000031', 'AMZ', true);
    insert into report_import_batches values ('${batchId}', '${companyId}', 'flipkart_production');
    insert into cps_shipment_daily(company_id, source_batch_id, client, work_date, station_code, provider_employee_id, total_delivery, total_activity)
    values
      ('${companyId}', '${batchId}', 'Flipkart', '2026-09-17', 'CHM', 'OLD', 3, 3),
      ('${companyId}', '${batchId}', 'Flipkart', '2026-09-01', 'CHM', 'FIRST-CYCLE', 4, 4),
      ('${companyId}', '${batchId}', 'Amazon', '2026-09-17', 'CHM', 'AMAZON-ID', 5, 5);
  `);

  const migration = await readFile(migrationUrl, "utf8");
  await db.exec(migration);
  await db.exec(migration);

  const payload = JSON.stringify([
    {
      work_date: "2026-09-17", station_code: "CHM", provider_employee_id: "FK-1",
      provider_employee_name: "One", shipment_type: "BP_RUNSHEET", assigned_count: 8,
      total_delivery: 7, c_return: 0, total_activity: 7, raw_row_count: 2,
      del_rate: 10, variable_pay: 70, da_total_pay: 70, mapping_status: "Mapped",
      mapped_at: "2026-10-19T10:00:00.000Z"
    },
    {
      work_date: "2026-09-18", station_code: "CHM", provider_employee_id: "FK-1",
      provider_employee_name: "One", shipment_type: "BP_PICKUPSHEET", assigned_count: 3,
      total_delivery: 0, c_return: 2, total_activity: 2, raw_row_count: 1
    }
  ]);
  const replaced = await db.query(
    "select replace_flipkart_production_cycle($1,$2,'2026-09-16','2026-09-30',array['CHM']::text[],$3::jsonb) as count",
    [companyId, batchId, payload]
  );
  assert.equal(replaced.rows[0].count, 2);

  const rows = (await db.query("select client, work_date::text, station_code, provider_employee_id, total_delivery::text, c_return::text, da_total_pay::text, mapping_status from cps_shipment_daily order by client, work_date, provider_employee_id")).rows;
  assert.deepEqual(rows, [
    { client: "Amazon", work_date: "2026-09-17", station_code: "CHM", provider_employee_id: "AMAZON-ID", total_delivery: "5", c_return: "0", da_total_pay: "0", mapping_status: "Unmapped" },
    { client: "Flipkart", work_date: "2026-09-01", station_code: "CHM", provider_employee_id: "FIRST-CYCLE", total_delivery: "4", c_return: "0", da_total_pay: "0", mapping_status: "Unmapped" },
    { client: "Flipkart", work_date: "2026-09-17", station_code: "CHM", provider_employee_id: "FK-1", total_delivery: "7", c_return: "0", da_total_pay: "70", mapping_status: "Mapped" },
    { client: "Flipkart", work_date: "2026-09-18", station_code: "CHM", provider_employee_id: "FK-1", total_delivery: "0", c_return: "2", da_total_pay: "0", mapping_status: "Unmapped" }
  ]);
  const cps = (await db.query("select work_date::text, total_delivery::text, c_return::text, da_pay_cost::text, overall_cps::text from cps_station_daily where station_code='CHM' and work_date in ('2026-09-17','2026-09-18') order by work_date")).rows;
  assert.deepEqual(cps, [
    { work_date: "2026-09-17", total_delivery: "12", c_return: "0", da_pay_cost: "70", overall_cps: "5.8333333333333333" },
    { work_date: "2026-09-18", total_delivery: "0", c_return: "2", da_pay_cost: "0", overall_cps: "0" }
  ]);

  const historicalPayload = JSON.stringify([{
    work_date: "2026-09-19", station_code: "OLD", provider_employee_id: "FK-HIST",
    provider_employee_name: "Historical", shipment_type: "BP_RUNSHEET", assigned_count: 1,
    total_delivery: 1, c_return: 0, total_activity: 1, raw_row_count: 1
  }]);
  const historical = await db.query(
    "select replace_flipkart_production_cycle($1,$2,'2026-09-16','2026-09-30',array['OLD']::text[],$3::jsonb) as count",
    [companyId, batchId, historicalPayload]
  );
  assert.equal(historical.rows[0].count, 1, "Historical imports may replace an inactive Flipkart station");

  await assert.rejects(
    db.query("select replace_flipkart_production_cycle($1,$2,'2026-09-16','2026-09-29',array['CHM']::text[],$3::jsonb)", [companyId, batchId, payload]),
    /cycle end/i
  );
  await assert.rejects(
    db.query("select replace_flipkart_production_cycle($1,$2,'2026-09-16','2026-09-30',array['AMZ']::text[],$3::jsonb)", [companyId, batchId, payload]),
    /not a permitted current or historical Flipkart location/i
  );
  await assert.rejects(
    db.query("select replace_flipkart_production_cycle($1,$2,'2026-09-16','2026-09-30',array['CHM']::text[],null::jsonb)", [companyId, batchId]),
    /contains no production rows/i
  );

  const grants = (await db.query("select has_function_privilege('anon','replace_flipkart_production_cycle(uuid,uuid,date,date,text[],jsonb)','EXECUTE') as anon, has_function_privilege('authenticated','replace_flipkart_production_cycle(uuid,uuid,date,date,text[],jsonb)','EXECUTE') as authenticated, has_function_privilege('service_role','replace_flipkart_production_cycle(uuid,uuid,date,date,text[],jsonb)','EXECUTE') as service")).rows[0];
  assert.deepEqual(grants, { anon: false, authenticated: false, service: true });
} finally {
  await db.close();
}

console.log("Flipkart cycle replacement RPC verification passed.");
