import test from 'node:test';
import assert from 'node:assert/strict';
import { expenseVariance, estimatedCps, estimatedShipments } from './expense-variance.ts';
test('cost uses request shipments and treats missing actual as pending',()=>{
 assert.equal(estimatedCps(1800,40),45);assert.equal(estimatedCps(1800,0),null);assert.equal(estimatedCps(null,40),null);
 const r=expenseVariance({amount_requested:1200,amount:1800});assert.equal(r.delta,600);assert.equal(r.percent,50);assert.equal(r.overrun,true);
 assert.equal(expenseVariance({amount_requested:1200,amount:null}).state,'Actual pending');
 assert.equal(expenseVariance({amount_requested:1200,amount:0}).delta,-1200);
 assert.equal(expenseVariance({amount_requested:1200,amount:1800,status:'rejected'}).overrun,false);
});
test('configured estimate takes precedence over unique tracking IDs',()=>{
 const answers=[{answer_value:'T1 T1,T2;T3',payment_head_questions:{question_text:'Tracking IDs'}}];assert.equal(estimatedShipments(answers),3);
 assert.equal(estimatedShipments([...answers,{answer_value:'40',payment_head_questions:{question_text:'Estimated shipments'}}]),40);
});

test('CPS ignores report headings in pasted tracking evidence',()=>{
 assert.equal(estimatedShipments([{answer_value:'Details for Count of Tracking ID Station: GDRD 372952359018 372944216961',payment_head_questions:{question_text:'Tracking IDs'}}]),2);
});
