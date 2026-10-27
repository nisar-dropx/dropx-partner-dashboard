import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const db=new PGlite();
await db.exec(`create role anon;create role authenticated;create role service_role;
create table nl_loss_recoveries(company_id uuid,month text,case_key text,version int,approval_status text,is_deleted boolean,allocations jsonb,deduction_month text);
create table nl_loss_month_cases(company_id uuid,month text,case_key text,details jsonb);
create table mob_app_notifications(company_id uuid,recipient_profile_type text,recipient_account_id uuid,event_code text,source_key text,title text,body text,route text,data jsonb,unique(company_id,event_code,source_key,recipient_account_id));`);
const sql=readFileSync('supabase/migrations/20261027223000_loss_one_notifications.sql','utf8');await db.exec(sql);await db.exec(sql);
const c='11111111-1111-4111-8111-111111111111',p='22222222-2222-4222-8222-222222222222';
await db.query('insert into nl_loss_month_cases values($1,$2,$3,$4)',[c,'2026-09','372290288025',{tid:'372290288025'}]);
for(const kind of ['employee','contractor','workforce'])await db.query('insert into nl_loss_recoveries values($1,$2,$3,$4,$5,$6,$7,$8)',[c,'2026-09','372290288025',1,'approved',false,[{ref:`${kind}:${p}`,amount:1912}],'2026-10']);
// A source key must include the typed identity, since employee and Workforce UUIDs can overlap.
const rows=(await db.query('select * from mob_app_notifications order by recipient_profile_type')).rows;
assert.equal(rows.length,3);assert.deepEqual(rows.map(r=>r.route),['salary','salary','payments']);assert.ok(rows.every(r=>r.body.includes('1912')&&r.body.includes('2026-10')&&!r.body.includes('deducted')));
await db.exec(sql);assert.equal((await db.query('select count(*)::int n from mob_app_notifications')).rows[0].n,3);
await db.exec("update nl_loss_recoveries set approval_status='needs_review',version=2");assert.equal((await db.query('select count(*)::int n from mob_app_notifications')).rows[0].n,3);
console.log('PASS idempotent assignment notices, typed people, pending review and no invented deduction');await db.close();
