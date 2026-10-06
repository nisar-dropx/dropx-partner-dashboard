import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

// Real PostgreSQL (WASM), with isolated fixture tables. Never contacts production.
const db = new PGlite();
const migration = name => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create schema storage;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(bucket_id text,name text);
create table companies(id uuid primary key);
create table profiles(id uuid primary key, company_id uuid, full_name text, is_active boolean, role text);
create table designations(id uuid primary key,company_id uuid,is_active boolean);
create table hr_expense_categories(id uuid primary key default gen_random_uuid(),company_id uuid,code text,name text,description text,receipt_required boolean,receipt_threshold numeric,per_item_limit numeric,per_day_limit numeric,is_active boolean default true,created_by uuid,updated_by uuid,updated_at timestamptz default now());
create table hr_expense_claim_requests(id uuid primary key,company_id uuid,expected_expenses jsonb,status text);
create table hr_expense_policies(id uuid primary key,company_id uuid,payment_head_id uuid,updated_by uuid,updated_at timestamptz default now());
create table hr_expense_items(id uuid primary key,company_id uuid,claim_id uuid,category_id uuid,expense_date date,amount numeric,approved_amount numeric,sort_order int,merchant text,description text,reviewer_note text);
create table hr_expense_claims(id uuid primary key,company_id uuid,claimant_person_id uuid,claimant_user_id uuid,total_claimed numeric,total_approved numeric,status text,current_step int,payment_request_id uuid);
create table hr_expense_approval_steps(id uuid primary key default gen_random_uuid(),company_id uuid,claim_id uuid,step_order int,step_name text,stage_code text,approver_user_id uuid,status text,decision_note text);
create table hr_expense_events(id uuid primary key default gen_random_uuid(),company_id uuid,claim_id uuid,event_type text,from_status text,to_status text,actor_user_id uuid,actor_name text,actor_role text,comments text,metadata jsonb);
create table hr_expense_attachments(id uuid primary key default gen_random_uuid(),company_id uuid,claim_id uuid,item_id uuid,storage_path text,file_name text);
create table hr_engagements(id uuid primary key,company_id uuid,person_id uuid,status text);
create table hr_work_assignments(id uuid primary key,company_id uuid,engagement_id uuid,designation_id uuid,is_primary boolean,effective_from date,effective_to date);
create table hr_user_person_links(company_id uuid,user_id uuid,person_id uuid,status text default 'active');
create table payment_heads(id uuid primary key,company_id uuid,is_active boolean,payment_process_role_ids uuid[]);
create table payment_requests(id uuid primary key default gen_random_uuid(),company_id uuid,source_id uuid,source_type text,amount numeric,amount_requested numeric,details jsonb);
`);
await db.exec(migration('20260914162411_finance_reimbursement_limits.sql'));
await db.exec(`create function hr_submit_expense_claim(p_items jsonb) returns void language plpgsql as $$ declare v_item jsonb; begin for v_item in select * from jsonb_array_elements(p_items) loop insert into hr_expense_items(id,description, amount, sort_order) values ((v_item->>'id')::uuid,'fixture',(v_item->>'amount')::numeric,1); end loop; end $$;
create function hr_resubmit_expense_claim(p_items jsonb) returns void language plpgsql as $$ declare v_item jsonb; begin for v_item in select * from jsonb_array_elements(p_items) loop insert into hr_expense_items(id,description,amount,sort_order) values ((v_item->>'id')::uuid,'fixture',(v_item->>'amount')::numeric,1); end loop; end $$;`);
await db.exec(migration('20260914165600_finance_reimbursement_policy_documents.sql'));
await db.exec(migration('20260914170512_finance_reimbursement_eligibility.sql'));
await db.exec(migration('20261006130000_reimbursement_finance_adjustment.sql'));

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const company = id(1), editor = id(2), person = id(3), designation = id(4), stay = id(5), engagement = id(6);
const manager = id(7), finance = id(8), special = id(9), claimantUser = id(10);
await db.query(`insert into companies values ($1)`, [company]);
for (const [user, name] of [[editor, 'Finance editor'], [manager, 'Manager'], [finance, 'Finance approver'], [special, 'Special approver'], [claimantUser, 'Claimant']]) {
  await db.query(`insert into profiles values ($1,$2,$3,true,'Finance')`, [user, company, name]);
}
await db.query(`insert into designations values ($1,$2,true)`, [designation, company]);
await db.query(`insert into hr_expense_categories(id,company_id,code,name,receipt_required,receipt_threshold) values($1,$2,'STAY','Stay',true,0)`, [stay, company]);
await db.query(`insert into hr_engagements values($1,$2,$3,'active')`, [engagement, company, person]);
await db.query(`insert into hr_work_assignments values($1,$2,$3,$4,true,'2026-01-01',null)`, [id(11), company, engagement, designation]);
await db.query(`insert into hr_user_person_links(company_id,user_id,person_id) values($1,$2,$3)`, [company, claimantUser, person]);

const line = (n, amount, date, quantity = null) => ({ id: id(n), category_id: stay, expense_date: date, amount, quantity });
const quote = async (items, claim = null) => (await db.query('select finance_quote_reimbursement($1,$2,$3,$4) as q', [company, person, JSON.stringify(items), claim])).rows[0].q;
const saveRule = async data => (await db.query('select finance_save_reimbursement_master($1,$2,$3,$4) as id', [company, editor, 'limit', JSON.stringify(data)])).rows[0].id;
const rule = { category_id: stay, designation_id: designation, permissible_amount: 1200, limit_basis: 'per_day', excess_action: 'cap', effective_from: '2026-09-01', is_active: true };
await saveRule(rule);

// The reported claim: one ₹5,052 hotel line for a three-night stay at ₹1,200 / night.
let q = await quote([line(20, 5052, '2026-09-27')]);
assert.equal(q[0].eligible_amount, 1200, 'a line without days/nights covers one night');
q = await quote([line(20, 5052, '2026-09-27', 3)]);
assert.equal(q[0].eligible_amount, 3600, 'three nights are payable at three daily ceilings');
assert.equal(q[0].days, 3);
assert.equal(q[0].excess_amount, 1452);
assert.equal((await quote([line(21, 3000, '2026-09-27', 3)]))[0].eligible_amount, 3000, 'a bill under the ceiling is paid in full');
await assert.rejects(quote([line(22, 3000, '2026-09-27', 2.5)]), /whole number/);
await assert.rejects(quote([line(22, 3000, '2026-09-27', 32)]), /whole number/);

// Lines in one claim share each day's allowance.
q = await quote([line(23, 2000, '2026-09-27', 2), line(24, 500, '2026-09-28')]);
assert.deepEqual(q.map(x => x.eligible_amount), [2000, 200]);

async function claim(n, items, steps = []) {
  const claimId = id(n);
  await db.exec('begin');
  try {
    await db.query(`insert into hr_expense_claims(id,company_id,claimant_person_id,claimant_user_id,total_claimed,status) values($1,$2,$3,$4,$5,'pending_approval')`, [claimId, company, person, claimantUser, items.reduce((s, i) => s + i.amount, 0)]);
    for (const [index, i] of items.entries()) await db.query('insert into hr_expense_items(id,company_id,claim_id,category_id,expense_date,amount,sort_order,quantity) values($1,$2,$3,$4,$5,$6,$7,$8)', [i.id, company, claimId, i.category_id, i.expense_date, i.amount, index, i.quantity]);
    for (const [index, s] of steps.entries()) await db.query(`insert into hr_expense_approval_steps(company_id,claim_id,step_order,step_name,stage_code,approver_user_id,status) values($1,$2,$3,$4,$5,$6,$7)`, [company, claimId, index + 1, s.name, s.stage, s.user, s.status ?? (index === 0 ? 'pending' : 'waiting')]);
    await db.query(`insert into hr_expense_events(company_id,claim_id,event_type) values($1,$2,'submitted')`, [company, claimId]);
    await db.exec('commit'); return claimId;
  } catch (error) { await db.exec('rollback'); throw error; }
}
const itemRow = async itemId => (await db.query('select * from hr_expense_items where id=$1', [itemId])).rows[0];

// A live multi-night claim reserves every night it covers, not only its first date.
const multiNight = await claim(30, [line(31, 5052, '2026-09-10', 3)]);
assert.equal(Number((await itemRow(id(31))).approved_amount), 3600, 'submission stores the policy payable amount');
assert.equal((await quote([line(32, 1000, '2026-09-12')]))[0].eligible_amount, 0, 'the third night is already used');
assert.equal((await quote([line(33, 1000, '2026-09-13')]))[0].eligible_amount, 1000, 'the day after the stay is free');
assert.equal((await quote([line(31, 5052, '2026-09-10', 3)], multiNight))[0].eligible_amount, 3600, 'a claim does not count against itself');

// Finance corrects the payable amount of the reported single-line claim.
const route = [{ name: 'Manager', stage: 'manager', user: manager }, { name: 'Finance approval', stage: 'finance', user: finance }];
const reported = await claim(40, [line(41, 5052, '2026-09-27')], route);
assert.equal(Number((await itemRow(id(41))).approved_amount), 1200);
const adjust = (claimId, itemId, actor, amount, note) => db.query('select hr_finance_adjust_expense_item($1,$2,$3,$4,$5,$6) as r', [company, claimId, itemId, actor, amount, note]);
await assert.rejects(adjust(reported, id(41), finance, 3600, 'Three nights verified'), /assigned to another user/, 'Finance cannot adjust before the claim reaches Finance');
await assert.rejects(adjust(reported, id(41), manager, 3600, 'Three nights verified'), /Only the Finance approver/);
await db.query(`update hr_expense_approval_steps set status='approved' where claim_id=$1 and stage_code='manager'`, [reported]);
await db.query(`update hr_expense_approval_steps set status='pending' where claim_id=$1 and stage_code='finance'`, [reported]);
await assert.rejects(adjust(reported, id(41), manager, 3600, 'Three nights verified'), /assigned to another user/);
await assert.rejects(adjust(reported, id(41), finance, 6000, 'Three nights verified'), /cannot exceed the claimed bill/);
await assert.rejects(adjust(reported, id(41), finance, -1, 'Three nights verified'), /valid payable amount/);
await assert.rejects(adjust(reported, id(41), finance, 3600, ' '), /Record why/);
await assert.rejects(adjust(reported, id(31), finance, 3600, 'Three nights verified'), /not found on the claim/);
let result = (await adjust(reported, id(41), finance, 3600, 'Three nights verified against the hotel invoice')).rows[0].r;
assert.equal(result.payable, 3600); assert.equal(result.previous_payable, 1200); assert.equal(result.claim_payable_total, 3600);
let adjusted = await itemRow(id(41));
assert.equal(Number(adjusted.approved_amount), 3600);
assert.equal(adjusted.finance_policy_snapshot.eligible_amount, 3600);
assert.equal(adjusted.finance_policy_snapshot.finance_adjustment.policy_eligible_amount, 1200, 'the policy assessment is kept for audit');
assert.equal(adjusted.finance_policy_snapshot.finance_adjustment.adjusted_by_name, 'Finance approver');
assert.equal(adjusted.reviewer_note, 'Three nights verified against the hotel invoice');
result = (await adjust(reported, id(41), finance, 3000, 'Breakfast charge excluded')).rows[0].r;
assert.equal(result.previous_payable, 3600);
adjusted = await itemRow(id(41));
assert.equal(adjusted.finance_policy_snapshot.finance_adjustment.policy_eligible_amount, 1200, 'a second adjustment keeps the original policy figure');
const events = (await db.query(`select metadata,actor_user_id,comments from hr_expense_events where claim_id=$1 and event_type='finance_amount_adjusted' order by (metadata->>'payable')::numeric desc`, [reported])).rows;
assert.equal(events.length, 2);
assert.equal(events[0].metadata.above_policy, true); assert.equal(events[0].actor_user_id, finance);
// Payments receives exactly the Finance-adjusted amount.
await db.query(`update hr_expense_approval_steps set status='approved' where claim_id=$1`, [reported]);
const payment = await db.query(`insert into payment_requests(company_id,source_id,source_type,amount,amount_requested) values($1,$2,'employee_reimbursement',5052,5052) returning *`, [company, reported]);
assert.equal(Number(payment.rows[0].amount), 3000);
assert.equal(Number(payment.rows[0].amount_requested), 5052, 'the claimed bill is preserved');
await db.query(`update hr_expense_claims set status='approved_for_payment' where id=$1`, [reported]);
await assert.rejects(adjust(reported, id(41), finance, 3600, 'Too late to change'), /no longer awaiting approval/);

// A Finance approver cannot adjust their own claim.
await db.query(`insert into hr_user_person_links(company_id,user_id,person_id) values($1,$2,$3)`, [company, finance, person]);
const own = await claim(50, [line(51, 900, '2026-09-20')], [{ name: 'Finance approval', stage: 'finance', user: finance }]);
await assert.rejects(adjust(own, id(51), finance, 500, 'Reduced after review'), /Self-approval/);
await db.query(`delete from hr_user_person_links where user_id=$1`, [finance]);

// A special approver already routed before Finance is not given a second step after Finance.
await saveRule({ ...rule, excess_action: 'special_approval', special_approver_user_id: special, effective_from: '2026-10-01' });
const routed = await claim(60, [line(61, 2000, '2026-10-02')], [
  { name: 'Manager', stage: 'manager', user: manager },
  { name: 'Business policy exception approval', stage: 'policy_exception', user: special },
  { name: 'Finance approval', stage: 'finance', user: finance }
]);
let steps = (await db.query('select * from hr_expense_approval_steps where claim_id=$1 order by step_order', [routed])).rows;
assert.equal(steps.length, 3, 'no duplicate exception step');
assert.deepEqual(steps.map(s => s.is_policy_exception), [false, true, false]);
assert.equal(steps[2].stage_code, 'finance', 'Finance remains the final step');
// A caller that routed nobody still gets the exception approval appended.
const unrouted = await claim(70, [line(71, 2000, '2026-10-03')], [{ name: 'Manager', stage: 'manager', user: manager }]);
steps = (await db.query('select * from hr_expense_approval_steps where claim_id=$1 order by step_order', [unrouted])).rows;
assert.equal(steps.length, 2); assert.equal(steps[1].is_policy_exception, true); assert.equal(steps[1].approver_user_id, special);

// Supporting approval documents are a distinct, constrained kind.
await db.query(`insert into hr_expense_attachments(company_id,claim_id,storage_path,file_name) values($1,$2,'a/receipts.pdf','receipts.pdf')`, [company, routed]);
assert.equal((await db.query('select document_kind from hr_expense_attachments where claim_id=$1', [routed])).rows[0].document_kind, 'receipt');
await db.query(`insert into hr_expense_attachments(company_id,claim_id,storage_path,file_name,document_kind) values($1,$2,'a/special-approval.pdf','special-approval.pdf','supporting_approval')`, [company, routed]);
await assert.rejects(db.query(`insert into hr_expense_attachments(company_id,claim_id,storage_path,file_name,document_kind) values($1,$2,'a/x.pdf','x.pdf','other')`, [company, routed]), /check constraint/);

// The migration refuses to install over an event-type constraint that would reject its audit event.
const guarded = new PGlite();
await guarded.exec(`create table hr_expense_events(event_type text check (event_type in ('submitted','resubmitted')));`);
await assert.rejects(guarded.exec(migration('20261006130000_reimbursement_finance_adjustment.sql')), /restricts event_type/);

console.log('PASS reimbursement finance adjustment');
