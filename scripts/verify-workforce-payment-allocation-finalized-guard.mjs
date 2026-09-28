import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const company = "00000000-0000-0000-0000-000000000001";
const worker = "00000000-0000-0000-0000-000000000002";
const secondWorker = "00000000-0000-0000-0000-000000000003";
const allocation = "00000000-0000-0000-0000-000000000004";
const method = "00000000-0000-0000-0000-000000000005";
const run = "00000000-0000-0000-0000-000000000006";

await db.exec(`
  create role anon;
  create role authenticated;
  create table workforce_payroll_runs (
    id uuid primary key,
    company_id uuid not null,
    status text not null,
    period_start date not null,
    period_end date not null
  );
  create table workforce_payment_allocations (
    id uuid primary key,
    company_id uuid not null,
    workforce_id uuid not null,
    station_id uuid,
    station_code_snapshot text,
    designation_id uuid,
    designation_code_snapshot text,
    designation_name_snapshot text,
    payment_method_id uuid not null,
    payment_values jsonb not null,
    payment_components jsonb not null,
    effective_from date not null,
    effective_to date,
    status text not null,
    change_reason text,
    created_by uuid,
    updated_by uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  insert into workforce_payment_allocations (
    id, company_id, workforce_id, payment_method_id, payment_values,
    payment_components, effective_from, status
  ) values (
    '${allocation}', '${company}', '${worker}', '${method}', '{"BASE":1000}',
    '[{"component_code":"BASE","component_type":"amount","pay_schedule":"per_month"}]',
    '2026-08-01', 'active'
  );
  insert into workforce_payroll_runs
    (id, company_id, status, period_start, period_end)
  values
    ('${run}', '${company}', 'approved', '2026-09-01', '2026-09-30');
`);

await db.exec(readFileSync(
  new URL("../supabase/migrations/20260928120000_workforce_payment_allocation_finalized_guard.sql", import.meta.url),
  "utf8"
));

await assert.rejects(
  () => db.query(
    "update workforce_payment_allocations set payment_values = '{\"BASE\":1500}' where id = $1",
    [allocation]
  ),
  /Create a later effective-dated version/
);
await assert.rejects(
  () => db.query(
    "update workforce_payment_allocations set effective_to = '2026-09-15', status = 'closed' where id = $1",
    [allocation]
  ),
  /End or cancel it only after/
);
await assert.rejects(
  () => db.query(
    "update workforce_payment_allocations set status = 'cancelled' where id = $1",
    [allocation]
  ),
  /End or cancel it only after/
);
await assert.rejects(
  () => db.query("delete from workforce_payment_allocations where id = $1", [allocation]),
  /Keep the history row/
);
await assert.rejects(
  () => db.query(`
    insert into workforce_payment_allocations (
      id, company_id, workforce_id, payment_method_id, payment_values,
      payment_components, effective_from, effective_to, status
    ) values (
      gen_random_uuid(), $1, $2, $3, '{"BASE":1000}', '[]',
      '2026-09-01', '2026-09-30', 'closed'
    )
  `, [company, secondWorker, method]),
  /Start the direct payment allocation after/
);

await db.query(
  "update workforce_payment_allocations set effective_to = '2026-10-31', status = 'closed' where id = $1",
  [allocation]
);
await db.query(
  "update workforce_payment_allocations set change_reason = 'Documented after review' where id = $1",
  [allocation]
);
const future = await db.query(`
  insert into workforce_payment_allocations (
    id, company_id, workforce_id, payment_method_id, payment_values,
    payment_components, effective_from, status
  ) values (
    gen_random_uuid(), $1, $2, $3, '{"BASE":1000}', '[]', '2026-10-01', 'active'
  ) returning id
`, [company, secondWorker, method]);
await db.query(
  "update workforce_payment_allocations set payment_values = '{\"BASE\":1500}' where id = $1",
  [future.rows[0].id]
);

await db.close();
console.log("PASS direct allocation finalized-period guard: historical terms and coverage are immutable, later effective-dated versions remain editable.");
