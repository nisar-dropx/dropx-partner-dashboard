import assert from 'node:assert/strict';
import test from 'node:test';
import {paymentRead,latestPaymentRead} from './payment-read.ts';

test('payment reads are uncached GETs and never retry failed responses',async()=>{
  const original=globalThis.fetch;let calls=0;
  try{
    globalThis.fetch=async(url,options)=>{calls++;assert.equal(options.method,'GET');assert.equal(options.cache,'no-store');return Response.json({error:'Unavailable'},{status:503});};
    await assert.rejects(paymentRead('/payments'),{message:'Unavailable'});
    assert.equal(calls,1);
  }finally{globalThis.fetch=original;}
});

test('hung response body reaches a deadline instead of keeping the payment screen loading',async()=>{
  const original=globalThis.fetch;
  try{
    globalThis.fetch=async(url,{signal})=>({ok:true,json:()=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))))});
    await assert.rejects(paymentRead('/payments',{timeoutMs:10}),/taking longer than usual/);
  }finally{globalThis.fetch=original;}
});

test('switching account/month or unmounting cancels reads and invalidates stale responses',async()=>{
  const guard=latestPaymentRead(),first=guard.start();
  assert.equal(first.isCurrent(),true);
  const second=guard.start();
  assert.equal(first.signal.aborted,true);assert.equal(first.isCurrent(),false);
  assert.equal(second.isCurrent(),true);
  guard.cancel();assert.equal(second.signal.aborted,true);assert.equal(second.isCurrent(),false);
});

test('already cancelled reads preserve cancellation; HTML errors show a safe retry message',async()=>{
  const original=globalThis.fetch;
  try{
    const controller=new AbortController();controller.abort();
    globalThis.fetch=async(url,{signal})=>{assert.equal(signal.aborted,true);throw new DOMException('Aborted','AbortError');};
    await assert.rejects(paymentRead('/payments',{signal:controller.signal}),{name:'AbortError'});
    globalThis.fetch=async()=>new Response('<html>private gateway diagnostics</html>',{status:502});
    await assert.rejects(paymentRead('/payments'),{message:'Payment details are temporarily unavailable. Please retry.'});
  }finally{globalThis.fetch=original;}
});
