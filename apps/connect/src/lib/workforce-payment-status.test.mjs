import test from 'node:test';
import assert from 'node:assert/strict';
import {workforcePaymentStatus as status, workforceStatementDate as date} from './workforce-payment-status.ts';
test('one paid associate in a partial batch shows their own bank reference',()=>assert.deepEqual(status({status:'paid'},{status:'approved'},{status:'processed',utr_cin:'BANK-123',processed_at:'2026-09-20T20:00:00Z'}),{status:'paid',statusLabel:'Paid',paymentReference:'BANK-123',paymentDate:'2026-09-20T20:00:00Z'}));
test('held, excluded and draft items never publish a statement',()=>{for(const value of ['held','excluded','draft']) assert.equal(status({status:value},{status:'paid'}),null);assert.equal(status({status:'ready'},{status:'review'}),null);});
test('returned and processing requests do not claim paid or expose stale bank references',()=>{for(const value of ['pending','returned','processing']){const result=status({status:'ready'},{status:'approved'},{status:value,utr_cin:'old'});assert.equal(result.status,value);assert.equal(result.paymentReference,null);assert.equal(result.paymentDate,null);}});
test('processed request with unsynced payroll is visibly pending reconciliation',()=>assert.equal(status({status:'ready'},{status:'approved'},{status:'processed'}).status,'reconciling'));
test('legacy paid statements retain historical references',()=>assert.equal(status({status:'paid'},{status:'paid',payment_reference:'legacy'}).paymentReference,'legacy'));
test('statement dates accept SQL dates and timestamps in India time',()=>{assert.match(date('2026-09-20T20:00:00Z'),/21/);assert.match(date('2026-09-20'),/20/);assert.equal(date('invalid'),'—');});
