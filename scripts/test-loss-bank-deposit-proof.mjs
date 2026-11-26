import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const company = "00000000-0000-0000-0000-000000000001";
const proofId = "11111111-1111-1111-1111-111111111111";
const sql = fs.readFileSync("supabase/migrations/20261126180000_loss_bank_deposit_proof.sql", "utf8");

await db.exec(`
create role anon; create role authenticated; create role service_role;
create table public.nl_recovery_outcomes(
  company_id uuid, code text, label text, allocation_required boolean default false,
  attachments_enabled boolean default false, restricted boolean default false,
  deduction_timing text default 'none', primary key(company_id, code)
);
create table public.nl_recovery_attachments(
  id uuid primary key, company_id uuid, month text, case_key text,
  file_name text, storage_bucket text, storage_path text, content_type text, file_size int, created_by uuid
);
create table public.nl_loss_recoveries(
  company_id uuid, month text, case_key text, outcome_code text, source_amount numeric,
  recovery_details jsonb default '{}'::jsonb, remarks text default '', is_deleted boolean default false,
  primary key(company_id, month, case_key)
);
insert into public.nl_recovery_outcomes(company_id, code, label, allocation_required, attachments_enabled, restricted, deduction_timing)
values('${company}', 'already_recovered', 'Already recovered', false, false, true, 'none');
`);

await db.exec(sql);
await db.exec(sql);

const outcome = (await db.query(
  `select label, attachments_enabled, restricted, allocation_required, deduction_timing
     from nl_recovery_outcomes where code='already_recovered'`,
)).rows[0];
assert.equal(outcome.label, "Bank deposit");
assert.equal(outcome.attachments_enabled, true);
assert.equal(outcome.restricted, true);
assert.equal(outcome.allocation_required, false);
assert.equal(outcome.deduction_timing, "none");

async function mustFail(label, details) {
  await assert.rejects(
    () =>
      db.query(
        `insert into nl_loss_recoveries(company_id,month,case_key,outcome_code,source_amount,recovery_details)
         values($1,'2026-10','SHIP1','already_recovered',20200,$2::jsonb)
         on conflict (company_id,month,case_key) do update
           set recovery_details=excluded.recovery_details, outcome_code=excluded.outcome_code, source_amount=excluded.source_amount, is_deleted=false`,
        [company, JSON.stringify(details)],
      ),
    /./,
    label,
  );
}

await mustFail("missing proof rejected", {
  received_amount: "20200",
  receipt_reference: "UTR12345",
  received_date: "2026-11-01",
});
await mustFail("partial amount rejected", {
  received_amount: "100",
  receipt_reference: "UTR12345",
  received_date: "2026-11-01",
  attachments: [{ id: proofId, file_name: "slip.png" }],
});
await mustFail("short transaction number rejected", {
  received_amount: "20200",
  receipt_reference: "ab",
  received_date: "2026-11-01",
  attachments: [{ id: proofId, file_name: "slip.png" }],
});
await mustFail("unknown attachment id rejected", {
  received_amount: "20200",
  receipt_reference: "UTR12345",
  received_date: "2026-11-01",
  attachments: [{ id: proofId, file_name: "slip.png" }],
});

await db.query(
  `insert into nl_recovery_attachments(id,company_id,month,case_key,file_name,storage_bucket,storage_path,content_type,file_size)
   values($1,$2,'2026-10','SHIP1','slip.png','ops','path','image/png',12)`,
  [proofId, company],
);

await db.query(
  `insert into nl_loss_recoveries(company_id,month,case_key,outcome_code,source_amount,recovery_details)
   values($1,'2026-10','SHIP1','already_recovered',20200,$2::jsonb)`,
  [
    company,
    JSON.stringify({
      received_amount: "20200",
      receipt_reference: "UTR12345",
      received_date: "2026-11-01",
      attachments: [{ id: proofId, file_name: "slip.png" }],
    }),
  ],
);

const saved = (await db.query(`select recovery_details->>'receipt_reference' ref from nl_loss_recoveries where case_key='SHIP1'`)).rows[0];
assert.equal(saved.ref, "UTR12345");

console.log("PASS loss bank deposit proof: label, required screenshot, amount/txn guards, idempotent migration");
