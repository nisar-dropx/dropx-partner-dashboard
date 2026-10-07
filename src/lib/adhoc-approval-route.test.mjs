import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const migration=readFileSync(new URL('../../supabase/migrations/20261007110000_preserve_adhoc_approval_route.sql',import.meta.url),'utf8');
const fleet='11111111-1111-1111-1111-111111111111',business='22222222-2222-2222-2222-222222222222',cluster='33333333-3333-3333-3333-333333333333';
test('reason-specific routing survives general master changes without skipping its approvals',async()=>{
 const db=new PGlite();
 await db.exec(`create role anon; create role authenticated; create table payment_requests(id int primary key,status text,approval_status text,current_step_order int,total_steps int,current_approver_user_id uuid,current_approver_role_id uuid,current_approver_role_ids uuid[],adhoc_approval_steps jsonb);`);
 await db.exec(migration);
 const steps=[{step_order:1,candidates:[{role_id:fleet,scope:'company'}]},{step_order:2,candidates:[{role_id:business,scope:'company'}]}];
 await db.query(`insert into payment_requests values(1,'pending','PENDING',1,4,null,$1,array[$1]::uuid[],$2::jsonb)`,[fleet,JSON.stringify(steps)]);
 assert.equal((await db.query('select total_steps from payment_requests')).rows[0].total_steps,2);
 await assert.rejects(db.query('update payment_requests set current_approver_role_id=$1,current_approver_role_ids=array[$1]::uuid[]',[cluster]),/Ad Hoc Reason/);
 await assert.rejects(db.query('update payment_requests set current_approver_role_ids=array[$1]::uuid[]',[cluster]),/Ad Hoc Reason/);
 await assert.rejects(db.exec('update payment_requests set current_step_order=3'),/approval stage/);
 await db.exec('update payment_requests set total_steps=9');
 assert.equal((await db.query('select total_steps from payment_requests')).rows[0].total_steps,2);
 await db.query(`update payment_requests set current_step_order=2,current_approver_role_id=$1,current_approver_role_ids=array[$1]::uuid[],approval_status='FLEET_APPROVED'`,[business]);
 await db.exec("update payment_requests set status='approved',approval_status='FINAL_APPROVED',current_approver_role_id=null,current_approver_role_ids='{}'");
 // Processor returns are not reinterpreted as pending business approvals.
 await db.query(`update payment_requests set status='resubmitted',approval_status='RE_APPROVED',current_step_order=3,current_approver_role_id=$1`,[cluster]);
 await db.query(`insert into payment_requests values(2,'pending','PENDING',1,2,null,$1,array[$1]::uuid[],null)`,[cluster]);
 assert.equal((await db.query('select count(*)::int as n from payment_requests')).rows[0].n,2);
 await db.close();
});
