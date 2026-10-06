import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
await db.exec(`create role anon;create role authenticated;
create table fleet_vehicles(id int,company_id int,ownership_type text);
create table fleet_audits(id int,company_id int,vehicle_id int,status text,email_status text,updated_at text);
create table fleet_service_history(id int,company_id int,vehicle_id int,status text);
insert into fleet_vehicles values(1,1,'own'),(2,1,'odcd'),(3,1,'rented'),(4,1,null),(5,2,'own');
insert into fleet_audits values(2,1,2,'scheduled','not_sent',null),(3,1,2,'passed','not_sent',null);`);
await db.exec(fs.readFileSync('supabase/migrations/20261006195709_fleet_owned_audit_service_scope.sql','utf8'));
for(const table of ['fleet_audits','fleet_service_history']){
 await db.exec(`insert into ${table}(id,company_id,vehicle_id,status) values(1,1,1,'scheduled')`);
 for(const id of [2,3,4,5])await assert.rejects(()=>db.exec(`insert into ${table}(id,company_id,vehicle_id,status) values(9,1,${id},'scheduled')`),/DropX-owned/);
 await assert.rejects(()=>db.exec(`update ${table} set vehicle_id=2 where id=1`),/DropX-owned/);
}
await assert.rejects(()=>db.exec(`update fleet_audits set status='in_progress' where id=2`),/DropX-owned/);
await db.exec(`update fleet_audits set status='cancelled' where id=2;update fleet_audits set email_status='sent' where id=3;`);
await db.exec(`update fleet_vehicles set ownership_type='rented' where id=1`);
await assert.rejects(()=>db.exec(`update fleet_service_history set status='completed' where id=1`),/DropX-owned/);
await db.close();console.log('Owned maintenance DB guards passed: insert, update, cross-tenant, unknown source, source change, cancellation and historical email metadata.');
