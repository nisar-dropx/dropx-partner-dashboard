import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role;
create table samples (id int); create table events (id int);
create function public.nl_recovery_month(jsonb,timestamptz) returns text language sql as $$select '2026-10'::text$$;
create function public.enforce_loss_installment_amount_rules() returns trigger language plpgsql security definer as $$begin if new.id < 0 then raise exception 'Invalid amount'; end if; return new; end$$;
create function public.nl_loss_record_source_history() returns trigger language plpgsql security definer as $$begin insert into events values(new.id); return new; end$$;
grant execute on function public.enforce_loss_installment_amount_rules(), public.nl_loss_record_source_history() to anon, authenticated;
create trigger validate before insert on samples for each row execute function enforce_loss_installment_amount_rules();
create trigger history after insert on samples for each row execute function nl_loss_record_source_history();`);
const sql=fs.readFileSync('supabase/migrations/20261105184515_loss_helper_access_hardening.sql','utf8');
await db.exec(sql); await db.exec(sql);
for (const role of ['anon','authenticated','service_role']) for (const name of ['enforce_loss_installment_amount_rules','nl_loss_record_source_history']) {
 const result=await db.query('select has_function_privilege($1,$2,\'execute\') allowed',[role,`${name}()`]);
 assert.equal(result.rows[0].allowed,role==='service_role');
}
assert.deepEqual((await db.query("select proconfig from pg_proc where proname='nl_recovery_month'")).rows[0].proconfig,['search_path=pg_catalog, public']);
await db.exec('insert into samples values(1)');
assert.equal((await db.query('select count(*)::int n from events')).rows[0].n,1);
await assert.rejects(()=>db.exec('insert into samples values(-1)'),/Invalid amount/);
await db.close();
console.log('PASS: client RPC grants removed; service role and automatic validation/history triggers retained.');
