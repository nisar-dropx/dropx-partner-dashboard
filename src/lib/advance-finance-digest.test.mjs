import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceFinanceCutoff,advanceFinanceMessages} from './advance-finance-digest-model.ts';
import {deliverInitialAdvanceMail} from './advance-approval-mail-delivery.ts';
const date='2026-11-02', company='company-a';
const row=(extra={})=>({company_id:company,request_id:'r1',request_number:'ADV-1',worker_name:'A & B <script>',worker_code:'W1',station_code:'S1',requested_amount:'2000.50',approved_amount:'1800',reason:'Travel',requested_at:'2026-11-01T06:00:00Z',available_at:'2026-11-02T11:29:00Z',approver_user_id:'m1',recipient_email:'manager@example.com',recipient_name:'Manager',queue_stage:'approval',...extra});
const messages=rows=>advanceFinanceMessages(rows,company,date,'example.com','Advance requests · Finance queue');
test('5 p.m. IST cutoff includes the boundary, carries old requests, excludes later requests',()=>{
 assert.equal(advanceFinanceCutoff(date),'2026-11-02T11:30:00.000Z');
 const result=messages([row(),row({request_id:'r2',available_at:'2026-11-02T11:30:00Z'}),row({request_id:'r3',available_at:'2026-11-02T11:30:00.001Z'})]);
 assert.equal(result.length,1);assert.deepEqual(result[0].scope.requestIds,['r1','r2']);assert.equal(result[0].scope.approvalTotal,4001);
});
test('approval and approved payment totals remain separate, recipient queues never leak',()=>{
 const result=messages([row(),row({request_id:'r2',queue_stage:'payment'}),row({request_id:'r3',approver_user_id:'m2',recipient_email:'other@example.com'})]);
 assert.equal(result.length,2);assert.equal(result[0].scope.approvalTotal,2000.50);assert.equal(result[0].scope.paymentTotal,1800);assert.deepEqual(result[1].scope.requestIds,['r3']);
 assert.ok(!result[0].html.includes('<script>'));assert.ok(result[0].html.includes('&lt;script&gt;'));
});
test('invalid, duplicate, cross-company and out-of-domain sources fail closed',()=>{
 for(const records of [[row(),row()],[row({company_id:'other'})],[row({recipient_email:'outsider@else.com'})],[row({requested_amount:'NaN'})],[row({queue_stage:'payment',approved_amount:null})]])assert.throws(()=>messages(records));
 assert.throws(()=>advanceFinanceCutoff('2026-02-30'));assert.deepEqual(messages([]),[]);
});
const thread={id:'t1',company_id:company,request_id:'r1',step_key:'s1',recipient_user_id:'m1',recipient_email:'manager@example.com',request_label:'ADV-1 · Worker',request_summary:'INR 2,000',subject:null,root_message_id:null,last_message_id:null,send_count:0,lease_token:'lease'};
function deps(){const calls=[];return {calls,current:async()=>true,prepare:async s=>calls.push(['prepare',s]),send:async m=>{calls.push(['send',m]);return {messageId:m.messageId,response:'250 accepted',accepted:[thread.recipient_email]}},finish:async o=>calls.push(['finish',o])};}
test('initial notification uses the shared reminder subject and deterministic message ID',async()=>{
 const d=deps();assert.equal(await deliverInitialAdvanceMail(thread,d),true);assert.equal(d.calls[0][0],'prepare');
 const m=d.calls.find(c=>c[0]==='send')[1];assert.equal(m.subject,'Approval required: Pay advance — ADV-1 · Worker');assert.equal(m.messageId,'<dropx.approval.t1.1@people.dropxlogistics.com>');assert.equal(m.inReplyTo,undefined);
});
test('later messages retain subject and both reply headers',async()=>{
 const d=deps();await deliverInitialAdvanceMail({...thread,subject:'Original subject',send_count:3,root_message_id:'<root>',last_message_id:'<last>'},d);
 const m=d.calls.find(c=>c[0]==='send')[1];assert.equal(m.subject,'Original subject');assert.equal(m.inReplyTo,'<last>');assert.deepEqual(m.references,['<root>','<last>']);
});
test('SMTP address case normalization does not create false retry failures',async()=>{
 const d=deps();assert.equal(await deliverInitialAdvanceMail({...thread,recipient_email:'Manager@Example.com'},d),true);
 assert.equal(d.calls.at(-1)[1].status,'sent');
});
test('reassignment prevents send; SMTP failure records retry; accepted receipt error never records false failure',async()=>{
 let d=deps();d.current=async()=>false;await deliverInitialAdvanceMail(thread,d);assert.equal(d.calls.some(c=>c[0]==='send'),false);
 d=deps();d.send=async()=>{throw Error('SMTP unavailable')};await deliverInitialAdvanceMail(thread,d);assert.equal(d.calls.at(-1)[1].status,'failed');
 d=deps();let finishes=0;d.finish=async()=>{finishes++;throw Error('receipt DB unavailable')};await assert.rejects(deliverInitialAdvanceMail(thread,d));assert.equal(finishes,1);
});
