import test from 'node:test';
import assert from 'node:assert/strict';
import { codStatusCategory, codStatusToday } from './cod-status.ts';
const now=new Date('2026-10-12T16:00:00Z');
const base=()=>({date:'2026-10-12',reconciliation:{data:{complete:true,pendingCount:0}},prepareDeposit:{data:{expectedAmount:0,actualAmount:0,variance:0}},remittances:{data:{complete:true,openCount:0,submittedToday:true}}});
test('all three checks must pass and remittance must be current',()=>{
 assert.equal(codStatusCategory(base(),now),'clear');
 const old=base();old.remittances.data.submittedToday=false;assert.equal(codStatusCategory(old,now),'unavailable');
 old.date='2026-10-11';assert.equal(codStatusCategory(old,now),'unavailable');
});
test('pending cash is visible even if remittances are submitted',()=>{
 const s=base();s.reconciliation.data.pendingCount=2;assert.equal(codStatusCategory(s,now),'attention');
 s.reconciliation.data.pendingCount=0;s.prepareDeposit.data.actualAmount=10;assert.equal(codStatusCategory(s,now),'attention');
});
test('missing/partial checks cannot imply clear',()=>{
 const s=base();s.remittances.data.complete=false;assert.equal(codStatusCategory(s,now),'unavailable');
 s.remittances.data=null;assert.equal(codStatusCategory(s,now),'unavailable');
 assert.equal(codStatusCategory(undefined,now),'unchecked');
});
test('date rolls over at IST midnight',()=>assert.equal(codStatusToday(new Date('2026-10-11T19:00:00Z')),'2026-10-12'));
