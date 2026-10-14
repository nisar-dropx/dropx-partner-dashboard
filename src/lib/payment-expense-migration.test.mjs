import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

test('expense migration validates company ownership and station, preserves history, and protects server provenance',async()=>{
 const db=new PGlite();
 const company='43866344-b550-4e8a-9a2d-9d23f3d8a997';
 const station='00000000-0000-4000-8000-000000000001',own='00000000-0000-4000-8000-000000000002',odcd='00000000-0000-4000-8000-000000000003',other='00000000-0000-4000-8000-000000000004',actor='00000000-0000-4000-8000-000000000005',head='00000000-0000-4000-8000-000000000006';
 try {
 await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth;
 create function auth.role() returns text language sql as $$ select current_setting('request.jwt.claim.role',true) $$;
 create table profiles(id uuid primary key,company_id uuid,is_active boolean);
 create table stations(id uuid primary key,company_id uuid,station_code text);
 create table fleet_vehicle_sources(id uuid primary key,company_id uuid,ownership_type text);
 create table fleet_vehicles(id uuid primary key,company_id uuid,station_code text,ownership_type text,source_id uuid,status text);
 create table payment_heads(id uuid primary key,company_id uuid,code text);
 create table payment_requests(id uuid primary key default gen_random_uuid(),company_id uuid,location_id uuid,adhoc_approval_steps jsonb,remarks text);
 insert into profiles values('${actor}','${company}',true);
 insert into stations values('${station}','${company}','EXAMPLE');
 insert into fleet_vehicles values('${own}','${company}','EXAMPLE','own',null,'breakdown'),('${odcd}','${company}','EXAMPLE','odcd',null,'active'),('${other}','${company}','OTHER','own',null,'active');
 insert into payment_heads values('${head}','${company}','VEHICLE_SERVICE');
 insert into payment_requests(company_id,location_id,remarks) values('${company}','${station}','Historical request');`);
 await db.exec(readFileSync(new URL('../../supabase/migrations/20261014180000_payment_vehicle_and_requester_origin.sql',import.meta.url),'utf8'));
 assert.equal((await db.query('select vehicle_scope from payment_heads')).rows[0].vehicle_scope,'owned_station');
 assert.equal((await db.query('select count(*)::int n from payment_head_vehicle_policy_changes')).rows[0].n,1);
 await db.exec(`select set_config('request.jwt.claim.role','service_role',false);`);
 const insert=vehicle=>db.query(`insert into payment_requests(company_id,location_id,expense_vehicle_id) values($1,$2,$3) returning id`,[company,station,vehicle]);
 const request=(await insert(own)).rows[0].id;
 await assert.rejects(()=>insert(odcd),/company-owned/);
 await assert.rejects(()=>insert(other),/request station/);
 await db.exec(`update fleet_vehicles set station_code='MOVED' where id='${own}'; update payment_requests set remarks='Retained historical vehicle' where id='${request}';`);
 assert.equal((await db.query('select expense_vehicle_id from payment_requests where id=$1',[request])).rows[0].expense_vehicle_id,own);
 await db.exec(`update payment_heads set vehicle_scope='none',vehicle_scope_updated_by='${actor}' where id='${head}';`);
 assert.equal((await db.query('select actor_id from payment_head_vehicle_policy_changes where previous_scope=$1',['owned_station'])).rows[0].actor_id,actor);
 await db.exec(`select set_config('request.jwt.claim.role','authenticated',false);`);
 await assert.rejects(()=>db.exec(`update payment_requests set approval_origin='{"skipped":[1]}' where id='${request}'`),/authorized payment/);
 await assert.rejects(()=>db.exec(`update payment_heads set vehicle_scope='owned_station' where id='${head}'`),/authorized Payment Heads/);
 } finally { await db.close(); }
});
