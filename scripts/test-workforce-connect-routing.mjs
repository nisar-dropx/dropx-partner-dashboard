import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

// Fully isolated database: no real messages, notifications or personnel changes.
const db=new PGlite();
await db.exec(`
create role anon; create role authenticated; create role service_role;
create table public.profiles(id uuid primary key, company_id uuid,is_active boolean);
create table public.communication_cases(id uuid primary key,company_id uuid,case_number text,channel text,category text,subject text,description text,urgency text,status text,identity_protected boolean default false,origin text,assigned_profile_id uuid,reward_status text,due_at timestamptz,acknowledged_at timestamptz,resolved_at timestamptz,last_activity_at timestamptz,created_at timestamptz default now(),updated_at timestamptz);
create table public.communication_case_reporters(case_id uuid primary key,company_id uuid,reporter_profile_type text,reporter_account_id uuid);
create table public.workforce(id uuid,company_id uuid,full_name text,dropx_id text,designation text,location_id uuid);
create table public.helpers(like public.workforce); create table public.vendors(like public.workforce);
create table public.communication_case_messages(id uuid default gen_random_uuid(),case_id uuid,company_id uuid,author_kind text,visibility text,body text,actor_profile_id uuid);
create table public.communication_case_events(id uuid default gen_random_uuid(),case_id uuid,company_id uuid,event_type text,from_status text,to_status text,actor_profile_id uuid);
create table public.mob_app_notifications(id uuid default gen_random_uuid(),company_id uuid,recipient_profile_type text,recipient_account_id uuid,event_code text,source_key text,title text,body text,route text,data jsonb,push_status text);
create table public.people_web_notifications(id uuid default gen_random_uuid(),company_id uuid,event_code text,data jsonb);
`);
await db.exec(readFileSync(new URL('../supabase/migrations/20261030155644_workforce_connect_routing.sql',import.meta.url),'utf8'));
const co='11111111-1111-4111-8111-111111111111',other='99999999-9999-4999-8999-999999999999',actor='22222222-2222-4222-8222-222222222222',worker='33333333-3333-4333-8333-333333333333',station='44444444-4444-4444-8444-444444444444';
const ids=['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc'];
await db.query('insert into profiles values($1,$2,true)',[actor,co]);
await db.query('insert into workforce values($1,$2,$3,$4,$5,$6)',[worker,co,'Test worker','DF-TEST','Wish Master',station]);
for(const [index,type] of ['workforce','employee','workforce'].entries()){
  await db.query(`insert into communication_cases(id,company_id,case_number,channel,status,identity_protected) values($1,$2,$3,$4,'submitted',$5)`,[ids[index],co,`CASE-${index}`,index===2?'integrity':'connect',index===2]);
  await db.query('insert into communication_case_reporters values($1,$2,$3,$4)',[ids[index],co,type,worker]);
  await db.query(`insert into people_web_notifications(company_id,event_code,data) values($1,'communication_case_submitted',$2)`,[co,JSON.stringify({caseId:ids[index]})]);
}
assert.equal((await db.query('select * from workforce_connect_cases')).rows.length,2);
assert.equal((await db.query('select * from people_connect_cases')).rows.length,1);
assert.equal((await db.query('select * from people_scoped_web_notifications')).rows.length,1);
const protectedCase=(await db.query('select * from workforce_connect_cases where id=$1',[ids[2]])).rows[0];
assert.equal(protectedCase.reporter_name,'Confidential reporter');assert.equal(protectedCase.location_id,null);assert.equal(protectedCase.reporter_code,null);assert.equal(protectedCase.reporter_designation,null);
assert.equal((await db.query('select * from workforce_connect_cases where location_id=$1',[station])).rows.length,1);
for(const role of ['anon','authenticated']){
  assert.equal((await db.query(`select has_table_privilege($1,'public.workforce_connect_cases','select') ok`,[role])).rows[0].ok,false);
  assert.equal((await db.query(`select has_function_privilege($1,'public.send_workforce_communication_reply(uuid,uuid,uuid,text)','execute') ok`,[role])).rows[0].ok,false);
}
const reply=(name,caseId,company=co)=>db.query(`select public.${name}($1,$2,$3,$4)`,[company,caseId,actor,'Test reply']);
await assert.rejects(reply('send_communication_case_reply',ids[0]),/unavailable in this portal/);
await assert.rejects(reply('send_workforce_communication_reply',ids[1]),/unavailable in this portal/);
await assert.rejects(reply('send_workforce_communication_reply',ids[0],other),/unavailable/);
assert.equal((await db.query('select * from communication_case_messages')).rows.length,0);
await reply('send_workforce_communication_reply',ids[0]);
await reply('send_communication_case_reply',ids[1]);
const notifications=(await db.query('select * from mob_app_notifications')).rows;
assert.equal(notifications.length,2);assert.equal(notifications[0].title,'New reply from Workforce Support');assert.equal(notifications[1].title,'New reply from People & Culture');
assert.equal(notifications[0].recipient_account_id,worker);assert.equal(notifications[0].route,'communication_center');
const manage=(id,intent,value)=>db.query('select manage_workforce_communication_case($1,$2,$3,$4,$5)',[co,id,actor,intent,value]);
await assert.rejects(manage(ids[1],'note','wrong inbox'),/unavailable in this portal/);
await manage(ids[0],'note','Private note');await manage(ids[0],'assign','');await manage(ids[0],'status','closed');
assert.equal((await db.query("select * from communication_case_messages where visibility='internal'")).rows.length,1);
await assert.rejects(reply('send_workforce_communication_reply',ids[0]),/Reopen/);
await manage(ids[0],'status','in_review');
await assert.rejects(manage(ids[0],'status','invalid'),/Invalid status/);
const before=(await db.query('select count(*)::int n from communication_case_messages')).rows[0].n;
await db.exec(`alter table mob_app_notifications add constraint simulate_outage check(title <> 'New reply from Workforce Support') not valid`);
await assert.rejects(reply('send_workforce_communication_reply',ids[0]),/simulate_outage/);
assert.equal((await db.query('select count(*)::int n from communication_case_messages')).rows[0].n,before,'notification failure must roll back reply');
await db.close();
console.log('PASS: routing, legacy history, confidential identity, role grants, cross-portal/company rejection, replies, status, notes and atomic notifications');
