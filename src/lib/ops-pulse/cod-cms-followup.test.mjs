import test from 'node:test';
import assert from 'node:assert/strict';
import { codCmsContact, overdueCodRemittances } from './cod-cms-followup.ts';
import { codStatusToday } from './cod-status.ts';
const at=s=>Date.parse(s+'+05:30');
const policy={rule:'Next Day',start:'10:00',end:'10:30',preparationFrom:'16:00'};
const remit=(created,status='CREATED')=>({id:created,code:'AC1',status,expectedAmount:100,actualAmount:100,variance:0,createdAt:at(created),updatedAt:at(created),submittedAt:status==='SUBMITTED'?at(created):null});
function snapshot(now,rows,latestSubmitted=null) {
 const checkedAt=now.toISOString();
 return {date:codStatusToday(now),fetchedAt:checkedAt,
 reconciliation:{state:'unavailable',checkedAt,data:null},prepareDeposit:{state:'unavailable',checkedAt,data:null},
 remittances:{state:'ok',checkedAt,data:{complete:true,openCount:rows.filter(r=>r.status==='CREATED').length,rows,latestSubmitted}}};
}
const check=(s,p,now,failed=false,maxAge=15)=>overdueCodRemittances(s,p,now,failed,maxAge);
test('CMS contacts appear only after the next-day pickup deadline, independently of other COD balances',()=>{
 const r=remit('2026-10-12T17:00:00');
 for(const clock of ['00:01:00','10:29:59','10:30:00']) {
  const now=new Date(at('2026-10-13T'+clock));assert.equal(check(snapshot(now,[r]),policy,now).length,0);
 }
 const now=new Date(at('2026-10-13T10:30:01'));
 assert.deepEqual(check(snapshot(now,[r]),policy,now).map(c=>c.dueAt),[at('2026-10-13T10:30:00')]);
});
test('per-station pickup changes move the follow-up deadline; partial collections carry forward',()=>{
 const now=new Date(at('2026-10-13T11:00:00')), r=remit('2026-10-12T17:00:00'), s=snapshot(now,[r]);
 assert.equal(check(s,{...policy,end:'11:30'},now).length,0);
 assert.equal(check(s,{...policy,end:'10:45'},now).length,1);
 const late=remit('2026-10-13T19:00:00'), evening=new Date(at('2026-10-13T20:00:00'));
 assert.equal(check(snapshot(evening,[late]),{rule:'Same Day-Partial',start:'18:00',end:'18:30'},evening).length,0);
 assert.equal(check(snapshot(evening,[late]),{rule:'Same Day-Complete',start:'18:00',end:'18:30'},evening).length,1);
});
test('early preparation, submitted records and open records before a later submission do not imply missed pickup',()=>{
 const now=new Date(at('2026-10-13T15:00:00')), submitted=remit('2026-10-13T12:00:00','SUBMITTED');
 assert.equal(check(snapshot(now,[remit('2026-10-13T13:00:00'),submitted],submitted),policy,now).length,0);
 assert.equal(check(snapshot(now,[remit('2026-10-12T17:00:00'),submitted],submitted),policy,now).length,0);
 assert.equal(check(snapshot(now,[submitted],submitted),policy,now).length,0);
});
test('failed, stale, missing or unverified remittance data never shows overdue follow-up',()=>{
 const now=new Date(at('2026-10-13T15:00:00')), s=snapshot(now,[remit('2026-10-12T17:00:00')]);
 assert.equal(check(s,policy,now,true).length,0);assert.equal(check(s,null,now).length,0);assert.equal(check(s,policy,now,false,null).length,0);
 assert.equal(check(undefined,policy,now).length,0);
 assert.equal(check({...s,fetchedAt:'2026-10-12T00:00:00Z'},policy,now).length,0);
 assert.equal(check({...s,remittances:{...s.remittances,checkedAt:'2026-10-12T00:00:00Z'}},policy,now).length,0);
 assert.equal(check({...s,remittances:{...s.remittances,state:'unavailable'}},policy,now).length,0);
 const unknown=snapshot(now,[{...s.remittances.data.rows[0],createdAt:null}]);assert.equal(check(unknown,policy,now).length,0);
});
test('contact projection uses master values, supports multiple escalation emails, and excludes credentials',()=>{
 const contact=codCmsContact({cms_agency:' Agency ',agent_name:' Person ',agent_mobile:' +919999999999 ',escalation_contact:' Duty manager ',escalation_email:' first@example.com; second@example.com, first@example.com ',portal_secret_name:'private'});
 assert.deepEqual(contact,{agency:'Agency',name:'Person',phone:'+919999999999',escalationContact:'Duty manager',escalationEmails:['first@example.com','second@example.com']});
 assert.deepEqual(codCmsContact(),{agency:null,name:null,phone:null,escalationContact:null,escalationEmails:[]});
});
