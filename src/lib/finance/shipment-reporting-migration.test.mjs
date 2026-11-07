import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('shipment reporting migration preserves prior kinds and rejects unknown kinds',async()=>{
 const db=new PGlite();
 try{
  await db.exec("create table public.finance_business_master (kind text not null constraint finance_business_master_kind_check check(kind in ('now_rate','now_store','cost_head','contract','overhead','insight','reporting_region','billing_period'))); insert into public.finance_business_master(kind) values ('billing_period'),('overhead');");
  await db.exec(await readFile(new URL('../../../supabase/migrations/20261107071803_finance_shipment_reporting_master.sql',import.meta.url),'utf8'));
  await db.exec("insert into public.finance_business_master(kind) values ('shipment_reporting')");
  assert.deepEqual((await db.query('select kind from public.finance_business_master order by kind')).rows.map(r=>r.kind),['billing_period','overhead','shipment_reporting']);
  await assert.rejects(db.exec("insert into public.finance_business_master(kind) values ('invalid')"),/check constraint/);
 }finally{await db.close();}
});
