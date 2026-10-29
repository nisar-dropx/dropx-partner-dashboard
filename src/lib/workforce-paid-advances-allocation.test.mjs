import assert from 'node:assert/strict';
import test from 'node:test';
import {fitWorkforceAdvances} from './workforce-paid-advances-allocation.ts';
const row=(station,net=1000,worker='w')=>({id:station,locationId:station,reviewSubjectId:worker,reviewSubjectType:'workforce',netAmount:net,deductions:0,deductionBreakdown:[]});
const due=(id,amount=1500)=>({advance_id:id,worker_id:'w',amount,paid_at:'2026-10-01'});
test('one worker across stations recovers once and retains unpaid take-home',()=>{
 const rows=fitWorkforceAdvances([row('b'),row('a'),row('x',900,'other')],[due('a')],[{workforce_id:'w',status:'paid',instruction_amount:500}],[]);
 assert.deepEqual(rows.map(r=>r.netAmount),[500,0,900]);
 assert.equal(rows.reduce((s,r)=>s+r.deductions,0),1500);
});
test('processing bank files stay unchanged; later unpaid payroll carries the balance',()=>{
 const rows=fitWorkforceAdvances([row('a')],[due('a')],[{workforce_id:'w',status:'processing',instruction_amount:1000}],[]);
 assert.equal(rows[0].deductions,0);
});
test('an earlier-sorting new advance cannot consume a prior deduction or paid salary',()=>{
 const rows=fitWorkforceAdvances([row('a',2000)],[due('a-new',500),due('z-old',500)],
   [{workforce_id:'w',status:'paid',instruction_amount:1500}],
   [{workforce_id:'w',station_id:'a',advance_id:'z-old',amount:500}]);
 assert.equal(rows[0].netAmount,1500);
 assert.deepEqual(rows[0].deductionBreakdown.map(d=>d.recoveryKey),['ADVANCE:z-old']);
});
test('a published partial deduction remains fixed after a later advance arrives',()=>{
 const prior=[{workforce_id:'w',station_id:'a',advance_id:'old',amount:200}];
 const rows=fitWorkforceAdvances([row('a')],[due('old',500),due('new',600)],[],prior);
 assert.deepEqual(rows[0].deductionBreakdown.map(x=>x.amount).sort(),[200,600]);
 assert.equal(rows[0].netAmount,200);
 assert.throws(()=>fitWorkforceAdvances([row('b')],[due('old',500)],[],prior),/no longer fits/);
});
