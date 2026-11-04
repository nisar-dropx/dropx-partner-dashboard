import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const db=new PGlite();
const a='00000000-0000-0000-0000-000000000001',b='00000000-0000-0000-0000-000000000002';
await db.exec(`create table companies(id uuid primary key);insert into companies values('${a}'),('${b}');
create table workforce_payout_dependency_revisions(company_id uuid primary key,revision bigint default 0,updated_at timestamptz);
insert into workforce_payout_dependency_revisions(company_id) select id from companies;
create table dependency_lock_audit(company_id uuid);
create function lock_workforce_payment_allocation_company(p_company uuid) returns void language plpgsql as $$begin perform pg_advisory_xact_lock(hashtextextended(p_company::text,0));insert into public.dependency_lock_audit values(p_company);end$$;
create table payment_adhoc_driver_absences(id int primary key,company_id uuid not null,value int);
`);
const original=readFileSync(new URL('../supabase/migrations/20261007110000_workforce_advance_recovery_hardening.sql',import.meta.url),'utf8');
for(const name of ['workforce_bump_payout_dependency_revision','workforce_touch_payout_dependency_from_new_rows','workforce_touch_payout_dependency_from_old_rows','workforce_touch_payout_dependency_from_changed_rows','workforce_touch_all_payout_dependency_revisions']){
 const definition=original.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$function\\$;`,'i'))?.[0];assert.ok(definition,name);await db.exec(definition);
}
const migration=readFileSync(new URL('../supabase/migrations/20261104081848_adhoc_driver_payout_dependency.sql',import.meta.url),'utf8');
await db.exec(migration);await db.exec(migration);
const revisions=async()=> (await db.query('select revision::int from workforce_payout_dependency_revisions order by company_id')).rows.map(r=>r.revision);
await db.exec(`insert into payment_adhoc_driver_absences values(1,'${a}',1),(2,'${a}',2),(3,'${b}',3)`);assert.deepEqual(await revisions(),[1,1]);
assert.equal((await db.query('select count(*)::int n from dependency_lock_audit')).rows[0].n,2,'one company lock per statement, not per row');
await db.exec('update payment_adhoc_driver_absences set value=4 where false');assert.deepEqual(await revisions(),[1,1]);
await db.exec(`update payment_adhoc_driver_absences set company_id='${b}' where id=1`);assert.deepEqual(await revisions(),[2,2]);
await db.exec(`delete from payment_adhoc_driver_absences where company_id='${b}'`);assert.deepEqual(await revisions(),[2,3]);
await db.exec('truncate payment_adhoc_driver_absences');assert.deepEqual(await revisions(),[3,4]);
await db.exec(`begin;insert into payment_adhoc_driver_absences values(4,'${a}',4);rollback`);assert.deepEqual(await revisions(),[3,4],'rolled-back rules never advance committed revision');
await db.close();console.log('Driver absence dependency: twice-applied triggers, company locks, bulk revision, moves, deletes, truncate and rollback passed.');
