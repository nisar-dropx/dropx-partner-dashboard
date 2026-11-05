import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
const company='00000000-0000-0000-0000-000000000001',actor='00000000-0000-0000-0000-000000000002';
const names=['save_nl_recovery','clear_nl_recovery','nl_loss_exception_set','nl_loss_lifecycle_transition','nl_loss_recovery_approve','nl_redispute_transition','nl_redispute_track','nl_case_response_transition','save_nl_dispute_request','waive_nl_recovery_balance'];
await db.exec(`create role anon;create role authenticated;create role service_role;
create table nl_loss_month_cases(company_id uuid,report text,month text,case_key text,station_code text,amount numeric,details jsonb);
create table nl_loss_recoveries(company_id uuid,month text,case_key text,is_deleted boolean,allocations jsonb);
create table writes(name text);
`);
for(const name of names) await db.exec(`create function public.${name}(p_company uuid,p_month text,p_case text) returns void language plpgsql as $$ begin insert into writes values('${name}'); end $$;`);
await db.query(`insert into nl_loss_month_cases values
 ($1,'nl','2026-09','one','KLZA',100,'{}'),($1,'nl','2026-09','two','TLPA',200,'{}'),
 ($1,'nl','2026-10','three','KLZA',300,'{}'),($1,'slp','2026-09','four','KLZA',400,'{"period":"Aug-Sep"}'),
 ($2,'nl','2026-09','one','KLZA',100,'{}')`,[company,actor]);
await db.query("insert into nl_loss_recoveries values($1,'2026-09','one',false,'[{\"person\":\"preserved\",\"amount\":100}]')",[company]);
const sql=fs.readFileSync('supabase/migrations/20261105053755_loss_period_final_submit.sql','utf8');
await db.exec(sql);await db.exec(sql);
for(const name of names) await db.query(`select ${name}($1,'2026-09','one')`,[company]);
assert.equal((await db.query('select count(*)::int n from writes')).rows[0].n,10);
const close=()=>db.query("select nl_loss_close_period($1,'nl','2026-09',array['KLZA'],$2,'Manager') n",[company,actor]);
assert.equal((await close()).rows[0].n,1);assert.equal((await close()).rows[0].n,0);
const snapshot=(await db.query('select snapshot from nl_loss_period_closures')).rows[0].snapshot;
assert.equal(snapshot.source_value,100);assert.equal(snapshot.recovery_plans[0].allocations[0].person,'preserved');
for(const name of names) await assert.rejects(()=>db.query(`select ${name}($1,'2026-09','one')`,[company]),/finally submitted and closed/);
for(const [co,month,key] of [[company,'2026-09','two'],[company,'2026-10','three'],[company,'2026-09','four'],[actor,'2026-09','one']])
 await db.query('select save_nl_recovery($1,$2,$3)',[co,month,key]);
// A source refresh remains allowed; moving its period/station cannot unlock a captured case.
await db.exec("update nl_loss_month_cases set station_code='CHANGED',amount=101 where case_key='one'");
await assert.rejects(()=>db.query("select clear_nl_recovery($1,'2026-09','one')",[company]),/finally submitted/);
await db.query("select nl_loss_close_period($1,'slp','Aug-Sep',array['KLZA'],$2,'Manager')",[company,actor]);
await assert.rejects(()=>db.query("select save_nl_recovery($1,'2026-09','four')",[company]),/finally submitted/);
await db.query("insert into nl_loss_month_cases values($1,'slp','2026-09','new','KLZA',20,'{\"period\":\"Aug-Sep\"}')",[company]);
await assert.rejects(()=>db.query("select save_nl_recovery($1,'2026-09','new')",[company]),/finally submitted/);
await db.exec(sql);
assert.equal((await db.query('select count(*)::int n from nl_loss_period_closures')).rows[0].n,2);
assert.equal((await db.query("select has_function_privilege('authenticated','nl_loss_close_period(uuid,text,text,text[],uuid,text)','execute') permitted")).rows[0].permitted,false);
assert.equal((await db.query("select has_table_privilege('service_role','nl_loss_period_closures','UPDATE') permitted")).rows[0].permitted,false);
console.log('PASS: all 10 manual write paths locked; NL/SLP, station and tenant isolation; snapshot persistence, new imports, idempotency and grants.');
await db.close();
