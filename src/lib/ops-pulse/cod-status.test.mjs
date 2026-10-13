import test from 'node:test';
import assert from 'node:assert/strict';
import { codStatusCategory, codStatusChecks, codStatusToday, classifyRemittance, codStatusOwner, matchesCodFilters, compareCodRows } from './cod-status.ts';
const at=(s)=>Date.parse(s+'+05:30');
const now=new Date(at('2026-10-12T21:30:00'));
const policy={rule:'Next Day',start:'10:00',end:'10:30',preparationFrom:'16:00'};
const remit=(created,status='CREATED')=>({id:created,code:'AC1',status,expectedAmount:100,actualAmount:100,variance:0,createdAt:at(created),updatedAt:at(created),submittedAt:null});
const latest={...remit('2026-10-12T12:00:00','SUBMITTED'),submittedAt:at('2026-10-12T12:00:00')};
function base(open=[],date=now) {return {date:codStatusToday(date),fetchedAt:date.toISOString(),reconciliation:{state:'ok',checkedAt:now.toISOString(),data:{complete:true,pendingCount:0,pendingAmount:0}},prepareDeposit:{state:'ok',checkedAt:now.toISOString(),data:{sourceScope:'outstanding_history',sourceWindow:{startTime:0,endTime:now.getTime()},expectedAmount:0,actualAmount:0,variance:0}},remittances:{state:'ok',checkedAt:now.toISOString(),data:{complete:true,openCount:open.length,submittedToday:true,latestSubmitted:latest,rows:[...open,latest]}}};}
test('three independent checks: zero prepare stays green while expected next-day pickup stays amber',()=>{
 const s=base([remit('2026-10-12T21:00:00')]);const c=codStatusChecks(s,policy,now);
 assert.equal(c.prepareDeposit.tone,'clear');assert.equal(c.remittances.tone,'waiting');assert.equal(codStatusCategory(s,now,policy),'waiting');
 assert.equal(codStatusCategory(base(),now,policy),'clear');
});
test('4 pm cutoff: daytime after deposit flags; exactly 4 pm and later are allowed',()=>{
 for(const hour of ['12:01:00','15:59:59']) assert.equal(classifyRemittance(remit('2026-10-12T'+hour),latest,policy,now).tone,'attention');
 for(const hour of ['16:00:00','21:00:00']) assert.equal(classifyRemittance(remit('2026-10-12T'+hour),latest,policy,now).tone,'waiting');
 assert.equal(classifyRemittance(remit('2026-10-12T16:30:00'),latest,{...policy,preparationFrom:'17:00'},now).tone,'attention');
});
test('earlier open rows are retained but are not new-deposit timing alerts',()=>{
 const r=remit('2026-10-12T11:30:00');const s=base([r]);assert.equal(codStatusChecks(s,policy,now).remittances.tone,'clear');assert.equal(s.remittances.data.rows[0].status,'CREATED');
 // An updated old submission must not replace the actual submission time.
 assert.equal(classifyRemittance(remit('2026-10-12T13:00:00'),{...latest,updatedAt:at('2026-10-12T20:00:00')},policy,now).tone,'attention');
});
test('next-day preparation survives midnight and becomes overdue only after pickup end',()=>{
 const r=remit('2026-10-12T21:00:00');
 assert.equal(classifyRemittance(r,latest,policy,new Date(at('2026-10-13T00:10:00'))).tone,'waiting');
 assert.equal(classifyRemittance(r,latest,policy,new Date(at('2026-10-13T10:30:00'))).tone,'waiting');
 assert.equal(classifyRemittance(r,latest,policy,new Date(at('2026-10-13T10:30:01'))).tone,'attention');
 const year=classifyRemittance(remit('2026-12-31T21:00:00'),null,policy,new Date(at('2027-01-01T09:00:00')));
 assert.equal(year.dueAt,at('2027-01-01T10:30:00'));assert.equal(year.tone,'waiting');
});
test('morning preparation without today’s submission uses today’s pickup',()=>{
 const r=remit('2026-10-12T08:00:00');assert.equal(classifyRemittance(r,null,policy,new Date(at('2026-10-12T09:00:00'))).tone,'waiting');assert.equal(classifyRemittance(r,null,policy,now).tone,'attention');
});
test('same-day complete and partial policies have different carry-forward rules',()=>{
 const r=remit('2026-10-12T19:00:00');
 assert.equal(classifyRemittance(r,latest,{rule:'Same Day-Complete',start:'18:00',end:'18:30'},now).tone,'attention');
 assert.equal(classifyRemittance(r,latest,{rule:'Same Day-Partial',start:'18:00',end:'18:30'},now).tone,'waiting');
});
test('missing timestamps, settings, source records and stale checks do not become green',()=>{
 const r=remit('2026-10-12T21:00:00');
 assert.equal(classifyRemittance({...r,createdAt:null},latest,policy,now).tone,'unavailable');
 assert.equal(classifyRemittance(r,latest,null,now).tone,'unavailable');
 assert.equal(classifyRemittance(r,latest,{...policy,preparationFrom:null},now).tone,'unavailable');
 const s=base([r]);s.remittances.data.complete=false;assert.equal(codStatusChecks(s,policy,now).remittances.tone,'unavailable');
 s.remittances.data.complete=true;s.remittances.data.openCount=2;assert.equal(codStatusCategory(s,now,policy),'unavailable');
 s.fetchedAt='2026-10-11T00:00:00Z';assert.equal(codStatusCategory(s,now,policy),'unavailable');
 assert.equal(codStatusCategory(undefined,now),'unchecked');assert.equal(codStatusCategory(base(),now,policy,true),'unavailable');
 const missing=base();missing.prepareDeposit.state='unavailable';assert.equal(codStatusCategory(missing,now,policy),'unavailable');
});
test('cash difference flags red; pending DA cash stays separate from remittance status',()=>{
 const s=base();s.reconciliation.data.pendingCount=2;assert.equal(codStatusChecks(s,policy,now).reconciliation.tone,'unavailable');assert.equal(codStatusChecks(s,policy,now).remittances.tone,'clear');
 s.prepareDeposit.data.variance=-10;assert.equal(codStatusCategory(s,now,policy),'attention');
});
test('People cluster takes priority and AOM is used only when no cluster exists',()=>{
 assert.deepEqual(codStatusOwner({cluster_manager_names:['Cluster'],aom_names:['AOM']}).managers,['Cluster']);
 assert.equal(codStatusOwner({cluster_manager_names:[],aom_names:['AOM']}).managerRole,'AOM');assert.equal(codStatusOwner({}).managerRole,'Unmapped');
});
test('all filters intersect and numeric sorts keep missing values last',()=>{
 const a={id:'a',code:'AAA',model:'EDSP',name:'Test',region:'AP',...codStatusOwner({aom_names:['Person']})};const b={...a,id:'b',code:'BBB'};const c={...a,id:'c',code:'CCC'};
 const checks=codStatusChecks(base(),policy,now);
 assert.ok(matchesCodFilters(a,checks,'clear',{region:'AP',manager:'Person',prepareDeposit:'clear',remittances:'clear'}));assert.ok(!matchesCodFilters(a,checks,'clear',{region:'KL',manager:'Person'}));assert.ok(!matchesCodFilters(a,checks,'clear',{reconciliation:'waiting'}));
 const sa=base(),sb=base();sa.prepareDeposit.data.expectedAmount=2;sb.prepareDeposit.data.expectedAmount=100;
 const data={a:sa,b:sb};assert.deepEqual([c,b,a].sort((x,y)=>compareCodRows(x,y,data,'prepareDeposit','desc',now)).map(x=>x.id),['b','a','c']);
 assert.deepEqual([c,b,a].sort((x,y)=>compareCodRows(x,y,data,'prepareDeposit','asc',now)).map(x=>x.id),['a','b','c']);
});
test('date rolls over at IST midnight',()=>assert.equal(codStatusToday(new Date('2026-10-11T19:00:00Z')),'2026-10-12'));
