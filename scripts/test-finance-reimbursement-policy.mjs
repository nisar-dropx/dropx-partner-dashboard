import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

// Real PostgreSQL (WASM), with isolated fixture tables. Never contacts production.
const db = new PGlite();
await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create schema storage;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(bucket_id text,name text);
create table companies(id uuid primary key);
create table profiles(id uuid primary key, company_id uuid, full_name text, is_active boolean);
create table designations(id uuid primary key,company_id uuid,is_active boolean);
create table hr_expense_categories(id uuid primary key default gen_random_uuid(),company_id uuid,code text,name text,description text,receipt_required boolean,receipt_threshold numeric,per_item_limit numeric,per_day_limit numeric,is_active boolean default true,created_by uuid,updated_by uuid,updated_at timestamptz default now());
create table hr_expense_claim_requests(id uuid primary key,company_id uuid,expected_expenses jsonb,status text);
create table hr_expense_policies(id uuid primary key,company_id uuid,payment_head_id uuid,updated_by uuid,updated_at timestamptz default now());
create table hr_expense_items(id uuid primary key,company_id uuid,claim_id uuid,category_id uuid,expense_date date,amount numeric,approved_amount numeric,sort_order int,merchant text,description text);
create table hr_expense_claims(id uuid primary key,company_id uuid,claimant_person_id uuid,claimant_user_id uuid,total_claimed numeric,total_approved numeric,status text,current_step int,payment_request_id uuid);
create table hr_expense_approval_steps(id uuid primary key default gen_random_uuid(),company_id uuid,claim_id uuid,step_order int,step_name text,approver_user_id uuid,status text,decision_note text);
create table hr_expense_events(id uuid primary key default gen_random_uuid(),company_id uuid,claim_id uuid,event_type text,metadata jsonb);
create table hr_engagements(id uuid primary key,company_id uuid,person_id uuid,status text);
create table hr_work_assignments(id uuid primary key,company_id uuid,engagement_id uuid,designation_id uuid,is_primary boolean,effective_from date,effective_to date);
create table hr_user_person_links(company_id uuid,user_id uuid,person_id uuid);
create table payment_heads(id uuid primary key,company_id uuid,is_active boolean,payment_process_role_ids uuid[]);
create table payment_requests(id uuid primary key default gen_random_uuid(),company_id uuid,source_id uuid,source_type text,amount numeric,amount_requested numeric,details jsonb);
`);
await db.exec(readFileSync(new URL('../supabase/migrations/20260914162411_finance_reimbursement_limits.sql', import.meta.url), 'utf8'));
// Both original submission-format variants must preserve mileage quantity after migration.
await db.exec(`create function hr_submit_expense_claim(p_items jsonb) returns void language plpgsql as $$ declare v_item jsonb; begin for v_item in select * from jsonb_array_elements(p_items) loop insert into hr_expense_items(id,description, amount, sort_order) values ((v_item->>'id')::uuid,'fixture',(v_item->>'amount')::numeric,1); end loop; end $$;
create function hr_resubmit_expense_claim(p_items jsonb) returns void language plpgsql as $$ declare v_item jsonb; begin for v_item in select * from jsonb_array_elements(p_items) loop insert into hr_expense_items(id,description,amount,sort_order) values ((v_item->>'id')::uuid,'fixture',(v_item->>'amount')::numeric,1); end loop; end $$;`);
await db.exec(readFileSync(new URL('../supabase/migrations/20260914165600_finance_reimbursement_policy_documents.sql', import.meta.url), 'utf8'));
await db.exec(readFileSync(new URL('../supabase/migrations/20260914170512_finance_reimbursement_eligibility.sql', import.meta.url), 'utf8'));
await db.exec(readFileSync(new URL('../supabase/migrations/20260915082256_finance_expense_request_visibility.sql', import.meta.url), 'utf8'));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const company=id(1), actor=id(2), person=id(3), designation=id(4), head=id(5), engagement=id(6), approver=id(7);
await db.query(`insert into companies values ($1),($2)`,[company,id(100)]);
await db.query(`insert into profiles values ($1,$2,'Finance editor',true),($3,$2,'Special approver',true)`,[actor,company,approver]);
await db.query(`insert into designations values ($1,$2,true),($3,$2,true)`,[designation,company,id(44)]);
await db.query(`insert into hr_expense_categories(id,company_id,code,name,receipt_required,receipt_threshold) values($1,$2,'STAY','Hotel',true,0)`,[head,company]);
await db.query(`insert into hr_engagements values($1,$2,$3,'active')`,[engagement,company,person]);
await db.query(`insert into hr_work_assignments values($1,$2,$3,$4,true,'2026-01-01',null)`,[id(8),company,engagement,designation]);
const item=(n,amount,date='2026-09-14')=>({id:id(n),category_id:head,expense_date:date,amount});
async function quote(items,claim=null) { return (await db.query('select finance_quote_reimbursement($1,$2,$3,$4) as q',[company,person,JSON.stringify(items),claim])).rows[0].q; }
async function save(data,kind='limit') {return (await db.query('select finance_save_reimbursement_master($1,$2,$3,$4) as id',[company,actor,kind,JSON.stringify(data)])).rows[0].id;}
const rule={category_id:head,designation_id:designation,permissible_amount:1000,limit_basis:'per_day',excess_action:'cap',effective_from:'2026-09-01',is_active:true};
assert.equal((await quote([item(10,1200)]))[0].limit_amount,null,'unset is not a zero limit');
const ruleId=await save(rule);
let q=await quote([item(10,600),item(11,600),item(12,800,'2026-09-15')]);
assert.deepEqual(q.map(x=>x.eligible_amount),[600,400,800]);
assert.deepEqual(q.map(x=>x.excess_amount),[0,200,0]);
assert.equal((await quote([item(10,1000)]))[0].excess_amount,0);
await assert.rejects(save({...rule,designation_id:id(999)}),/designation/);
await assert.rejects(save({...rule,category_id:id(999)}),/head/);
await assert.rejects(save({...rule,id:ruleId,expected_updated_at:'2000-01-01'}),/Record changed/);
await assert.rejects(save({...rule,permissible_amount:-1,effective_from:'2026-09-02'}),/check constraint/);

async function claim(n,items,withManager=false) {
  const claimId=id(n);
  await db.exec('begin');
  try {
    await db.query(`insert into hr_expense_claims(id,company_id,claimant_person_id,claimant_user_id,total_claimed,status) values($1,$2,$3,$4,$5,'pending_approval')`,[claimId,company,person,actor,items.reduce((s,i)=>s+i.amount,0)]);
    for (const [index,i] of items.entries()) await db.query('insert into hr_expense_items(id,company_id,claim_id,category_id,expense_date,amount,sort_order,quantity) values($1,$2,$3,$4,$5,$6,$7,$8)',[i.id,company,claimId,i.category_id,i.expense_date,i.amount,index,i.quantity??null]);
    if(withManager) await db.query(`insert into hr_expense_approval_steps(company_id,claim_id,step_order,step_name,approver_user_id,status) values($1,$2,1,'Manager',$3,'pending')`,[company,claimId,approver]);
    await db.query(`insert into hr_expense_events(company_id,claim_id,event_type) values($1,$2,'submitted')`,[company,claimId]);
    await db.exec('commit'); return claimId;
  } catch(error) { await db.exec('rollback'); throw error; }
}
const c=await claim(20,[item(21,800)]);
q=await quote([item(23,600)]);
assert.equal(q[0].eligible_amount,200,'another claim reserves the daily allowance');
assert.equal((await quote([item(21,800)],c))[0].eligible_amount,800,'returned claim excludes its own lines');
await db.query(`update hr_expense_claims set status='rejected' where id=$1`,[c]);
assert.equal((await quote([item(23,600)]))[0].eligible_amount,600,'rejected claim releases allowance');
const capped=await claim(30,[item(31,1200)]);
const payment=await db.query(`insert into payment_requests(company_id,source_id,source_type,amount,amount_requested) values($1,$2,'employee_reimbursement',1200,1200) returning *`,[company,capped]);
assert.equal(Number(payment.rows[0].amount),1000);
assert.equal(Number(payment.rows[0].amount_requested),1200,'claimed bill preserved');
await assert.rejects(db.query('update payment_requests set amount=1200 where id=$1',[payment.rows[0].id]),/cannot exceed/);
await assert.rejects(db.query('update payment_requests set amount=null where id=$1',[payment.rows[0].id]),/cannot exceed/);
await assert.rejects(claim(32,[item(33,500)]),/allowance is already used/);
await db.query(`update hr_expense_claims set status='approved_for_payment',payment_request_id=$2,total_approved=1200 where id=$1`,[capped,payment.rows[0].id]);
assert.equal(Number((await db.query('select total_approved from hr_expense_claims where id=$1',[capped])).rows[0].total_approved),1000);

await save({...rule,excess_action:'special_approval',special_approver_user_id:approver,effective_from:'2026-09-16'});
const special=await claim(40,[item(41,1300,'2026-09-16')],true);
let steps=(await db.query('select * from hr_expense_approval_steps where claim_id=$1 order by step_order',[special])).rows;
assert.equal(steps.length,2); assert.equal(steps[1].is_policy_exception,true); assert.equal(steps[1].status,'waiting');
await db.query(`update hr_expense_approval_steps set status='skipped' where id=$1`,[steps[1].id]);
assert.equal((await db.query('select status from hr_expense_approval_steps where id=$1',[steps[1].id])).rows[0].status,'waiting','senior-manager skip cannot bypass excess step');
await assert.rejects(db.query(`insert into payment_requests(company_id,source_id,source_type,amount) values($1,$2,'employee_reimbursement',1300)`,[company,special]),/special approval/);
await assert.rejects(db.query(`update hr_expense_approval_steps set status='approved' where id=$1`,[steps[1].id]),/short reason/);
await db.query(`update hr_expense_approval_steps set status='approved',decision_note='Approved exceptional hotel cost' where claim_id=$1`,[special]);
const paid=await db.query(`insert into payment_requests(company_id,source_id,source_type,amount) values($1,$2,'employee_reimbursement',1300) returning amount`,[company,special]);
assert.equal(Number(paid.rows[0].amount),1300);
await save({...rule,excess_action:'special_approval',special_approver_user_id:actor,effective_from:'2026-09-17'});
await assert.rejects(claim(50,[item(51,1300,'2026-09-17')]),/independent special approver/);
assert.equal((await db.query('select count(*)::int as n from hr_expense_claims where id=$1',[id(50)])).rows[0].n,0,'failed routing rolls back entire claim');
const savedSnapshot=(await db.query('select finance_policy_snapshot from hr_expense_items where id=$1',[id(31)])).rows[0].finance_policy_snapshot;
await save({...rule,permissible_amount:2000,effective_from:'2026-09-18'});
assert.deepEqual((await db.query('select finance_policy_snapshot from hr_expense_items where id=$1',[id(31)])).rows[0].finance_policy_snapshot,savedSnapshot);
await save({...rule,limit_basis:'per_item',effective_from:'2026-09-19'});
assert.deepEqual((await quote([item(60,1200,'2026-09-19'),item(61,1200,'2026-09-19')])).map(x=>x.eligible_amount),[1000,1000]);
await save({...rule,is_active:false,effective_from:'2026-09-20'});
assert.equal((await quote([item(62,1200,'2026-09-20')]))[0].limit_amount,null,'disabled latest revision does not use an older rate');
assert.equal((await quote([item(63,1200,'2026-08-31')]))[0].limit_amount,null,'future rates do not apply before their effective date');
const inactiveHead=await save({code:'PARKING',name:'Parking',receipt_required:false,receipt_threshold:0,is_active:false},'head');
assert.equal((await db.query('select is_active from hr_expense_categories where id=$1',[inactiveHead])).rows[0].is_active,false);
await assert.rejects(quote([{...item(64,100),category_id:inactiveHead}]),/inactive/);
await save({...rule,limit_basis:'per_km',permissible_amount:3.25,effective_from:'2026-09-21',policy_note:'Fixture mileage rate'});
q=await quote([{...item(65,500,'2026-09-21'),quantity:100.5}]);
assert.equal(q[0].eligible_amount,326.63); assert.equal(q[0].policy_note,'Fixture mileage rate');
assert.equal((await quote([item(66,500,'2026-09-21')]))[0].quantity_required,true);
await assert.rejects(claim(67,[item(68,500,'2026-09-21')]),/distance/);
await assert.rejects(quote([{...item(69,500,'2026-09-21'),quantity:-1}]),/distance/);
const mileageClaim=await claim(70,[{...item(71,500,'2026-09-21'),quantity:100.5}]);
assert.equal(Number((await db.query('select finance_policy_snapshot from hr_expense_items where claim_id=$1',[mileageClaim])).rows[0].finance_policy_snapshot.eligible_amount),326.63);
for(const [rpc,n] of [['hr_submit_expense_claim',72],['hr_resubmit_expense_claim',73]]) {
 await db.query(`select ${rpc}($1)`,[JSON.stringify([{id:id(n),amount:120,quantity:40}])]);
 assert.equal(Number((await db.query('select quantity from hr_expense_items where id=$1',[id(n)])).rows[0].quantity),40);
}
await save({...rule,limit_basis:'not_allowed',permissible_amount:0,effective_from:'2026-09-22'});
assert.equal((await quote([item(75,100,'2026-09-22')]))[0].expense_allowed,false);
await assert.rejects(claim(76,[item(77,100,'2026-09-22')]),/not eligible/);
const doc={id:id(80),title:'Fixture travel policy',version_label:'1',effective_from:'2026-01-01',file_name:'policy.pdf',storage_path:`${company}/${id(80)}.pdf`,file_size:100,sha256:'a'.repeat(64)};
async function publish(d,expected=null){return db.query('select finance_publish_reimbursement_document($1,$2,$3,$4)',[company,actor,expected,JSON.stringify(d)]);}
await assert.rejects(publish(doc),/not found/);
await db.query('insert into storage.objects values($1,$2)',['finance-reimbursement-policies',doc.storage_path]);
await publish(doc); await publish(doc);
const doc2={...doc,id:id(81),version_label:'2',storage_path:`${company}/${id(81)}.pdf`};
await db.query('insert into storage.objects values($1,$2)',['finance-reimbursement-policies',doc2.storage_path]);
await assert.rejects(publish(doc2),/changed/);
await publish(doc2,doc.id);
assert.equal((await db.query('select id from finance_reimbursement_documents where is_current')).rows[0].id,doc2.id);
assert.equal((await db.query('select count(*)::int as n from finance_reimbursement_documents')).rows[0].n,2);
// Visibility is independent of claim eligibility, persisted with optimistic locking and audit.
const requestHead=await save({code:'TEST_TRAVEL',name:'Travel estimate',receipt_required:false,receipt_threshold:0,is_active:true,show_in_expense_requests:true},'head');
const headRow=async()=> (await db.query('select to_jsonb(t) row from hr_expense_categories t where id=$1',[requestHead])).rows[0].row;
const headEdit=async(changes)=>{const row=await headRow();return save({...row,expected_updated_at:row.updated_at,...changes},'head');};
const estimate=async(n,category=requestHead,companyId=company)=>db.query(`insert into hr_expense_claim_requests values($1,$2,$3,'pending')`,[id(n),companyId,JSON.stringify({[category]:100})]);
await estimate(300);
await headEdit({show_in_expense_requests:false});
assert.equal((await headRow()).show_in_expense_requests,false);
await assert.rejects(estimate(301),/categories have changed/);
await db.query("update hr_expense_claim_requests set status='withdrawn' where id=$1",[id(300)]);
assert.equal(Number((await db.query('select expected_expenses from hr_expense_claim_requests where id=$1',[id(300)])).rows[0].expected_expenses[requestHead]),100,'historic estimates are preserved');
await assert.rejects(db.query('update hr_expense_claim_requests set expected_expenses=$2 where id=$1',[id(300),JSON.stringify({[requestHead]:200})]),/categories have changed/);
const oldClientPayload=await headRow(); delete oldClientPayload.show_in_expense_requests;
await save({...oldClientPayload,name:'Updated travel label',expected_updated_at:oldClientPayload.updated_at},'head');
assert.equal((await headRow()).show_in_expense_requests,false,'omitting visibility preserves the setting for old master clients');
assert.equal((await quote([{...item(305,100),category_id:requestHead}]))[0].category_id,requestHead,'hidden estimate heads remain claimable');
await headEdit({show_in_expense_requests:true});
await estimate(306);
await assert.rejects(estimate(307,requestHead,id(100)),/categories have changed/);
await headEdit({is_active:false});
await assert.rejects(estimate(308),/categories have changed/);
assert((await db.query("select count(*)::int n from finance_reimbursement_audit where record_id=$1 and after_value->>'show_in_expense_requests'='false'",[requestHead])).rows[0].n>0);
await db.exec('set role anon');
await assert.rejects(db.query('select * from finance_reimbursement_limits'),/permission denied/);
await assert.rejects(db.query('select * from finance_reimbursement_documents'),/permission denied/);
await assert.rejects(publish(doc),/permission denied/);
await assert.rejects(db.query('select finance_quote_reimbursement($1,$2,$3)',[company,person,'[]']),/permission denied/);
await db.exec('reset role');
await db.close();
console.log('PASS: missing policy, caps, dates, split claims, payment ceiling, special approval, no self approval, atomic rollback, immutable history, tenant validation, optimistic edits and anonymous access.');
