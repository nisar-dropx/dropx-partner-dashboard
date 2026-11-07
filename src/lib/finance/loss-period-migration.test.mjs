import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
test('loss period master migration is repeatable and prevents competing active period mappings',async()=>{
 const db=new PGlite();try{
 await db.exec("create table public.finance_business_master (company_id text, kind text constraint finance_business_master_kind_check check(kind in ('shipment_reporting')), data jsonb,deleted_at timestamptz); insert into public.finance_business_master values('C','shipment_reporting','{}',null);");
 const sql=await readFile(new URL('../../../supabase/migrations/20261107084439_finance_loss_billing_periods.sql',import.meta.url),'utf8');await db.exec(sql);await db.exec(sql);
 await db.exec(`insert into public.finance_business_master values('C','loss_period','{"report":"nl","period":"2026-09","pnl_month":"2026-10"}',null)`);
 await assert.rejects(db.exec(`insert into public.finance_business_master values('C','loss_period','{"report":"nl","period":"2026-09","pnl_month":"2026-11"}',null)`),/unique/);
 await db.exec("update public.finance_business_master set deleted_at=now() where kind='loss_period'");
 await db.exec(`insert into public.finance_business_master values('C','loss_period','{"report":"nl","period":"2026-09","pnl_month":"2026-11"}',null)`);
 assert.equal((await db.query("select count(*)::int n from public.finance_business_master where kind='shipment_reporting'")).rows[0].n,1);
 }finally{await db.close();}
});
