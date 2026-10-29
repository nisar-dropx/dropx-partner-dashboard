import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// A real PostgreSQL engine with only the external tables this additive draft
// needs. No production data, network connection or application credentials.
const db = new PGlite();
const company='00000000-0000-4000-8000-000000000001';
const other='00000000-0000-4000-8000-000000000002';
const worker='00000000-0000-4000-8000-000000000003';
const alien='00000000-0000-4000-8000-000000000004';
const advance='00000000-0000-4000-8000-000000000005';
const future='00000000-0000-4000-8000-000000000006';
const request='00000000-0000-4000-8000-000000000007';
const payment='00000000-0000-4000-8000-000000000008';
const one = async (sql,args=[]) => (await db.query(sql,args)).rows[0];
const due = async (period='2026-10-01',target=null) => (await db.query(
  'select * from public.pay_advance_due($1,$2,$3,$4,$5,$6)',[company,'workforce',worker,period,target?'workforce':null,target])).rows;
const reserve = (target,amount=300,period='2026-10-01',id=advance) => db.query(
  'select public.pay_advance_reserve($1,$2,$3,$4,$5,$6,$7)',
  [company,'workforce',worker,period,'workforce',target,JSON.stringify([{advance_id:id,amount}])]);
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table public.companies(id uuid primary key);
    create table public.payment_requests(id uuid primary key,company_id uuid,source_type text,bank_status text,utr_cin text,source_id uuid,amount numeric,request_no text);
    create table public.hr_pay_advance_requests(id uuid primary key,company_id uuid,payment_request_id uuid,status text,approved_amount numeric,recovery_mode text,approved_installments integer,requested_installments integer,worker_type text,worker_id uuid,worker_code text,request_number text);
    insert into public.companies values('${company}'),('${other}');`);
  const migration=await readFile('supabase/migrations/20261029115517_unified_paid_advance_ledger.sql','utf8');
  await db.exec(migration);
  await db.exec(migration);
  assert.equal((await one("select count(*)::int n from pg_class where relname in ('pay_advances','pay_advance_deductions') and relrowsecurity")).n,2);
  for (const role of ['anon','authenticated']) {
    assert.equal((await one('select has_table_privilege($1,$2,$3) allowed',[role,'public.pay_advances','SELECT'])).allowed,false);
    for(const fn of ['pay_advance_worker_summary(uuid,text,uuid,date)','pay_advance_due(uuid,text,uuid,date,text,text)','pay_advance_reserve(uuid,text,uuid,date,text,text,jsonb)','pay_advance_record_bank_payment(uuid,uuid)'])
      assert.equal((await one('select has_function_privilege($1,$2,$3) allowed',[role,`public.${fn}`,'EXECUTE'])).allowed,false);
  }
  await db.query(`insert into public.pay_advances(id,company_id,worker_type,worker_id,amount,paid_at,first_due_period,installments,evidence_type,source_key)
    values($1,$2,'workforce',$3,1000,'2026-09-30 19:00:00+00','2026-10-01',3,'legacy_recorded','fixture')`,[advance,company,worker]);
  assert.equal(Number((await due())[0].amount),333.33,'installment rounding leaves the remainder for the last installment');
  assert.equal((await due('2026-09-01')).length,0,'no recovery before the due month');
  await reserve('october',200);
  assert.equal(Number((await due())[0].amount),133.33,'other payrolls see reserved capacity');
  assert.equal(Number((await due('2026-10-01','october'))[0].amount),333.33,'same payroll can recalculate');
  await reserve('october',200);
  assert.equal((await one('select count(*)::int n from public.pay_advance_deductions')).n,1,'retry does not create another deduction');
  await assert.rejects(reserve('another',134),/stale|balance/);
  await assert.rejects(reserve('october',400),/stale|balance/);
  assert.equal(Number((await one('select amount from public.pay_advance_deductions')).amount),200,'failed recalculation is atomic');
  await reserve('october',333.33);
  await db.exec("update public.pay_advance_deductions set status='confirmed'");
  await reserve('october',333.33);
  await assert.rejects(reserve('october',300),/Confirmed/);
  await assert.rejects(db.exec("update public.pay_advance_deductions set status='reversed'"),/immutable/);
  await reserve('november',333.33,'2026-11-01');
  assert.equal(Number((await due('2026-12-01'))[0].amount),333.34,'last installment carries paise without loss');
  await assert.rejects(reserve('december',333.35,'2026-12-01'),/stale|balance/);
  await assert.rejects(db.query('select public.pay_advance_reserve($1,$2,$3,$4,$5,$6,$7)',[company,'workforce',alien,'2026-12-01','workforce','wrong-worker',JSON.stringify([{advance_id:advance,amount:1}])]),/stale|ineligible/);
  await assert.rejects(db.query('select public.pay_advance_reserve($1,$2,$3,$4,$5,$6,$7)',[other,'workforce',worker,'2026-12-01','workforce','wrong-company',JSON.stringify([{advance_id:advance,amount:1}])]),/stale|ineligible/);
  await assert.rejects(reserve('november',1,'2026-12-01'),/another worker or period/);
  await assert.rejects(reserve('fraction',0.001),/Invalid/);
  await assert.rejects(reserve('nan','NaN'),/Invalid/);
  await assert.rejects(db.query('select public.pay_advance_reserve($1,$2,$3,$4,$5,$6,$7)',[company,null,worker,'2026-12-01','workforce','null-type','[]']),/Invalid/);
  await assert.rejects(db.query('select public.pay_advance_reserve($1,$2,$3,$4,$5,$6,$7)',[company,'workforce',worker,'2026-12-01','people','wrong-target','[]']),/category/);
  await assert.rejects(db.query('select public.pay_advance_reserve($1,$2,$3,$4,$5,$6,$7)',[company,'workforce',worker,'2026-12-01','workforce','duplicate',JSON.stringify([{advance_id:advance,amount:1},{advance_id:advance,amount:1}])]),/Duplicate/);
  const summary=(await one('select public.pay_advance_worker_summary($1,$2,$3,$4) s',[company,'workforce',worker,'2026-10-01'])).s;
  assert.equal(summary.monthPaidCount,1,'India month includes a UTC September timestamp after midnight India');
  assert.equal(summary.monthPaidAmount,1000);
  assert.equal(summary.outstandingAdvance,666.67,'draft deductions are not recovered');
  assert.equal(summary.reservedRecovery,333.33);
  assert.equal((await one('select public.pay_advance_worker_summary($1,$2,$3,$4) s',[other,'workforce',worker,'2026-10-01'])).s.monthPaidCount,0);
  await assert.rejects(db.exec('update public.pay_advances set amount=2000'),/immutable/);
  await db.query(`insert into public.pay_advances(id,company_id,worker_type,worker_id,amount,paid_at,first_due_period,installments,evidence_type,source_key)
    values($1,$2,'workforce',$3,500,'2026-11-01','2026-11-01',1,'legacy_recorded','future')`,[future,company,worker]);
  assert.equal((await due('2026-10-01')).length,0,'future principal is not included in earlier payroll');
  await db.query(`insert into public.payment_requests values($1,$2,'pay_advance','Pending',null,$3,700,'PA1');`,[payment,company,request]);
  await db.query(`insert into public.hr_pay_advance_requests values($1,$2,$3,'approved',700,'one_time',1,1,'employee',$4,'EMP1','ADV1')`,[request,company,payment,worker]);
  const confirm = () => db.query('select public.pay_advance_record_bank_payment($1,$2) id',[company,payment]);
  await assert.rejects(confirm(),/Bank confirmation/);
  await db.query("update public.payment_requests set bank_status='Paid' where id=$1",[payment]);
  await assert.rejects(confirm(),/UTR/);
  await db.query("update public.payment_requests set utr_cin='UTR-TEST',amount=701 where id=$1",[payment]);
  await assert.rejects(confirm(),/does not match/);
  await db.query('update public.payment_requests set amount=700 where id=$1',[payment]);
  const paid=(await confirm()).rows[0].id;
  assert.equal((await confirm()).rows[0].id,paid,'duplicate bank callbacks are idempotent');
  assert.equal(Number((await one('select amount from public.pay_advances where id=$1',[paid])).amount),700);
  await assert.rejects(db.query('select public.pay_advance_record_bank_payment($1,$2)',[other,payment]),/Bank confirmation/);
  console.log('PASS: repeat migration, restricted access, India month, installments and paise, draft vs confirmed balances, atomic retries, over-recovery, tenant/worker isolation, immutable history, bank evidence and callback idempotency.');
} finally { await db.close(); }
