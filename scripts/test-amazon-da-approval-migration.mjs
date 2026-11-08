import {PGlite} from '@electric-sql/pglite';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const db=new PGlite();
await db.exec(`create role anon;create role authenticated;create role service_role;
create table companies(id uuid primary key);create table stations(id uuid primary key,company_id uuid,is_active boolean);
create table profiles(id uuid primary key,company_id uuid,is_active boolean,full_name text,email text,role_id uuid);
create table user_roles(id uuid,company_id uuid,is_active boolean,name text);
create table company_product_memberships(user_id uuid,company_id uuid,is_active boolean,product_code text,role_id uuid);
create table hr_user_person_links(user_id uuid,company_id uuid,person_id uuid,status text);
create table hr_engagements(id uuid,company_id uuid,person_id uuid,status text);
create table hr_work_assignments(id uuid,company_id uuid,engagement_id uuid,designation_id uuid,is_primary boolean,effective_from date,effective_to date);
create table designations(id uuid,name text,is_active boolean);`);
await db.exec(fs.readFileSync('supabase/migrations/20261108101331_amazon_da_desk_audit.sql','utf8'));
const sql=fs.readFileSync('supabase/migrations/20261108133039_amazon_da_approval_gate.sql','utf8');
await db.exec(sql);
const company='00000000-0000-4000-8000-000000000001',station='00000000-0000-4000-8000-000000000002',actor='00000000-0000-4000-8000-000000000003',reviewer='00000000-0000-4000-8000-000000000004',role='00000000-0000-4000-8000-000000000005';
await db.query('insert into companies values($1)',[company]);await db.query('insert into stations values($1,$2,true)',[station,company]);
await db.query("insert into user_roles values($1,$2,true,'Finance Manager')",[role,company]);
await db.query("insert into profiles values($1,$3,true,'Station','station@example.com',null),($2,$3,true,'Reviewer','reviewer@example.com',$4)",[actor,reviewer,company,role]);
async function insert(id,status='pending_approval',action='OFFBOARD') {return db.query(`insert into amazon_da_commands(id,company_id,station_id,provider_id,associate_name,actor_id,actor_name,actor_role,action,reason_code,remarks,expected_status,status)
 values($1,$2,$3,'amzn1.flex.provider.v1.00000000-0000-4000-8000-000000000099','Associate',$4,'Station','Station manager',$5,'REASON','Employee requested exit','ACTIVE',$6)`,[id,company,station,actor,action,status]);}
const id='00000000-0000-4000-8000-000000000010';
await assert.rejects(insert(id,'queued'),/must start awaiting approval/);
await insert(id);
await assert.rejects(insert('00000000-0000-4000-8000-000000000011'),/duplicate key/);
await assert.rejects(db.query("update amazon_da_commands set status='checking' where id=$1",[id]),/reviewer/);
async function review(user,decision='approved'){return db.query(`update amazon_da_commands set status=$3,reviewed_by=$2,reviewed_at=now(),review_decision=$4,review_remarks='Checked current records',reviewer_name='Forged'
 where id=$1 and status='pending_approval' returning *`,[id,user,decision==='approved'?'queued':'rejected',decision]);}
await assert.rejects(review(actor),/reviewer/);
let result=await review(reviewer);assert.equal(result.rows[0].reviewer_name,'Reviewer');assert.equal(result.rows[0].reviewer_role,'Finance Manager');
assert.equal((await review(reviewer)).rows.length,0,'Concurrent/repeated review cannot transition a decided request');
await assert.rejects(db.query("update amazon_da_commands set status='checking',review_remarks='Changed' where id=$1",[id]),/immutable/);
for(const state of ['checking','sending','confirmed'])await db.query('update amazon_da_commands set status=$2 where id=$1',[id,state]);
assert.equal((await db.query('select count(*)::int n from amazon_da_command_events where command_id=$1',[id])).rows[0].n,5);
assert.match((await db.query("select message from amazon_da_command_events where command_id=$1 and status='queued'",[id])).rows[0].message,/approved by Reviewer/);
const reject='00000000-0000-4000-8000-000000000012';await insert(reject);
await db.query("update amazon_da_commands set status='rejected',reviewed_by=$2,reviewed_at=now(),review_decision='rejected',review_remarks='Wrong associate' where id=$1",[reject,reviewer]);
await assert.rejects(db.query("update amazon_da_commands set status='queued' where id=$1",[reject]),/Invalid/);
assert.equal((await db.query("select has_function_privilege('authenticated','amazon_da_reviewer_role(uuid,uuid)','execute') allowed")).rows[0].allowed,false);
assert.equal((await db.query("select has_table_privilege('authenticated','amazon_da_commands','insert') allowed")).rows[0].allowed,false);
await db.query('update profiles set is_active=false where id=$1',[reviewer]);
assert.equal((await db.query('select amazon_da_reviewer_role($1,$2) role',[company,reviewer])).rows[0].role,null);
await db.close();console.log('Amazon approval database: real provider ID, approval gate, trusted reviewer, immutable decision, rejection, uniqueness, audit and client privilege checks passed.');
