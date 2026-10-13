import test from 'node:test';
import assert from 'node:assert/strict';
import {codStatusChecks,codStatusCategory} from './cod-status.ts';
const at=s=>Date.parse(s+'+05:30');
const policy={rule:'Next Day',start:'10:00',end:'10:30',preparationFrom:'16:00'};
const clearRecon={complete:true,driverCount:1,pendingCount:0,pendingAmount:0,drivers:[]};
const remit=(created,status='CREATED')=>({id:'remit',code:'AC1',status,expectedAmount:167245.32,actualAmount:167245.32,variance:0,createdAt:at(created),updatedAt:at(created),submittedAt:status==='SUBMITTED'?at(created):null});
function snapshot(clock,{da=0,collected='2026-10-13T11:00:00',cash=0,remittances=[]}={}) {
 const now=new Date(at(clock));const component=data=>({state:'ok',checkedAt:now.toISOString(),data});
 return {version:1,stationCode:'GDRD',date:clock.slice(0,10),fetchedAt:now.toISOString(),reconciliation:component(da?{...clearRecon,pendingCount:1,pendingAmount:da,drivers:[{id:'da',name:'DA',pendingAmount:da,packages:[{trackingId:'tid',amount:da,collectedAt:at(collected)}]}]}:clearRecon),prepareDeposit:component({expectedAmount:cash,actualAmount:cash,variance:0,sourceScope:'outstanding_history',sourceWindow:{startTime:0,endTime:at(clock.slice(0,10)+'T23:59:59')}}),remittances:component({complete:true,openCount:remittances.filter(r=>r.status==='CREATED').length,latestSubmitted:remittances.find(r=>r.status==='SUBMITTED')||null,rows:remittances})};
}
const checks=(s,clock,minutes=15)=>codStatusChecks(s,policy,new Date(at(clock)),false,'','21:00',minutes);
test('cash lifecycle: delivery → overdue DA → station cash → prepared → pickup due → submitted',()=>{
 let s=snapshot('2026-10-13T12:00:00',{da:100});assert.equal(checks(s,'2026-10-13T12:00:00').reconciliation.tone,'active');
 s=snapshot('2026-10-13T21:00:00',{da:100});assert.equal(checks(s,'2026-10-13T21:00:00').reconciliation.tone,'attention');
 s=snapshot('2026-10-13T21:02:00',{cash:167245.32});let c=checks(s,'2026-10-13T21:02:00');assert.equal(c.reconciliation.tone,'clear');assert.equal(c.prepareDeposit.tone,'waiting');assert.equal(c.remittances.tone,'clear');
 const open=remit('2026-10-13T21:05:00');s=snapshot('2026-10-13T21:05:00',{remittances:[open]});c=checks(s,'2026-10-13T21:05:00');assert.equal(c.prepareDeposit.tone,'clear');assert.equal(c.remittances.tone,'waiting');
 s=snapshot('2026-10-14T10:31:00',{remittances:[open]});assert.equal(checks(s,'2026-10-14T10:31:00').remittances.tone,'attention');
 s=snapshot('2026-10-14T10:32:00',{remittances:[remit('2026-10-14T10:32:00','SUBMITTED')]});assert.equal(codStatusCategory(s,new Date(at('2026-10-14T10:32:00')),policy,false,'','21:00',15),'clear');
});
test('prior-day TID flags during daytime; current-day selection leaves live cash unchanged',()=>{
 const s=snapshot('2026-10-13T12:00:00',{da:100,collected:'2026-10-12T11:00:00',cash:167245.32});
 assert.equal(checks(s,'2026-10-13T12:00:00').reconciliation.tone,'attention');
 const today=codStatusChecks(s,policy,new Date(at('2026-10-13T12:00:00')),false,'2026-10-13','21:00',15);
 assert.equal(today.prepareDeposit.tone,'waiting');assert.equal(s.prepareDeposit.data.expectedAmount,167245.32);
});
test('old worker zero, missing component check, failure and stale cache can never clear a station',()=>{
 const clock='2026-10-13T12:00:00';let s=snapshot(clock);
 delete s.prepareDeposit.data.sourceScope;assert.equal(checks(s,clock).prepareDeposit.tone,'unavailable');
 s=snapshot(clock);delete s.prepareDeposit.checkedAt;assert.equal(checks(s,clock).prepareDeposit.tone,'unavailable');
 s=snapshot(clock);s.prepareDeposit.state='unavailable';assert.equal(checks(s,clock).prepareDeposit.tone,'unavailable');
 s=snapshot(clock);assert.equal(checks(s,'2026-10-13T12:11:00',10).prepareDeposit.tone,'unavailable');assert.equal(checks(s,'2026-10-13T12:11:00',15).prepareDeposit.tone,'clear');
 assert.equal(checks(s,'2026-10-13T12:00:00',null).prepareDeposit.tone,'unavailable');
 assert.equal(checks(s,'2026-10-13T11:58:00').prepareDeposit.tone,'unavailable');
});
