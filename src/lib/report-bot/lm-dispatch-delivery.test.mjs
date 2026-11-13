import test from 'node:test';
import assert from 'node:assert/strict';
import {deliverDispatchOutputs} from './lm-dispatch-delivery.ts';
test('a shared war room sends healthy station output without hiding another station failure',async()=>{
 const receipts=new Set(),sent=[];
 const send=async key=>{if(!receipts.has(key)){sent.push(key);receipts.add(key)}};
 await assert.rejects(deliverDispatchOutputs(['station-A'],['station-B: source unavailable'],send),/station-B/);
 assert.deepEqual(sent,['station-A']);
 assert.equal(await deliverDispatchOutputs(['station-A','station-B'],[],send),true);
 assert.deepEqual(sent,['station-A','station-B']);
});
test('an all-failed source run stays retryable and an all-clear run stays quiet',async()=>{
 const send=async()=>assert.fail('no outputs to send');
 await assert.rejects(deliverDispatchOutputs([],['GNTI: source unavailable'],send),/GNTI/);
 assert.equal(await deliverDispatchOutputs([],[],send),false);
});
test('delivery failure is never marked successful',async()=>{
 await assert.rejects(deliverDispatchOutputs(['A'],[],async()=>{throw new Error('transport failed')}),/transport failed/);
});
