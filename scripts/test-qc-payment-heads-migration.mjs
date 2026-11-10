import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const sql = readFileSync(
  new URL("../supabase/migrations/20261110114500_qc_monthly_emergency_payment_heads.sql", import.meta.url),
  "utf8"
);

const company = "43866344-b550-4e8a-9a2d-9d23f3d8a997";
const electricity = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const generator = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const role = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const db = new PGlite();
await db.exec(`
create or replace function gen_random_uuid() returns uuid language sql as $$
  select (
    lpad(to_hex((random()*4294967295)::bigint),8,'0') || '-' ||
    lpad(to_hex((random()*65535)::int),4,'0') || '-4' ||
    lpad(to_hex((random()*4095)::int),3,'0') || '-' ||
    lpad(to_hex((random()*16383+32768)::int),4,'0') || '-' ||
    lpad(to_hex((random()*281474976710655)::bigint),12,'0')
  )::uuid
$$;
create table public.payment_heads (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  code text not null,
  name text not null,
  external_id text,
  requires_supporting_document boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 100,
  final_approval_role_id uuid,
  final_approval_role_ids uuid[] not null default '{}'::uuid[],
  payment_process_role_ids uuid[] not null default '{}'::uuid[],
  request_expense_approval boolean not null default false,
  expense_approval_threshold numeric,
  initial_approval_role_id uuid,
  initial_approval_role_ids uuid[] not null default '{}'::uuid[],
  supported_payment_modes text[] not null default array['account_transfer']::text[],
  delivery_identity_policy text not null default 'none',
  updated_at timestamptz not null default now(),
  unique (company_id, code)
);
create table public.payment_head_questions (
  id bigserial primary key,
  company_id uuid not null,
  payment_head_id uuid not null references public.payment_heads(id) on delete cascade,
  question_text text not null,
  answer_type text not null,
  is_required boolean not null default true,
  sort_order integer not null default 1,
  dropdown_options text,
  field_stage text,
  date_rule text,
  date_days integer
);
create table public.payment_head_approval_steps (
  id bigserial primary key,
  company_id uuid not null,
  payment_head_id uuid not null references public.payment_heads(id) on delete cascade,
  step_order integer not null,
  candidates jsonb not null,
  is_required boolean not null default true
);
insert into public.payment_heads (
  id, company_id, code, name, external_id, requires_supporting_document, is_active, sort_order,
  final_approval_role_id, final_approval_role_ids, payment_process_role_ids,
  initial_approval_role_id, initial_approval_role_ids, supported_payment_modes
) values
  ('${electricity}', '${company}', 'ELECTRICITY_BILL', 'Electricity Bill', 'Electricity Bill', true, true, 100,
   '${role}', array['${role}']::uuid[], array['${role}']::uuid[],
   '${role}', array['${role}']::uuid[], array['account_transfer','online_payment','upi_payment']::text[]),
  ('${generator}', '${company}', 'GENERATOR_FUEL', 'Generator Fuel', 'Generator Fuel', true, true, 100,
   '${role}', array['${role}']::uuid[], array['${role}']::uuid[],
   '${role}', array['${role}']::uuid[], array['account_transfer','upi_payment']::text[]);
insert into public.payment_head_questions (
  company_id, payment_head_id, question_text, answer_type, is_required, sort_order, dropdown_options, field_stage, date_rule
) values
  ('${company}', '${electricity}', 'Bill No/Ref No', 'text', true, 1, null, 'payment', 'any'),
  ('${company}', '${electricity}', 'Upload Bill', 'file', true, 2, '["image","document"]', 'payment', 'any'),
  ('${company}', '${electricity}', 'Bill No/Ref No', 'text', true, 3, null, 'expense', 'any'),
  ('${company}', '${electricity}', 'Supporting attachments', 'file', false, 4, '["image","document"]', 'expense', 'any');
insert into public.payment_head_approval_steps (company_id, payment_head_id, step_order, candidates, is_required)
values ('${company}', '${electricity}', 1, '[{"scope":"station","role_id":"${role}"}]'::jsonb, false),
       ('${company}', '${electricity}', 2, '[{"scope":"company","role_id":"${role}"}]'::jsonb, true);
`);

await db.exec(sql);
await db.exec(sql);

const heads = (await db.query(
  "select code, name, external_id from public.payment_heads where company_id=$1 order by code",
  [company]
)).rows;
assert.deepEqual(
  heads.map((row) => row.code),
  [
    "ADHOC_MANPOWER",
    "CORPORATION_BILL",
    "ELECTRICITY_BILL",
    "GENERATOR_FUEL",
    "HK_MATERIAL",
    "OTHERS",
    "STATION_VISITS"
  ]
);

const generatorRow = heads.find((row) => row.code === "GENERATOR_FUEL");
assert.equal(generatorRow.name, "Generator Diesel bill");
assert.equal(generatorRow.external_id, "Generator Diesel bill");

const questionCounts = (await db.query(`
  select h.code, count(*)::int as n
  from public.payment_heads h
  join public.payment_head_questions q on q.payment_head_id = h.id
  where h.company_id = $1
  group by h.code
  order by h.code
`, [company])).rows;
assert.deepEqual(
  Object.fromEntries(questionCounts.map((row) => [row.code, row.n])),
  {
    ADHOC_MANPOWER: 4,
    CORPORATION_BILL: 4,
    ELECTRICITY_BILL: 4,
    GENERATOR_FUEL: 4,
    HK_MATERIAL: 4,
    OTHERS: 4,
    STATION_VISITS: 4
  }
);

const stepCounts = (await db.query(`
  select h.code, count(s.id)::int as n
  from public.payment_heads h
  left join public.payment_head_approval_steps s on s.payment_head_id = h.id
  where h.company_id = $1 and h.code <> 'ELECTRICITY_BILL'
  group by h.code
  order by h.code
`, [company])).rows;
assert.deepEqual(
  Object.fromEntries(stepCounts.map((row) => [row.code, row.n])),
  {
    ADHOC_MANPOWER: 2,
    CORPORATION_BILL: 2,
    GENERATOR_FUEL: 0,
    HK_MATERIAL: 2,
    OTHERS: 2,
    STATION_VISITS: 2
  }
);

console.log("PASS: QC payment heads migration is idempotent and seeds the requested dropdown heads");
await db.close();
