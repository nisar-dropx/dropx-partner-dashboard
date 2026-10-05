import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migration = await readFile(
  new URL("../supabase/migrations/20261005032215_mapping_combined_production_threshold_snapshot.sql", import.meta.url),
  "utf8"
);

const db = new PGlite();
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;

  create table public.workforce (
    id uuid primary key,
    company_id uuid not null,
    dropx_id text,
    location_id uuid,
    deleted_at timestamptz,
    migration_state text not null default 'canonical',
    updated_at timestamptz
  );

  create table public.stations (
    id uuid primary key,
    company_id uuid not null,
    provider_id uuid
  );

  create table public.field_executive_provider_mappings (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null,
    workforce_id uuid,
    provider_id uuid,
    station_id uuid,
    provider_member_id text,
    effective_from date,
    effective_to date,
    payment_method_id uuid,
    payment_values jsonb,
    pay_type text,
    delivery_rate numeric,
    pickup_rate numeric,
    mfn_rate numeric,
    mfn_return_rate numeric,
    guarantee_amount numeric,
    guarantee_schedule text,
    fuel_rate numeric,
    reason text,
    status text,
    created_by uuid,
    updated_at timestamptz
  );

  insert into public.field_executive_provider_mappings(id,company_id,effective_from,status)
  values('00000000-0000-0000-0000-000000000099','00000000-0000-0000-0000-000000000001','2026-09-01','closed');
`);

await db.exec(migration);

const legacy = await db.query("select production_threshold_config from public.field_executive_provider_mappings where id='00000000-0000-0000-0000-000000000099'");
assert.deepEqual(legacy.rows[0].production_threshold_config, { enabled: false });

const companyId = "00000000-0000-0000-0000-000000000001";
const workerId = "00000000-0000-0000-0000-000000000002";
const providerId = "00000000-0000-0000-0000-000000000003";
const stationId = "00000000-0000-0000-0000-000000000004";
const methodId = "00000000-0000-0000-0000-000000000005";
const actorId = "00000000-0000-0000-0000-000000000006";

await db.query("insert into public.workforce(id,company_id,dropx_id,location_id) values($1,$2,'DX1',$3)", [workerId, companyId, stationId]);
await db.query("insert into public.stations(id,company_id,provider_id) values($1,$2,$3)", [stationId, companyId, providerId]);
await db.query(
  "select public.workforce_save_mapping($1,$2,$3,null,'DX1',$4::jsonb,null)",
  [companyId, actorId, workerId, JSON.stringify({
    provider_id: providerId,
    station_id: stationId,
    provider_member_id: "MEMBER-1",
    effective_from: "2026-10-01",
    effective_to: null,
    payment_method_id: methodId,
    payment_values: { DELIVERY: 13, CUSTOMER_RETURN: 8 },
    production_threshold_config: {
      period: "month",
      component_codes: ["DELIVERY", "CUSTOMER_RETURN"],
      minimum_units: 1000
    },
    pay_type: "PER_PACKET",
    status: "active"
  })]
);

const saved = await db.query("select id, production_threshold_config from public.field_executive_provider_mappings");
const enabled = saved.rows.find((row) => row.id !== "00000000-0000-0000-0000-000000000099");
assert.deepEqual(enabled.production_threshold_config, {
  period: "month",
  component_codes: ["DELIVERY", "CUSTOMER_RETURN"],
  minimum_units: 1000
});

await db.query(
  "select public.workforce_save_mapping($1,$2,$3,$4,'DX1',$5::jsonb,null)",
  [companyId, actorId, workerId, enabled.id, JSON.stringify({
    provider_id: providerId,
    station_id: stationId,
    provider_member_id: "MEMBER-1",
    effective_from: "2026-10-01",
    effective_to: null,
    payment_method_id: methodId,
    payment_values: { DELIVERY: 14, CUSTOMER_RETURN: 9 },
    pay_type: "PER_PACKET",
    status: "active"
  })]
);
const preserved = await db.query("select production_threshold_config from public.field_executive_provider_mappings where id=$1", [enabled.id]);
assert.deepEqual(preserved.rows[0].production_threshold_config, enabled.production_threshold_config);

await db.query(
  "insert into public.field_executive_provider_mappings(company_id,production_threshold_config) values($1,'{\"enabled\":false}'::jsonb)",
  [companyId]
);

await assert.rejects(
  db.query(
    `insert into public.field_executive_provider_mappings(company_id,production_threshold_config)
     values($1,'{"period":"month","component_codes":["DELIVERY"],"minimum_units":2.5}'::jsonb)`,
    [companyId]
  ),
  /field_executive_provider_mappings_threshold_config_check/
);

for (const incompleteConfig of [
  {},
  { component_codes: ["DELIVERY"], minimum_units: 1000 },
  { period: "month", minimum_units: 1000 },
  { period: "month", component_codes: ["DELIVERY"] }
]) {
  await assert.rejects(
    db.query(
      `insert into public.field_executive_provider_mappings(company_id,production_threshold_config)
       values($1,$2::jsonb)`,
      [companyId, JSON.stringify(incompleteConfig)]
    ),
    /field_executive_provider_mappings_threshold_config_check/
  );
}

const privileges = await db.query(`
  select
    has_function_privilege('anon','public.workforce_save_mapping(uuid,uuid,uuid,uuid,text,jsonb,uuid[])','EXECUTE') anon_execute,
    has_function_privilege('authenticated','public.workforce_save_mapping(uuid,uuid,uuid,uuid,text,jsonb,uuid[])','EXECUTE') authenticated_execute,
    has_function_privilege('service_role','public.workforce_save_mapping(uuid,uuid,uuid,uuid,text,jsonb,uuid[])','EXECUTE') service_execute
`);
assert.deepEqual(privileges.rows[0], { anon_execute: false, authenticated_execute: false, service_execute: true });

await db.close();
console.log("Production-threshold mapping snapshot migration verified.");
