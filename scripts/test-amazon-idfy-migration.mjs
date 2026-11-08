import {PGlite} from '@electric-sql/pglite';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const db=new PGlite();
await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create table companies(id uuid primary key);create table stations(id uuid primary key);');
await db.exec(fs.readFileSync('supabase/migrations/20261108154455_amazon_da_synced_detail_queue.sql','utf8'));
const company='00000000-0000-4000-8000-000000000001',station='00000000-0000-4000-8000-000000000002',id='00000000-0000-4000-8000-000000000003';
await db.query('insert into companies values($1)',[company]);await db.query('insert into stations values($1)',[station]);
assert.equal((await db.query('select claim_amazon_da_sync($1,$2) claimed',[company,id])).rows[0].claimed,true);
assert.equal((await db.query('select claim_amazon_da_sync($1,$2) claimed',[company,station])).rows[0].claimed,false);
await db.query("insert into amazon_da_idfy_actions(id,company_id,station_id,provider_id,idfy_profile_id,block_id,action,actor_id,actor_name,actor_role,status) values($1,$2,$3,'provider','123','456','response',$1,'Station user','Manager','queued')",[id,company,station]);
await assert.rejects(db.query("update amazon_da_idfy_actions set status='submitted' where id=$1",[id]),/Invalid/);
await assert.rejects(db.query("update amazon_da_idfy_actions set actor_name='Forged',status='sending' where id=$1",[id]),/immutable/);
await db.query("update amazon_da_idfy_actions set status='sending',changes='[{\"field\":\"address\",\"before\":\"old\",\"after\":\"new\"}]' where id=$1",[id]);
await assert.rejects(db.query("update amazon_da_idfy_actions set status='unconfirmed',changes='[]' where id=$1",[id]),/immutable/);
await db.query("update amazon_da_idfy_actions set status='unconfirmed' where id=$1",[id]);
await db.query("update amazon_da_idfy_actions set status='submitted' where id=$1",[id]);
await assert.rejects(db.query("update amazon_da_idfy_actions set status='sending' where id=$1",[id]),/immutable/);
assert.equal((await db.query('select count(*)::int n from amazon_da_idfy_events where action_id=$1',[id])).rows[0].n,4);
for(const table of ['amazon_da_idfy_actions','amazon_da_idfy_events','amazon_da_detail_snapshots','amazon_da_sync_leases']){
 assert.equal((await db.query("select has_table_privilege('authenticated',$1,'select') allowed",[table])).rows[0].allowed,false);
 assert.equal((await db.query("select relrowsecurity from pg_class where relname=$1",[table])).rows[0].relrowsecurity,true);
}
assert.equal((await db.query("select has_function_privilege('anon','claim_amazon_da_sync(uuid,uuid)','execute') allowed")).rows[0].allowed,false);
await db.close();console.log('IDfy database: private RLS tables, exclusive sync lease, immutable actor/changes, valid state transitions, event history and client privilege checks passed.');
