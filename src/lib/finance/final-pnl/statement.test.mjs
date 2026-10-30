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

const {invoiceRegister,entryCoverage}=await import('./analysis.ts');
test('deleted rows never leak into direct totals or comparison columns',()=>{
 const rows=[entry('live','Rent',100),entry('removed','Rent',900,{deleted:true}),entry('income','Sales',1000,{side:'income'}),entry('removed-income','Sales',4000,{side:'income',deleted:true})];
 const totals=entryTotals(rows);assert.equal(totals.expense,100);assert.equal(totals.income,1000);assert.equal(totals.profit,900);
 const groups=groupEntries(rows,[{code:'A',region:'KL',managers:['M']}],'region');assert.equal(groups[0].expense,100);assert.equal(groups[0].income,1000);assert.equal(groups[0].entries.length,2);
});
test('invoice register preserves rejected documents and distinguishes duplicate references by supplier identity',()=>{
 const dims=[{code:'A',region:'KL',state:'Kerala',model:'EDSP',managers:['A']},{code:'B',region:'AP',state:'Andhra Pradesh',model:'EDSP',managers:['B']}];
 const invoices=[{key:'GST1:INV1',reference:'INV1',station:'XPT-A',issues:[]},{key:'GST2:INV1',reference:'INV1',station:'B',issues:[]},{key:'GST1:BAD',reference:'BAD',station:'A',issues:['PDF does not reconcile']},{key:'GST1:UNKNOWN',reference:'UNKNOWN',station:'UNKNOWN',issues:['Station mapping unavailable']}];
 const rows=[entry('invoice:GST1:INV1:taxable:0','Sales',100,{side:'income'}),entry('invoice:GST2:INV1:taxable:0','Sales',200,{station:'B',side:'income'})];
 assert.equal(invoiceRegister(invoices,rows,dims,emptyFilters()).length,4);
 assert.deepEqual(invoiceRegister(invoices,rows,dims,{...emptyFilters(),region:['KL']}).map(i=>i.key),['GST1:INV1','GST1:BAD']);
 assert.deepEqual(invoiceRegister(invoices,rows,dims,emptyFilters(),'B').map(i=>i.key),['GST2:INV1']);
 rows[0].deleted=true;assert.deepEqual(invoiceRegister(invoices,rows,dims,emptyFilters(),'A').map(i=>i.key),['GST1:INV1','GST1:BAD']);
});
test('coverage distinguishes missing invoices, missing operating costs and confirmed zero records',()=>{
 const rows=[entry('income-A','Service income',100,{side:'income'}),entry('ho-allocation:A','Regional HO allocation',10),entry('expense-B','Workforce payouts',30,{station:'B'}),entry('recovery-B','Loss recovery',5,{station:'B',side:'income',recovery:true}),entry('income-C','Service income',100,{station:'C',side:'income'}),entry('zero-C','Rent',0,{station:'C'})];
 assert.deepEqual(entryCoverage(rows),{missingIncome:['B'],missingExpenses:['A']});
 assert.equal(entryCoverage([...rows,entry('removed','Pay',200,{deleted:true})]).missingExpenses[0],'A');
});
