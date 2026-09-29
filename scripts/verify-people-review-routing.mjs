import assert from 'node:assert/strict';
import {randomUUID as uuid} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
const company=uuid(),other=uuid(),review=uuid(),station=uuid(),oldUser=uuid(),newUser=uuid(),cm=uuid(),proxy=uuid();
const stage=(id,role,designationId=uuid())=>({reviewerName:role+' person',reviewerRole:role,reviewerUserId:id,personId:uuid(),assignmentId:uuid(),designationId,routingSource:'people'});
const first=stage(cm,'Cluster Manager'),oldHead=stage(oldUser,'National Head'),newHead=stage(newUser,'Head Operations- Last Mile');
try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table companies(id uuid primary key);create table profiles(id uuid primary key,company_id uuid,is_active boolean default true);
 create table stations(id uuid primary key,company_id uuid,station_code text,is_active boolean default true);
 create table ops_performance_reviews(id uuid primary key default gen_random_uuid(),company_id uuid,station_id uuid,station_code text,source_date date,review_type text default 'daily_operations',source_type text,source_batch_id uuid,report_year integer,report_week integer,status text default 'in_review',current_step_order integer default 1,started_by uuid,updated_by uuid,routing_version integer default 2,updated_at timestamptz default now(),closed_at timestamptz);
 create table ops_performance_review_steps(id uuid primary key default gen_random_uuid(),company_id uuid,review_id uuid,step_order integer,reviewer_user_id uuid,reviewer_name text,reviewer_role text,status text default 'pending',completed_at timestamptz,feedback text,bypassed_at timestamptz,proxy_reviewer_user_id uuid,proxy_reviewer_name text,proxy_reason text,proxy_started_at timestamptz,updated_at timestamptz default now(),unique(review_id,step_order));
 create table ops_performance_review_updates(id uuid primary key default gen_random_uuid(),company_id uuid,review_id uuid,update_type text,note text,author_name text,stage_label text,created_at timestamptz default now());
 grant select,insert,update on all tables in schema public to service_role;`);
 await db.exec(readFileSync(new URL('../supabase/migrations/20260928190000_people_review_routing.sql',import.meta.url),'utf8'));
 await db.query('insert into companies values ($1),($2)',[company,other]);
 for(const id of [cm,oldUser,newUser,proxy]) await db.query('insert into profiles(id,company_id) values ($1,$2)',[id,company]);
 await db.query('insert into stations values ($1,$2,$3,true)',[station,company,'TEST']);
 await db.query('insert into ops_performance_reviews(id,company_id,station_id,current_step_order,source_date) values ($1,$2,$3,2,current_date)',[review,company,station]);
 const insert=async(s,order,status='pending')=>db.query('insert into ops_performance_review_steps(company_id,review_id,step_order,reviewer_user_id,reviewer_name,reviewer_role,status) values($1,$2,$3,$4,$5,$6,$7)',[company,review,order,s.reviewerUserId,s.reviewerName,s.reviewerRole,status]);
 await insert(first,1,'completed');await insert(oldHead,2);
 const sync=async(chain,error=null,c=company)=>db.query('select ops_sync_people_review_route($1,$2,$3,$4)',[c,review,JSON.stringify(chain),error]);
 const steps=async()=>(await db.query('select * from ops_performance_review_steps where review_id=$1 order by step_order',[review])).rows;
 const state=async()=>(await db.query('select * from ops_performance_reviews where id=$1',[review])).rows[0];
 const audits=async()=>(await db.query('select * from ops_review_route_changes order by changed_at')).rows;
 await db.exec('set role service_role');
 await sync([first,newHead]);let rows=await steps();
 assert.equal(rows[0].status,'completed');assert.equal(rows[0].reviewer_user_id,cm);
 assert.equal(rows[1].status,'skipped');assert.ok(rows[1].route_superseded_at);assert.equal(rows[2].reviewer_user_id,newUser);
 assert.equal((await state()).current_step_order,3);assert.equal((await audits()).length,1);
 assert.equal((await audits())[0].previous_route[0].reviewer_user_id,oldUser);
 await db.query('update ops_performance_review_steps set proxy_reviewer_user_id=$1,proxy_reviewer_name=$2,proxy_reason=$3,proxy_started_at=now() where id=$4',[proxy,'Proxy manager','Annual leave',rows[2].id]);
 await sync([first,newHead]);assert.equal((await steps())[2].id,rows[2].id);assert.equal((await steps())[2].proxy_reviewer_user_id,proxy);assert.equal((await audits()).length,1,'unchanged sync creates no audit noise');
 await sync([], 'Missing active manager');assert.equal((await state()).routing_error,'Missing active manager');
 await assert.rejects(db.query("update ops_performance_review_steps set status='completed' where id=$1",[rows[2].id]),/Resolve the People/);
 await sync([first,newHead]);assert.equal((await state()).routing_error,null);assert.equal((await steps())[2].id,rows[2].id);
 await assert.rejects(sync([first,newHead],null,other),/unavailable/,'tenant isolation');
 await sync([first]);assert.match((await state()).routing_error,/not automatically closed/);assert.equal((await state()).status,'in_review');
 await sync([first,newHead]);
 const replacement=stage(oldUser,newHead.reviewerRole,newHead.designationId);
 await sync([first,replacement]);rows=await steps();assert.equal(rows.at(-1).proxy_reviewer_user_id,null,'old proxy cannot carry to new person');
 await assert.rejects(db.query("update ops_performance_review_steps set status='completed' where id=$1",[rows[2].id]),/assignment changed/);
 await db.query("update ops_performance_reviews set status='closed' where id=$1",[review]);const auditCount=(await audits()).length;
 await sync([newHead]);assert.equal((await audits()).length,auditCount,'closed history remains untouched');
 await db.exec('set role authenticated');await assert.rejects(sync([newHead]),/permission denied/);
 await db.exec('reset role');
 // Fixed past dates: the fixture review above is dated current_date, and ops_start_people_review
 // reuses an existing review for the same station and date, so a date equal to today would
 // return that fixture instead of creating a new review.
 const started=(await db.query('select ops_start_people_review($1,$2,$3,$4,$5) id',[company,cm,station,JSON.stringify({source_date:'2001-01-01'}),JSON.stringify([first,newHead])])).rows[0].id;
 assert.equal((await db.query('select routing_source from ops_performance_review_steps where review_id=$1',[started])).rows[0].routing_source,'people');
 await db.query("update ops_performance_review_steps set status='skipped',bypassed_at=now() where review_id=$1 and reviewer_user_id=$2",[started,cm]);
 await db.query('select ops_sync_people_review_routes($1,$2)',[company,JSON.stringify([{reviewId:started,chain:[first,newHead],error:null}])]);
 assert.equal((await db.query("select count(*)::int n from ops_performance_review_steps where review_id=$1 and reviewer_user_id=$2 and status='pending'",[started,cm])).rows[0].n,0,'explicit bypass is not recreated');
 await assert.rejects(db.query('select ops_start_people_review($1,$2,$3,$4,$5)',[company,cm,station,JSON.stringify({source_date:'2001-01-02'}),null]),/reporting line/);
 console.log('People review PostgreSQL checks passed: pending reassignment, completed preservation, idempotence, proxy safety, missing mapping, stale completion, tenant isolation, service-only access and new review provenance.');
}finally{await db.close();}
