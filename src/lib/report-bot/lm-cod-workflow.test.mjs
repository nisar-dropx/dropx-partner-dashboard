import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pickupReview,dueBankRows,prepareTrigger,parseCodHold} from './lm-cod-workflow.ts';
import {CodRuntime} from './lm-cod-runtime.ts';
const at=t=>Date.parse('2026-11-11T'+t+':00+05:30');
const row=(id,status,time,amount=100000)=>({id,code:id,status,actualAmount:amount,expectedAmount:amount,variance:0,createdAt:at(time),updatedAt:at(time),submittedAt:status==='SUBMITTED'?at(time):null,createdBy:'',submittedBy:null});
test('₹1.5L available, ₹1L submitted: one ₹50k gap; DA cash separate',()=>{
 const before={at:at('10:45'),prepare:50000,remittances:[row('r1','CREATED','09:00')],drivers:[{id:'d',name:'DA',amount:10000,dueAt:at('10:40'),lastStopAt:at('10:00'),closed:true,packages:[{id:'T1',amount:10000}]}]};
 const after={...before,at:at('11:05'),prepare:50000,remittances:[row('r1','SUBMITTED','11:00')]};
 const r=pickupReview(before,after,at('11:00'));assert.equal(r.available,150000);assert.equal(r.deposited,100000);assert.equal(r.gap,50000);assert.equal(r.lateDas.length,1);
});
test('no accusations using after-pickup or stale evidence',()=>{
 const after={at:at('11:05'),prepare:50000,remittances:[row('r','SUBMITTED','11:00')],drivers:[]};
 assert.equal(pickupReview({...after,at:at('11:01')},after,at('11:00')),null);
 assert.equal(pickupReview({...after,at:at('10:00')},after,at('11:00')),null);
 assert.equal(pickupReview(undefined,after,at('11:00')),null);
});
test('next-day new remittance after morning pickup is not overdue tonight',()=>{
 const rows=[row('previous','SUBMITTED','10:17'),row('new','CREATED','20:00')];
 assert.deepEqual(dueBankRows(rows,{rule:'Next Day',start:'10:00',end:'11:00',preparationFrom:'16:00'},at('23:00')),[]);
 assert.deepEqual(dueBankRows([row('pickup','SUBMITTED','10:17'),row('new','CREATED','10:30')],{rule:'Next Day',start:'10:00',end:'11:00',preparationFrom:'16:00'},at('23:00')),[]);
});
test('same-day evening pickup can take cash already at station while DAs are out',()=>{
 assert.equal(prepareTrigger({amount:50000,oor:8,reconPending:20000,closedSince:null,policy:{rule:'Same Day-Complete',start:'18:00',end:'19:00'},submittedToday:false,nonPickup:false,now:at('18:00')}),'pickup');
});
test('day-end prepare does not nag before complete reconciliation',()=>{
 const input={amount:50000,oor:0,reconPending:1000,closedSince:at('18:00'),policy:{rule:'Next Day',start:'10:00',end:'11:00'},submittedToday:true,nonPickup:false,now:at('22:00')};
 assert.equal(prepareTrigger(input),null);assert.equal(prepareTrigger({...input,reconPending:0}),'closure');
});
test('holds are station/stage scoped, explicit and at most four hours',()=>{
 assert.equal(parseCodHold('COD HOLD JUGD RECON UNTIL 22:00 bank issue awaiting response','JUGD',at('21:00'),at('21:01')).key,'recon');
 assert.equal(parseCodHold('COD HOLD JUGD RECON UNTIL 22:00 bank issue awaiting response','JUGF',at('21:00'),at('21:01')),null);
 assert.equal(parseCodHold('will check soon','JUGD',at('21:00'),at('21:01')),null);
 assert.equal(parseCodHold('COD HOLD JUGD RECON UNTIL 23:00 checking customer payment','JUGD',at('18:00'),at('18:01')),null);
});
test('shared budget caps concurrency and avoids duplicate enrichment',async()=>{
 const run=new CodRuntime(Date.now()+60000,5,2);let active=0,max=0,calls=0;
 const task=()=>run.external(async()=>{active++;max=Math.max(max,active);calls++;await new Promise(r=>setTimeout(r,5));active--;return 42;});
 await Promise.all([run.memo('same',task),run.memo('same',task),task(),task(),task(),task()]);
 assert.equal(calls,5);assert.equal(max,2);await assert.rejects(()=>task(),/budget/);
});
