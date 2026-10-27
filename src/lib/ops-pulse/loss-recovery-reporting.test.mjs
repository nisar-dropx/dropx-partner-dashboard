import {test} from 'node:test';
import assert from 'node:assert/strict';
import {finalRecoverySummary,recoveryDetailsUpdated} from './loss-final-summary.ts';
import {filterLossDebits,summarizeLossDebits} from './loss-debit-review.ts';
test('Final metrics distinguish recovery updates from dispute savings and actual payroll',()=>{
 const row={amount:100,source_status:'Recoverable'};
 const plan={source_amount:100,source_status:'Recoverable',approval_status:'proposed',allocations:[{amount:100}]};
 assert.equal(recoveryDetailsUpdated(row,plan),true);
 for(const changed of [{approval_status:'returned'},{source_amount:200},{allocations:[{amount:50}]},{is_deleted:true}])assert.equal(recoveryDetailsUpdated(row,{...plan,...changed}),false);
 assert.deepEqual(finalRecoverySummary([{amount:100,recoverable:true,updated:true},{amount:50,recoverable:true,updated:false},{amount:20,recoverable:false,updated:false}]),{count:3,amount:170,updated:1,updatedAmount:100,pendingUpdate:1,pendingUpdateAmount:50,nonrecoverable:1,nonrecoverableAmount:20});
});
test('Debit reporting uses actual payroll months, typed people, and separates draft values',()=>{
 const base={loss_month:'2026-09',case_key:'123456789012',station_code:'A',designation:'TL',full_name:'Person',employee_code:'D1'};
 const rows=[{...base,employee_ref:'employee:1',recovery_key:'a',payroll_month:'2026-10',amount:100,is_deducted:true},{...base,employee_ref:'employee:1',recovery_key:'b',payroll_month:'2026-11',amount:50,is_deducted:true},{...base,employee_ref:'contractor:1',recovery_key:'c',payroll_month:'2026-10',amount:200,is_deducted:false}];
 const oct=filterLossDebits(rows,{month:'2026-10'});assert.equal(oct.length,2);
 const group=summarizeLossDebits(oct,'station')[0];assert.equal(group.deducted,100);assert.equal(group.draft,200);assert.equal(group.people,2);assert.equal(group.shipments,1);
 const history=summarizeLossDebits(filterLossDebits(rows,{person:'employee:1'}),'month');assert.deepEqual(history.map(r=>[r.key,r.deducted]),[['2026-11',50],['2026-10',100]]);
 assert.equal(filterLossDebits(rows,{station:'OUTSIDE'}).length,0);
});
