import test from 'node:test';
import assert from 'node:assert/strict';
import {statementGroups,statementHead,entryTotals,groupEntries,emptyFilters,filterEntries} from './analysis.ts';
const entry=(id,head,paise,extra={})=>({id,head,paise,side:'expense',station:'A',...extra});

test('approvals and spelling variants form one Adhoc Van head without changing the source records',()=>{
 const rows=Array.from({length:10},(_,i)=>entry(`approval${i}`,['Adhoc Van','Ad hoc van','Van Adhoc','Adhoc Van · REQ-1'][i%4],10000+i));
 const before=JSON.stringify(rows),groups=statementGroups(rows);
 assert.equal(groups.length,1);assert.equal(groups[0].head,'Adhoc Van');assert.equal(groups[0].entries.length,10);
 assert.equal(groups[0].paise,100045);assert.equal(JSON.stringify(rows),before);
});
test('fuel and broadband aliases combine, but generator fuel and unknown expenses stay distinct',()=>{
 const heads=['Van Fuel','Van Fuel Expenses','IOCL fuel','BPCL fuel','Generator Fuel Expenses','Broadband Charge','Broadband Expenses','New custom cost'];
 const groups=statementGroups(heads.map((h,i)=>entry(String(i),h,100)));
 assert.equal(groups.find(g=>g.head==='Vehicle fuel').paise,400);
 assert.equal(groups.find(g=>g.head==='Broadband').paise,200);
 assert.ok(groups.some(g=>g.head==='Generator Fuel Expenses'));assert.ok(groups.some(g=>g.head==='New custom cost'));
 assert.equal(statementHead({side:'income',head:'Van Fuel'}),'Van Fuel');
});
test('grouped cost totals and each comparison column reconcile after corrections, credits, deletion and filtering',()=>{
 const dimensions=[{code:'A',region:'KL',state:'Kerala',model:'EDSP',managers:['Manager A','Manager B']},{code:'B',region:'AP',state:'Andhra Pradesh',model:'EDSP',managers:['Manager C']}];
 const entries=[entry('1','Adhoc Van',101,{modified:true}),entry('2','Van Adhoc',-21),entry('3','Adhoc Van',500,{deleted:true}),entry('4','Adhoc Van',60,{station:'B'}),entry('5','Invoice',1000,{side:'income'}),entry('6','Debit',-70,{side:'income',station:'B'})];
 const active=filterEntries(entries,dimensions,emptyFilters());
 assert.equal(statementGroups(active).filter(g=>g.side==='expense').reduce((n,g)=>n+g.paise,0),140);
 for(const by of ['station','region','state','model','manager']){
  const columns=groupEntries(active,dimensions,by);
  assert.equal(columns.reduce((n,g)=>n+g.expense,0),140);
  assert.equal(columns.reduce((n,g)=>n+g.income,0),930);
  for(const head of statementGroups(active))assert.equal(columns.reduce((n,col)=>n+head.entries.filter(e=>col.entries.includes(e)).reduce((s,e)=>s+e.paise,0),0),head.paise);
 }
 const filtered=filterEntries(entries,dimensions,{...emptyFilters(),region:['KL']});
 assert.equal(statementGroups(filtered).find(g=>g.head==='Adhoc Van').paise,80);
 assert.equal(entryTotals(filtered).profit,920);
});
