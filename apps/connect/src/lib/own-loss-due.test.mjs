import assert from 'node:assert/strict';
import test from 'node:test';
import {createClient} from '@supabase/supabase-js';
import {loadOwnLossDue} from './own-loss-due.ts';

test('loss ledger scopes the worker before paging and retains deductions beyond one database page',async()=>{
  let calls=0;
  const rows=Array.from({length:1203},(_,i)=>({worker_id:'worker',recovery_key:`key-${i}`,amount:1}));
  const db=createClient('https://example.supabase.co','test-only-key',{auth:{persistSession:false},global:{fetch:async(input,init)=>{
    calls++;const url=new URL(String(input));
    assert.equal(init.method,'GET');assert.equal(url.searchParams.get('worker_id'),'eq.worker');
    assert.equal(url.searchParams.get('p_company'),'company');assert.equal(url.searchParams.get('p_salary_month'),'2026-11');
    assert.equal(url.searchParams.get('order'),'recovery_key.asc');
    const start=Number(url.searchParams.get('offset')??0),limit=Number(url.searchParams.get('limit'));
    return Response.json(rows.slice(start,start+limit));
  }}});
  assert.deepEqual(await loadOwnLossDue(db,'company','worker','2026-11'),rows);
  assert.equal(calls,3);
});

test('later-page failures never return partial deductions',async()=>{
  let calls=0;
  const db=createClient('https://example.supabase.co','test-only-key',{auth:{persistSession:false},global:{fetch:async()=>{
    if(++calls===1)return Response.json(Array.from({length:500},()=>({worker_id:'worker',recovery_key:'key',amount:1})));
    return Response.json({message:'timeout'},{status:503});
  }}});
  await assert.rejects(loadOwnLossDue(db,'company','worker','2026-11'),/loss deductions could not be verified/);
});
