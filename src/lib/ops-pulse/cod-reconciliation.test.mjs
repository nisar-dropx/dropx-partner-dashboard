import test from 'node:test';
import assert from 'node:assert/strict';
import {reconciliationView,reconciliationAgeing,collectionDay,validCollectionDate} from './cod-reconciliation.ts';
import {codStatusChecks,compareCodRows} from './cod-status.ts';
const at=s=>Date.parse(s+'+05:30'), now=new Date(at('2026-10-13T12:00:00'));
const pkg=(day,amount=100)=>({trackingId:day,amount,paymentMethod:'CASH',collectedAt:at(day+'T11:00:00'),transactionAt:at('2026-10-13T11:30:00')});
const data=(packages,pendingAmount=packages.reduce((s,p)=>s+p.amount,0))=>({complete:true,driverCount:2,pendingCount:pendingAmount?1:0,pendingAmount,completedPercent:pendingAmount?50:100,drivers:pendingAmount?[{id:'da',name:'DA',pendingAmount,packages}]:[]});
test('SCC recovered cash is counted without turning its update time into a collection date',()=>{
 const d=data([{trackingId:'missing-roster',amount:2925.81,paymentMethod:'CASH',collectedAt:null,transactionAt:null,source:'scc_cash_with_associate',sourceUpdatedAt:now.getTime()}]);
 const all=reconciliationView(d,'','21:00',now);assert.equal(all.amount,2925.81);assert.equal(all.unknownAmount,2925.81);assert.equal(all.todayAmount,0);assert.equal(all.check.tone,'unavailable');
 assert.equal(reconciliationView(d,'undated','21:00',now).amount,2925.81);
 assert.equal(reconciliationView(d,'2026-10-13','21:00',now).check.tone,'unavailable');
 assert.equal(reconciliationAgeing(d,1,now).count,0);
});
test('daytime cash is normal, configurable evening deadline flags outstanding cash',()=>{
 const r=data([pkg('2026-10-13')]);
 assert.equal(reconciliationView(r,'','21:00',now).check.tone,'active');
 assert.equal(reconciliationView(r,'','21:00',new Date(at('2026-10-13T20:59:59'))).check.tone,'active');
 assert.equal(reconciliationView(r,'','21:00',new Date(at('2026-10-13T21:00:00'))).check.tone,'attention');
 assert.equal(reconciliationView(r,'','22:00',new Date(at('2026-10-13T21:00:00'))).check.tone,'active');
 assert.equal(reconciliationView(r,'',null,new Date(at('2026-10-13T23:00:00'))).check.tone,'active');
 assert.match(reconciliationView(r,'',null,now).check.reason,/Set a DA reconciliation deadline/);
});
test('prior cash is overdue during daytime, despite a transaction update today',()=>{
 const r=reconciliationView(data([pkg('2026-10-12')]),'','21:00',now);
 assert.equal(r.check.tone,'attention');assert.equal(r.priorAmount,100);assert.equal(r.todayAmount,0);
});
test('selecting collection date changes amount, DA count and status together without hiding total older cash',()=>{
 const source=data([pkg('2026-10-12',250),pkg('2026-10-13',100)]);
 const today=reconciliationView(source,'2026-10-13','21:00',now);
 assert.equal(today.amount,100);assert.equal(today.drivers[0].packages.length,1);assert.equal(today.check.tone,'active');assert.equal(today.priorAmount,250);
 const old=reconciliationView(source,'2026-10-12','21:00',now);assert.equal(old.amount,250);assert.equal(old.check.tone,'attention');
 const none=reconciliationView(source,'2026-10-11','21:00',now);assert.equal(none.pendingCount,0);assert.equal(none.check.label,'No pending cash for this date');
 assert.equal(source.pendingAmount,350);
});
test('missing collection dates, partial breakdowns and negative adjustments never clear a selected date',()=>{
 const noDate={...pkg('2026-10-12'),collectedAt:null};
 const source=data([pkg('2026-10-13'),noDate],300);
 const r=reconciliationView(source,'2026-10-13','21:00',now);
 assert.equal(r.amount,100);assert.equal(r.unknownAmount,200);assert.equal(r.check.tone,'unavailable');
 const undated=reconciliationView(source,'undated','21:00',now);assert.equal(undated.amount,200);assert.equal(undated.drivers[0].packages.length,1);
 assert.equal(reconciliationView(data([],100),'2026-10-12','21:00',now).check.tone,'unavailable');
 assert.equal(reconciliationView(data([pkg('2026-10-13',-20)]),'','21:00',now).check.tone,'unavailable');
});
test('today becomes earlier-day overdue at IST midnight across month/year; invalid dates fail closed',()=>{
 const r=data([{...pkg('2026-12-31'),collectedAt:at('2026-12-31T23:00:00')}]);
 assert.equal(reconciliationView(r,'','23:30',new Date(at('2027-01-01T00:00:00'))).check.tone,'attention');
 assert.equal(collectionDay(at('2026-10-13T00:01:00'),now),'2026-10-13');
 for(const date of ['2026-02-30','2026-10-14','13/10/2026']) assert.equal(validCollectionDate(date,'2026-10-13'),false);
 assert.equal(validCollectionDate('2026-10-12','2026-10-13'),true);
 assert.equal(reconciliationView(r,'2027-99-99',null,now).check.tone,'unavailable');
 assert.equal(collectionDay(at('2026-10-14T10:00:00'),now),null);
});
test('a DA date filter never changes prepare-deposit and remittance assessment; numeric sort follows displayed cohort',()=>{
 const snapshot=r=>({date:'2026-10-13',fetchedAt:now.toISOString(),reconciliation:{state:'ok',checkedAt:now.toISOString(),data:r},prepareDeposit:{state:'ok',checkedAt:now.toISOString(),data:{sourceScope:'outstanding_history',sourceWindow:{startTime:0,endTime:now.getTime()},expectedAmount:50,actualAmount:50,variance:0}},remittances:{state:'ok',checkedAt:now.toISOString(),data:{complete:true,openCount:0,rows:[],latestSubmitted:null}}});
 const a={id:'a',code:'AAA'},b={id:'b',code:'BBB'};
 const sa=snapshot(data([pkg('2026-10-13',2),pkg('2026-10-12',200)])),sb=snapshot(data([pkg('2026-10-13',100)]));
 const old=codStatusChecks(sa,null,now,false,'2026-10-12','21:00'),today=codStatusChecks(sa,null,now,false,'2026-10-13','21:00');
 assert.deepEqual(old.prepareDeposit,today.prepareDeposit);assert.deepEqual(old.remittances,today.remittances);
 assert.deepEqual([b,a].sort((x,y)=>compareCodRows(x,y,{a:sa,b:sb},'reconciliation','asc',now,'2026-10-13')).map(x=>x.id),['a','b']);
});

test('age flag isolates older positive TIDs across dates and uses the editable threshold',()=>{
 const source=data([pkg('2026-10-12',100),pkg('2026-10-01',250),pkg('2026-10-13',25)]);
 assert.equal(reconciliationAgeing(source,1,now).count,2);
 assert.equal(reconciliationAgeing(source,2,now).amount,250);
 assert.equal(reconciliationAgeing(source,2,now).oldestDays,12);
 assert.equal(reconciliationAgeing(source,null,now).configured,false);
 assert.equal(reconciliationAgeing(source,null,now).count,0);
});
test('negative adjustments cannot hide a positive overdue TID',()=>{
 const source=data([pkg('2026-10-12',100),pkg('2026-10-12',-100),pkg('2026-10-13',20)]);
 assert.equal(reconciliationView(source,'','21:00',now).check.tone,'attention');
 assert.equal(reconciliationAgeing(source,1,now).amount,100);
});
