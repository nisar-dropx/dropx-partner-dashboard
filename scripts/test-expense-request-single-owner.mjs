import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

// Isolated PostgreSQL fixture. No production credentials or requests are used.
const db = new PGlite();
await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
alter default privileges revoke execute on functions from public;
alter default privileges grant execute on functions to service_role;
create table profiles(id uuid primary key,company_id uuid,is_active boolean);
create table stations(id uuid primary key,company_id uuid,is_active boolean);
create table hr_expense_claim_requests(
 id uuid primary key,company_id uuid,request_no text,worker_type text,employee_id uuid,contractor_id uuid,
 claimant_person_id uuid,claimant_user_id uuid,assignment_id uuid,location_id uuid,designation_id uuid,
 purpose text,purpose_code text,estimated_amount numeric,trip_from date,trip_to date,notes text,
 visit_station_ids uuid[],expected_expenses jsonb,status text,decided_by uuid,decided_at timestamptz,
 decision_note text,updated_at timestamptz default now());
create table hr_expense_claim_request_assignees(
 id uuid primary key default gen_random_uuid(),company_id uuid,request_id uuid,approver_user_id uuid,
 approver_person_id uuid,assignee_role text,status text,decision_note text,decided_at timestamptz,
 updated_at timestamptz default now(),unique(company_id,request_id,approver_user_id));
`);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const company=id(1), manager=id(2), partner=id(3), outsider=id(4);
await db.query('insert into profiles values ($1,$2,true),($3,$2,true),($4,$5,true)',[manager,company,partner,outsider,id(99)]);
await db.query(`insert into hr_expense_claim_requests(id,company_id,status,decided_by) values ($1,$2,'pending',null),($3,$2,'approved',$4)`,[id(10),company,id(11),partner]);
for (const request of [id(10),id(11)]) for (const [actor,role] of [[manager,'reporting_manager'],[partner,'managing_partner']]) {
  await db.query('insert into hr_expense_claim_request_assignees(company_id,request_id,approver_user_id,assignee_role,status) values($1,$2,$3,$4,$5)',[company,request,actor,role,request===id(11)&&actor===partner?'approved':'pending']);
}
const historicalBefore=(await db.query('select * from hr_expense_claim_request_assignees where request_id=$1 order by id',[id(11)])).rows;
const migration=readFileSync(new URL('../supabase/migrations/20260924180804_expense_request_single_owner.sql',import.meta.url),'utf8');
await db.exec(migration);
assert.deepEqual((await db.query('select * from hr_expense_claim_request_assignees where request_id=$1 order by id',[id(11)])).rows,historicalBefore,'completed decisions/history are untouched');
assert.deepEqual((await db.query(`select approver_user_id from hr_expense_claim_request_assignees where request_id=$1 and status='pending'`,[id(10)])).rows,[{approver_user_id:manager}]);
const removed=(await db.query(`select status,decided_at,decision_note from hr_expense_claim_request_assignees where request_id=$1 and approver_user_id=$2`,[id(10),partner])).rows[0];
assert.equal(removed.status,'skipped'); assert.equal(removed.decided_at,null); assert.match(removed.decision_note,/Routing correction/);
const assignees=(owner=manager)=>[{approver_user_id:owner,assignee_role:'reporting_manager'},{approver_user_id:partner,assignee_role:'managing_partner'}];
async function submit(n,owners=assignees()) {
  return db.query(`select hr_submit_expense_claim_request($1,$2,'employee',$3,$4,$5,null,null,null,'Station visit',1250,'2026-09-25','2026-09-26',null,$6::jsonb)`,[company,id(n),id(5),id(6),id(7),JSON.stringify(owners)]);
}
await submit(20);
assert.deepEqual((await db.query('select approver_user_id,assignee_role from hr_expense_claim_request_assignees where request_id=$1',[id(20)])).rows,[{approver_user_id:manager,assignee_role:'reporting_manager'}],'old multi-owner payload normalizes to one manager');
await assert.rejects(submit(21,[]),/approver is required/);
await assert.rejects(submit(21,[{approver_user_id:partner,assignee_role:'managing_partner'}]),/Exactly one/);
await assert.rejects(submit(21,[...assignees(),{approver_user_id:partner,assignee_role:'reporting_manager'}]),/Exactly one/);
await assert.rejects(submit(21,assignees(outsider)),/active login in this company/);
await db.query('update profiles set is_active=false where id=$1',[manager]);
await assert.rejects(submit(21),/active login/);
await db.query('update profiles set is_active=true where id=$1',[manager]);
const decide=(actor,action='approved',note=null,request=id(20),tenant=company)=>db.query('select * from hr_decide_expense_claim_request($1,$2,$3,$4,$5)',[tenant,request,actor,action,note]);
await assert.rejects(decide(partner),/another approver/);
await assert.rejects(decide(manager,'approved',null,id(20),id(99)),/no longer awaiting/);
await assert.rejects(decide(manager,'rejected',''),/reason is required/);
await decide(manager);
assert.equal((await db.query('select decided_by from hr_expense_claim_requests where id=$1',[id(20)])).rows[0].decided_by,manager);
await assert.rejects(decide(manager),/no longer awaiting/);
await submit(22);
await decide(manager,'rejected','Duplicate request',id(22));
assert.equal((await db.query('select status from hr_expense_claim_requests where id=$1',[id(22)])).rows[0].status,'rejected');
// Simulate a stale legacy fallback assignment: the RPC itself must still deny it.
await db.query(`insert into hr_expense_claim_request_assignees(company_id,request_id,approver_user_id,assignee_role,status) values($1,$2,$3,'managing_partner','pending')`,[company,id(10),id(8)]);
await assert.rejects(decide(id(8),'approved',null,id(10)),/another approver/);
const acl=(await db.query(`select proname,prosecdef,has_function_privilege('anon',oid,'execute') as anon,has_function_privilege('authenticated',oid,'execute') as authenticated from pg_proc where proname in ('hr_submit_expense_claim_request','hr_decide_expense_claim_request')`)).rows;
assert.ok(acl.every(row=>!row.prosecdef&&!row.anon&&!row.authenticated),'RPC stays service-role only without definer privileges');
await db.close();
console.log('PASS: single manager, legacy backfill, preserved history, inactive/cross-company/parallel approver denial, decisions and ACL');
