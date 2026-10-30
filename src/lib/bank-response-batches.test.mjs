import test from 'node:test';
import assert from 'node:assert/strict';
import {finalizeBankResponseBatches} from './bank-response-batches.ts';
import {canReconcilePayment} from './payment-processing-policy.ts';
import {bankResponseGuidance,bankResponseCsv} from './bank-response-guidance.ts';
const rows=Array.from({length:45},(_,i)=>({rowNumber:i+3,referenceNo:`PR${i}`}));
test('a timed-out batch preserves committed outcomes and accounts for every original row',async()=>{
 let calls=0;
 const result=await finalizeBankResponseBatches({rows,deadlineAt:100,now:()=>0,finalize:async batch=>{
   calls++; if(calls===2)throw Error('statement timeout');
   return {paid:batch.length,rows:batch.map(r=>({row_number:r.rowNumber,reference_no:r.referenceNo,outcome:'paid'}))};
 }});
 assert.equal(calls,3);assert.equal(result.paid,25);assert.equal(result.rejected,20);
 assert.equal(result.rows.length,45);assert.equal(new Set(result.rows.map(r=>r.row_number)).size,45);
});
test('deadline returns unfinished rows without dispatching more transactions',async()=>{
 let calls=0;
 const result=await finalizeBankResponseBatches({rows,deadlineAt:0,now:()=>1,finalize:async()=>{calls++;return {};}});
 assert.equal(calls,0);assert.equal(result.rejected,45);
});
test('a retry of a committed batch never counts previous paid results as newly paid',async()=>{
 const result=await finalizeBankResponseBatches({rows:rows.slice(0,2),deadlineAt:1,now:()=>0,finalize:async batch=>({replayed:true,paid:2,rows:batch.map(r=>({row_number:r.rowNumber,outcome:'paid'}))})});
 assert.equal(result.paid,0);assert.equal(result.replayed_items,2);assert.deepEqual(result.replayed_row_numbers,[3,4]);
});
test('terminal evidence may be verified again only by the same permitted processor scope',()=>{
 const scope={userId:'u',effectiveRoleIds:['finance'],hasAllLocationAccess:false,locationScopeIds:['s']};
 const request={status:'processed',approval_status:'PROCESSED',location_id:'s',payment_process_role_ids:['finance']};
 assert.equal(canReconcilePayment(scope,request,false),true);
 assert.equal(canReconcilePayment({...scope,readOnly:true},request,true),false);
 assert.equal(canReconcilePayment(scope,{...request,location_id:'other'},true),false);
 assert.equal(canReconcilePayment(scope,{...request,payment_process_role_ids:['other']},false),false);
 assert.equal(canReconcilePayment(scope,{...request,status:'pending',approval_status:'PENDING'},true),false);
});
test('diagnostics identify bank columns and distinguish access/server errors from editable cells',()=>{
 assert.equal(bankResponseGuidance('IFSC mismatch').column,'IFSC Code');
 assert.equal(bankResponseGuidance('Credit Account is required').column,'Credit Account');
 assert.equal(bankResponseGuidance('Amount mismatch').column,'Debit Amount');
 assert.equal(bankResponseGuidance('statement timeout').column,'');
 assert.match(bankResponseGuidance('Your role cannot reconcile').action,/Finance/);
 assert.match(bankResponseCsv([{file:'=cmd',rowNumber:3,referenceNo:'R',outcome:'Exception',message:'a,"b"'}]),/"'=cmd"/);
});
