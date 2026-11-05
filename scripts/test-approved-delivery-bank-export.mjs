import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const read = name => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const original = read('20261104171616_adhoc_odcd_delivery_identity_control.sql');
const oldCompatibility = read('20261104202500_preserve_inflight_delivery_payments.sql');
const migration = read('20261105121205_preserve_approved_delivery_bank_exports.sql');
const guard = original.match(/create or replace function public\.payment_delivery_identity_guard\(\)[\s\S]*?end \$\$;/i)?.[0];
assert.ok(guard, 'Use the actual production identity guard, not a mock validator');
const db = new PGlite();
const company = '00000000-0000-0000-0000-000000000001';
const head = '00000000-0000-0000-0000-000000000002';
const station = '00000000-0000-0000-0000-000000000003';
await db.exec(`
  create table stations(id uuid, company_id uuid, station_code text, provider_id uuid);
  create table cps_shipment_daily(id uuid, company_id uuid, station_code text, client text, provider_employee_id text);
  create table payment_heads(id uuid, company_id uuid, delivery_identity_policy text);
  insert into payment_heads values ('${head}', '${company}', 'van_execution');
  create table payment_requests(
    id int primary key, company_id uuid, location_id uuid, payment_head_id uuid,
    source_system text, status text, approval_status text, amount numeric,
    amount_requested numeric, amount_approved numeric, work_date date,
    payment_mode text, bank_account_no text, beneficiary_account_no text,
    beneficiary_account_number text, ifsc text, beneficiary_ifsc text,
    account_holder_name text, beneficiary_account_holder text,
    delivery_performer_mode text, delivery_work_date date, delivery_shipment_id uuid,
    delivery_provider_employee_id text, delivery_performer_workforce_id uuid,
    delivery_performer_name text, delivery_identity_confirmed boolean not null default false,
    adhoc_payout_effect text default 'none', adhoc_client text,
    updated_at timestamptz, updated_by uuid, processing_started_at timestamptz,
    bank_utr text, bank_status text, requested_for_name text
  );
  insert into payment_requests(id,company_id,location_id,payment_head_id,status,approval_status,
    amount,amount_requested,amount_approved,bank_account_no,beneficiary_ifsc)
  values (1,'${company}','${station}','${head}','approved','APPROVED',1500,1500,1500,'12345678','FDRL0000001');
`);
await db.exec(guard);
await db.exec(oldCompatibility);
const process = `update payment_requests set status='processing', approval_status='PROCESSING',
  processing_started_at=now(),updated_at=now(),updated_by='${company}' where id=1`;
await assert.rejects(() => db.exec(process), /Choose who performed the van deliveries/,
  'Reproduce the bank download failure against the previous live trigger');
await db.exec(migration);
await db.exec(migration);
await db.exec(process);
let row = (await db.query('select * from payment_requests where id=1')).rows[0];
assert.equal(row.status, 'processing');
assert.equal(row.approval_status, 'PROCESSING');
assert.equal(Number(row.amount), 1500);
assert.equal(row.bank_account_no, '12345678');
assert.equal(row.delivery_performer_mode, null, 'Never invent delivery identity');
assert.equal(row.delivery_identity_confirmed, false);

// Re-download and eventual bank confirmation remain possible without rewriting
// the approved payment or inventing a payroll deduction.
await db.exec(process);
await db.exec("update payment_requests set status='processed',approval_status='PROCESSED',bank_utr='TEST-UTR',bank_status='SUCCESS' where id=1");
await db.exec("update payment_requests set status='paid' where id=1");
assert.equal((await db.query('select bank_utr from payment_requests where id=1')).rows[0].bank_utr, 'TEST-UTR');

// New inserts still require identity, even if a caller attempts to create them
// directly in an approved or processing state.
for (const status of ['approved', 'processing', 'processed']) {
  await assert.rejects(() => db.exec(`insert into payment_requests(id,company_id,payment_head_id,status,amount)
    values(2,'${company}','${head}','${status}',100)`), /Choose who performed/);
}
await db.exec(`insert into payment_requests(id,company_id,payment_head_id,status)
  values(3,'${company}','${head}','approved')`);
await assert.rejects(() => db.exec("update payment_requests set amount=100,status='processing' where id=3"), /Choose who performed/,
  'An expense-only approval is not a completed legacy payment');

for (const change of [
  'amount=1600', 'amount_requested=1600', 'amount_approved=1600',
  "bank_account_no='different'", "beneficiary_ifsc='DIFFERENT'",
  "work_date='2026-11-01'", `company_id='${head}'`, `location_id='${head}'`,
  "source_system='changed'", "delivery_provider_employee_id='NEW-ID'",
  "adhoc_payout_effect='full_day'"
]) {
  // A company change selects a different policy in this minimal fixture; make
  // that company use the same policy so the real guard must still execute.
  if (change.startsWith('company_id')) await db.exec(`insert into payment_heads values('${head}','${head}','van_execution')`);
  await assert.rejects(() => db.exec(`update payment_requests set ${change} where id=1`), /Choose who performed/,
    `Compatibility must not exempt ${change}`);
}
await assert.rejects(() => db.exec("update payment_requests set status=null where id=1"), /Choose who performed/,
  'SQL NULL must not suppress the trigger');
await assert.rejects(() => db.exec("update payment_requests set delivery_performer_mode='bike_da' where id=1"), /Confirm/);

// Confirmed identities still use the real immutable-identity branch, including
// when the master policy changes after confirmation.
await db.exec("update payment_heads set delivery_identity_policy='none'");
await db.exec(`insert into payment_requests(id,company_id,payment_head_id,status,amount) values(4,'${company}','${head}','approved',100)`);
await db.exec('drop trigger payment_delivery_identity_guard_update on payment_requests');
await db.exec("update payment_requests set delivery_identity_confirmed=true,delivery_performer_mode='bike_da' where id=4");
await db.exec(migration);
await db.exec("update payment_requests set status='processing' where id=4");
await assert.rejects(() => db.exec("update payment_requests set delivery_performer_mode='van_driver' where id=4"), /Delivery identity is frozen/);
await assert.rejects(() => db.exec('delete from payment_requests where id=4'), /must be cancelled/);

assert.equal((await db.query("select count(*)::int n from pg_trigger where tgrelid='payment_requests'::regclass and not tgisinternal")).rows[0].n, 3,
  'Insert, update and delete protection all remain installed');
await db.close();
console.log('Passed: reproduced legacy failure; twice-applied fix; export/re-download/settlement; new-request, amount, bank, identity and NULL-status guards.');
