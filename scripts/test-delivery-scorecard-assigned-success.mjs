import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync(
  new URL("../supabase/migrations/20261021120000_delivery_scorecard_assigned_success.sql", import.meta.url),
  "utf8"
).replace(/notify\s+pgrst\s*,\s*'reload schema'\s*;/gi, "");

const db = new PGlite();
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;
  create table cps_shipment_daily(
    company_id uuid not null,
    station_code text not null,
    work_date date not null,
    provider_employee_id text not null,
    provider_employee_name text,
    dropx_emp_code text,
    total_delivery numeric not null default 0,
    assigned_count numeric not null default 0,
    c_return numeric not null default 0,
    mfn_return numeric not null default 0,
    total_activity numeric not null default 0
  );
  ${migration}
  ${migration}
`);

const company = "00000000-0000-4000-8000-000000000001";
await db.query(
  `insert into cps_shipment_daily(company_id,station_code,work_date,provider_employee_id,provider_employee_name,total_delivery,assigned_count,c_return,total_activity)
   values
   ($1,'PHN','2026-10-10','A','One',40,50,2,42),
   ($1,'PHN','2026-10-11','A','One',10,0,0,10),
   ($1,'PMB','2026-10-10','B','Two',20,0,1,21)`,
  [company]
);

const result = await db.query(
  "select public.ops_delivery_scorecard($1, array['PHN','PMB']::text[], '2026-10-10'::date, '2026-10-11'::date) as payload",
  [company]
);
const payload = result.rows[0].payload;
const phn = payload.stations.find((row) => row.station === "PHN");
const pmb = payload.stations.find((row) => row.station === "PMB");
assert.equal(phn.assigned, 50);
assert.equal(Number(phn.delivery_success_pct), 100);
assert.equal(pmb.assigned, 0);
assert.equal(pmb.delivery_success_pct, null);

const daWithAssigned = payload.das.find((row) => row.id === "A");
const daWithout = payload.das.find((row) => row.id === "B");
assert.equal(Number(daWithAssigned.delivery_success_pct), 100);
assert.equal(daWithout.delivery_success_pct, null);

const privileges = await db.query(`
  select
    has_function_privilege('authenticated', 'public.ops_delivery_scorecard(uuid,text[],date,date)', 'EXECUTE') as authenticated,
    has_function_privilege('service_role', 'public.ops_delivery_scorecard(uuid,text[],date,date)', 'EXECUTE') as service_role
`);
assert.equal(privileges.rows[0].authenticated, false);
assert.equal(privileges.rows[0].service_role, true);

console.log("delivery scorecard assigned-success migration ok");
