import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const db=new PGlite();
await db.exec(`
  create table loss_report_runs(
    id uuid primary key,
    triggered_by text
  );
  create table nl_loss_month_cases(
    company_id uuid not null,
    month text not null,
    case_key text not null,
    station_code text,
    amount numeric,
    source_status text,
    details jsonb not null default '{}',
    source_present boolean not null default true,
    source_file text,
    source_run_id uuid,
    source_updated_at timestamptz default now(),
    last_seen_at timestamptz default now(),
    final_seen_at timestamptz,
    report text not null default 'nl',
    data_source text,
    primary key(company_id,month,case_key)
  );
  create table nl_loss_source_events(
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null,
    month text not null,
    case_key text not null,
    action text not null,
    before_value jsonb,
    after_value jsonb not null,
    actor_name text not null,
    created_at timestamptz not null default now()
  );
`);
const migration=await readFile(new URL('../supabase/migrations/20261028241000_loss_tracking_history_integrity.sql',import.meta.url),'utf8');
await db.exec(migration);
await db.exec(migration);

const company='00000000-0000-0000-0000-000000000001';
const firstRun='00000000-0000-0000-0000-000000000011';
const secondRun='00000000-0000-0000-0000-000000000012';
await db.query('insert into loss_report_runs(id,triggered_by) values($1,$2),($3,$4)',[firstRun,'hourly refresh',secondRun,'manual source refresh']);
await db.query(`insert into nl_loss_month_cases(company_id,month,case_key,station_code,amount,source_status,details,source_file,source_run_id)
  values($1,'2026-09','T1','KLZA',100,'Recoverable','{"tid":"371980774817"}','a.csv',$2)`,[company,firstRun]);

// The normal refresh toggle and run/file clocks are transport metadata only.
await db.query("update nl_loss_month_cases set source_present=false,last_seen_at=now() where company_id=$1 and month='2026-09' and case_key='T1'",[company]);
await db.query("update nl_loss_month_cases set source_present=true,source_file='b.csv',source_run_id=$2,last_seen_at=now(),source_updated_at=now() where company_id=$1 and month='2026-09' and case_key='T1'",[company,secondRun]);
let events=(await db.query('select action,actor_name,before_value,after_value from nl_loss_source_events order by created_at,id')).rows;
assert.equal(events.length,1,'unchanged source refresh must not create absent/restored audit noise');
assert.equal(events[0].actor_name,'Amazon NL import · hourly refresh');

await db.query("update nl_loss_month_cases set amount=120,source_run_id=$2 where company_id=$1 and month='2026-09' and case_key='T1'",[company,secondRun]);
events=(await db.query('select action,actor_name,before_value,after_value from nl_loss_source_events order by created_at,id')).rows;
assert.equal(events.length,2);
assert.equal(events[1].action,'Source updated');
assert.equal(events[1].actor_name,'Amazon NL import · manual source refresh');
assert.equal(Number(events[1].before_value.amount),100);
assert.equal(Number(events[1].after_value.amount),120);

await db.close();
console.log('PASS tracking history integrity: import toggles stay silent, substantive changes retain source actor and before/after values.');
