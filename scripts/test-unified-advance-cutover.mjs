import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const db=new PGlite();
const migration=await readFile('supabase/migrations/20261029115529_unified_advance_cutover.sql','utf8');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const c=id(1),w=id(2),employee=id(3),station=id(4),run=id(5),legacy=id(6),paid=id(7),unpaid=id(8),person=id(9),payment=id(10);
const one=async(sql,args=[])=> (await db.query(sql,args)).rows[0];
try {
 await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
 await db.exec(await readFile('scripts/fixtures/unified-advance-legacy-schema.sql','utf8'));
 // Existing retired interfaces: only signatures are needed to verify revocation.
 for(const signature of migration.matchAll(/public\.(workforce_apply_advance_recoveries|workforce_reassign_advance|workforce_apply_advance_import|hr_create_pay_advance_request|hr_record_pay_advance_recovery|hr_sync_external_pay_advance)\(([^)]+)\)/g))
   await db.exec('create or replace function public.'+signature[1]+'('+signature[2]+') returns void language plpgsql as $$begin return;end$$;');
 await db.exec(await readFile('supabase/migrations/20261029115517_unified_paid_advance_ledger.sql','utf8'));
 await db.exec(`
 create function public.enqueue_workforce_payout_dependency_refresh(uuid,uuid,uuid,date,date,uuid) returns integer language sql as $$select 0$$;
 insert into companies(id) values('${c}');
 insert into workforce(id,company_id,full_name,dropx_id,location_id,is_active) values('${w}','${c}','Test workforce','W1','${station}',true);
 insert into employees(id,company_id,full_name,employee_code,location_id,is_active) values('${employee}','${c}','Test employee','E1','${station}',true);
 insert into workforce_advances(id,company_id,workforce_id,station_id,advance_date,amount,source_type) values('${legacy}','${c}','${w}','${station}','2026-09-01',500,'bulk_import');
 insert into workforce_advance_recoveries(company_id,advance_id,workforce_id,period_start,period_end,amount,status) values('${c}','${legacy}','${w}','2026-09-01','2026-09-30',500,'deducted');
 insert into payment_requests(id,company_id,source_type,source_id,amount,bank_status,utr_cin) values('${payment}','${c}','pay_advance','${paid}',1000,'Paid','TEST-UTR');
 insert into hr_pay_advance_requests(id,company_id,worker_type,worker_id,requested_amount,approved_amount,status,payment_request_id,disbursed_at,recovery_mode,requested_installments) values
 ('${paid}','${c}','employee','${employee}',1000,1000,'disbursed','${payment}','2026-10-01','one_time',1),
 ('${unpaid}','${c}','employee','${employee}',400,400,'approved',null,null,'one_time',1);
 insert into hr_payroll_runs(id,company_id,period_start,period_end,status) values('${run}','${c}','2026-10-01','2026-10-31','calculated');
 insert into hr_payroll_run_people(id,company_id,run_id,worker_type,worker_id,calculation_status) values('${person}','${c}','${run}','employee','${employee}','ready');
 insert into hr_payroll_run_manual_entries(company_id,run_id,worker_type,worker_id,advance_amount) values('${c}','${run}','employee','${employee}',250);
 insert into hr_pay_advance_recoveries(id,company_id,request_id,due_period,scheduled_amount,status) values
 ('${id(11)}','${c}','${paid}','2026-10-01',1000,'scheduled'),('${id(12)}','${c}','${unpaid}','2026-10-01',400,'scheduled');
 insert into hr_payroll_run_items(company_id,run_person_id,code,amount,source,metadata) values
 ('${c}','${person}','PAY_ADVANCE_RECOVERY',1400,'pay_advance','{"recovery_ids":["${id(11)}","${id(12)}"]}'),
 ('${c}','${person}','MANUAL_ADVANCE',250,'manual','{}');
 `);
 await db.exec(migration);
 await db.exec(migration);
 assert.equal((await one('select count(*)::int n from pay_advances')).n,2,'only paid principal is migrated');
 assert.equal(Number((await one("select sum(amount) n from pay_advance_deductions where status='confirmed'")).n),500,'historical workforce recovery retained');
 assert.equal(Number((await one("select sum(amount) n from pay_advance_deductions where status='reserved'")).n),1000,'unpaid scheduled advance excluded');
 assert.equal(Number((await one('select advance_amount from hr_payroll_run_manual_entries')).advance_amount),250,'manual deduction unchanged');
 await assert.rejects(db.exec('update hr_payroll_run_manual_entries set advance_amount=300'),/Manual advances are retired/);
 // New bank confirmation creates a single principal; a retry creates no second advance.
 await db.exec(`insert into hr_pay_advance_requests(id,company_id,worker_type,worker_id,requested_amount,approved_amount,status,payment_request_id,recovery_mode,requested_installments)
 values('${id(13)}','${c}','workforce','${w}',600,600,'approved','${id(14)}','one_time',1);
 insert into payment_requests(id,company_id,source_type,source_id,amount,bank_status,utr_cin) values('${id(14)}','${c}','pay_advance','${id(13)}',600,'Paid','NEW-UTR');`);
 await db.exec(`select hr_mark_pay_advance_disbursed('${c}','${id(13)}',null,'ignored',null); select hr_mark_pay_advance_disbursed('${c}','${id(13)}',null,'ignored',null);`);
 const newAdvance=(await one('select id,first_due_period::text period from pay_advances where request_id=$1',[id(13)]));
 assert.equal((await one('select count(*)::int n from pay_advances')).n,3);
 const snapshot={worksheet:{deduction_breakdown:[{code:'ADVANCE_RECOVERY',recoveryKey:`ADVANCE:${newAdvance.id}`,amount:600}]}};
 await db.query(`insert into workforce_payout_publications(company_id,workforce_id,station_id,period_start,period_end,revision,publication_kind,snapshot) values($1,$2,$3,$4,($4::date+interval '1 month - 1 day')::date,1,'worksheet',$5)`,[c,w,station,newAdvance.period,JSON.stringify(snapshot)]);
 assert.equal(Number((await one('select amount from pay_advance_deductions where advance_id=$1',[newAdvance.id])).amount),600);
 await db.query(`insert into workforce_payout_payment_items(company_id,workforce_id,period_start,status,instruction_amount) values($1,$2,$3,'paid',2000)`,[c,w,newAdvance.period]);
 assert.equal((await one('select status from hr_pay_advance_requests where id=$1',[id(13)])).status,'recovered');
 // Save a refreshed People snapshot, then bank-settle it without creating another deduction.
 const payload=[{client_key:'employee:'+employee,worker_type:'employee',worker_id:employee,worker_name:'Test employee',net_pay:4000,other_deductions:1000,calculation_status:'ready',items:[{code:'ADVANCE_RECOVERY',name:'Advance deduction',item_type:'deduction',amount:1000,source:'unified_advance',metadata:{advance_id:paid}}]}];
 await db.query('select hr_replace_payroll_run_snapshot($1,$2,$3,$4,$5,$6,$7,$8)',[c,run,'2026-10-01','2026-10-29',JSON.stringify(payload),'{}','[]',null]);
 await db.query(`insert into hr_payroll_bank_lines(company_id,run_id,worker_type,worker_id,status,amount) values($1,$2,'employee',$3,'paid',4000)`,[c,run,employee]);
 assert.equal((await one('select status from hr_pay_advance_requests where id=$1',[paid])).status,'recovered');
 assert.equal(Number((await one('select recovered_amount from hr_pay_advance_requests where id=$1',[unpaid])).recovered_amount),0);
 // A recovered advance permits another profile request; an unpaid request blocks duplicates.
 const steps=JSON.stringify([{step_type:'manager',approver_user_id:id(50)},{step_type:'finance',approver_user_id:id(51)}]);
 const createSql='select hr_create_pay_advance_request_v2($1,$2,$3,500,$4,1,$5,null,$6,$7,4000,25,1000,null) id';
 const args=[c,'workforce',w,'one_time','A second advance request',id(50),steps];
 const requested=(await one(createSql,args)).id;
 assert.equal((await one('select external_source from hr_pay_advance_requests where id=$1',[requested])).external_source,'one_app');
 await assert.rejects(db.query(createSql,args),/already awaiting approval/);
 await db.query('select hr_cancel_pay_advance_request($1,$2)',[c,requested]);
 await assert.rejects(db.query(createSql,[...args.slice(0,3),'manual',...args.slice(4)]),/Invalid recovery method/);
 // Exercise the existing bank-response trigger, including retry and missing UTR.
 await db.exec('create trigger test_bank_confirmation after update on payment_requests for each row execute function hr_sync_expense_payment_status()');
 await db.exec(`insert into payment_requests(id,company_id,source_type,source_id,amount,bank_status) values('${id(60)}','${c}','pay_advance','${unpaid}',400,'Processing');
 update hr_pay_advance_requests set payment_request_id='${id(60)}' where id='${unpaid}';
 update payment_requests set bank_status='Paid' where id='${id(60)}';`);
 assert.equal((await one('select count(*)::int n from pay_advances where request_id=$1',[unpaid])).n,0);
 await db.exec(`update payment_requests set utr_cin='TRIGGER-UTR' where id='${id(60)}'; update payment_requests set utr_cin='TRIGGER-UTR' where id='${id(60)}';`);
 assert.equal((await one('select count(*)::int n from pay_advances where request_id=$1',[unpaid])).n,1);
 console.log('PASS: repeatable cutover, paid-only history, manual preservation, repeat requests, bank trigger idempotency and People/Workforce settlement.');
} catch(e) {console.error({message:e.message,detail:e.detail,where:e.where,position:e.position});process.exitCode=1;}
finally {await db.close();}
