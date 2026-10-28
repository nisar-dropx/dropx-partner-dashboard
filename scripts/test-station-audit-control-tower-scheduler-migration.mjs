// Control Tower gains Audit Master scheduler + cross-audit start access.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const db = new PGlite();
await db.exec(`
create table companies(id uuid primary key, name text not null);
create table user_roles(
  id uuid primary key, company_id uuid not null, product_code text not null,
  code text not null, name text not null, is_active boolean not null default true
);
create table ops_audit_programme_settings(
  company_id uuid primary key,
  scheduler_role_ids uuid[] not null default '{}',
  cross_audit_role_ids uuid[] not null default '{}',
  updated_by uuid null
);
`);

const C = "43866344-b550-4e8a-9a2d-9d23f3d8a997";
const CT = "442169f0-729f-4e28-8721-4b45d3aff8c4";
const CT_NAMED = "d48381ca-9b70-4f05-8e5c-018376fc7e71";
const ASSOCIATE = "1e42678a-e369-44a7-b12b-b1d52f380f38";
const BH = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

await db.exec(`
insert into companies values('${C}', 'DROPX LOGISTICS');
insert into user_roles(id, company_id, product_code, code, name) values
 ('${CT}', '${C}', 'operations', 'OPERATIONS_CT', 'CONTROL TOWER'),
 ('${CT_NAMED}', '${C}', 'operations', 'OPERATIONS_CONTROL_TOWER', 'Operations · Control Tower'),
 ('${ASSOCIATE}', '${C}', 'operations', 'OPERATIONS_CONTROL_TOWER_ASSOCIATE', 'Control Tower Associate'),
 ('${BH}', '${C}', 'operations', 'OPERATIONS_BH', 'Business Head');
insert into ops_audit_programme_settings(company_id, scheduler_role_ids, cross_audit_role_ids)
values('${C}', array['${BH}'::uuid], array['${BH}'::uuid]);
`);

const sql = readFileSync(
  "supabase/migrations/20261028240000_station_audit_control_tower_scheduler_access.sql",
  "utf8",
);
await db.exec(sql);
await db.exec(sql); // idempotent

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(ok ? "PASS" : "FAIL", name, ok ? "" : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};
const one = async (q) => (await db.query(q)).rows[0];

eq(
  "scheduler includes CT roles and keeps Business Head",
  await one(`
    select
      '${CT}'::uuid = any(scheduler_role_ids) as ct,
      '${CT_NAMED}'::uuid = any(scheduler_role_ids) as named,
      '${ASSOCIATE}'::uuid = any(scheduler_role_ids) as associate,
      '${BH}'::uuid = any(scheduler_role_ids) as bh,
      cardinality(scheduler_role_ids) as n
    from ops_audit_programme_settings where company_id='${C}'
  `),
  { ct: true, named: true, associate: false, bh: true, n: 3 },
);

eq(
  "cross-audit includes CT roles and keeps Business Head",
  await one(`
    select
      '${CT}'::uuid = any(cross_audit_role_ids) as ct,
      '${CT_NAMED}'::uuid = any(cross_audit_role_ids) as named,
      '${ASSOCIATE}'::uuid = any(cross_audit_role_ids) as associate,
      '${BH}'::uuid = any(cross_audit_role_ids) as bh,
      cardinality(cross_audit_role_ids) as n
    from ops_audit_programme_settings where company_id='${C}'
  `),
  { ct: true, named: true, associate: false, bh: true, n: 3 },
);

if (fails) process.exit(1);
console.log("All checks passed.");
