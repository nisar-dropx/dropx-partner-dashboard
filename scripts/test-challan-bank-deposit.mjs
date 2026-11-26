import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const company = "00000000-0000-0000-0000-000000000001";
const caseId = "22222222-2222-2222-2222-222222222222";
const actor = "33333333-3333-3333-3333-333333333333";
const reviewer = "44444444-4444-4444-4444-444444444444";
const proofId = "55555555-5555-5555-5555-555555555555";
const sql = fs.readFileSync("supabase/migrations/20261126183000_challan_bank_deposit.sql", "utf8");

await db.exec(`
create role anon; create role authenticated; create role service_role;
create table public.fleet_challan_recovery_cases(
  id uuid primary key, company_id uuid not null, challan_id uuid not null, challan_number text not null,
  vehicle_no text not null default '', station_code text not null, month text not null, amount numeric not null,
  status text not null, offense_description text not null default '', evidence_url text not null default '',
  issuing_authority text not null default '', approved_by uuid, approved_by_name text not null default '',
  approved_at timestamptz not null default now(), created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.fleet_challan_recovery_allocations(
  id uuid primary key default gen_random_uuid(), company_id uuid not null, case_id uuid not null,
  person_ref text not null, person_name text not null default '', utr text not null default '',
  split_mode text not null default 'custom', amount numeric not null, salary_month text not null,
  installment_no int not null default 1, installment_count int not null default 1,
  status text not null default 'planned', remarks text not null default '',
  updated_by uuid, updated_by_name text not null default '', updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create table public.fleet_challan_recovery_events(
  id uuid primary key default gen_random_uuid(), company_id uuid not null, case_id uuid not null,
  action text not null, before_value jsonb, after_value jsonb, actor_id uuid, actor_name text not null,
  created_at timestamptz not null default now()
);
insert into public.fleet_challan_recovery_cases(id,company_id,challan_id,challan_number,station_code,month,amount,status)
values('${caseId}','${company}','66666666-6666-6666-6666-666666666666','CH-1','KTUR','2026-10',20200,'open');
`);

await db.exec(sql);
await db.exec(sql);

await assert.rejects(
  () =>
    db.query(
      `select fleet_challan_recovery_bank_deposit_v1($1,$2,$3,'CM',$4::jsonb,null)`,
      [company, caseId, actor, JSON.stringify({ received_amount: "20200", receipt_reference: "UTR12345", received_date: "2026-11-01" })],
    ),
  /screenshot|proof/i,
);

await db.query(
  `insert into fleet_challan_recovery_attachments(id,company_id,case_id,file_name,storage_bucket,storage_path)
   values($1,$2,$3,'slip.png','ops','path')`,
  [proofId, company, caseId],
);

await db.query(
  `select fleet_challan_recovery_bank_deposit_v1($1,$2,$3,'CM',$4::jsonb,'Paid at bank')`,
  [
    company,
    caseId,
    actor,
    JSON.stringify({
      received_amount: "20200",
      receipt_reference: "UTR12345",
      received_date: "2026-11-01",
      attachments: [{ id: proofId, file_name: "slip.png" }],
    }),
  ],
);

const pending = (await db.query(`select status, bank_deposit->>'approval_status' a from fleet_challan_recovery_cases where id=$1`, [caseId])).rows[0];
assert.equal(pending.status, "bank_pending");
assert.equal(pending.a, "proposed");

await assert.rejects(
  () => db.query(`select fleet_challan_recovery_bank_review_v1($1,$2,$3,'CM','approve',null)`, [company, caseId, actor]),
  /another authorised person/i,
);

await db.query(`select fleet_challan_recovery_bank_review_v1($1,$2,$3,'SLP','approve',null)`, [company, caseId, reviewer]);
const done = (await db.query(`select status, bank_deposit->>'approval_status' a from fleet_challan_recovery_cases where id=$1`, [caseId])).rows[0];
assert.equal(done.status, "recovered");
assert.equal(done.a, "approved");

console.log("PASS challan bank deposit: proof required, self-approve blocked, SLP verify recovers");
