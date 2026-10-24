import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {renderToStaticMarkup} from 'react-dom/server';
const require=createRequire(import.meta.url);
function compile(path,mocks={}){const m={exports:{}};new Function('require','exports','module',ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(id=>id in mocks?mocks[id]:require(id),m.exports,m);return m.exports;}
const costs=compile('./pnl-cost-heads.ts');
const {expenseSections,groupCostLines,costHead}=costs;
const day={station:'QLDA',sourceStation:'QLDA',date:'2026-10-01',da:1000,utr:100,van:2000,rent:500,other:10,cost:3610};
const line=(head,amount,costHead='Van',source='Approved payment requests',date=day.date)=>({station:'QLDA',sourceStation:'QLDA',date,head,amount,costHead,source,basis:'QLDA'});
const byId=sections=>Object.fromEntries(sections.map(s=>[s.id,s]));
test('vehicle costs occupy disjoint heads and driver pay joins associates without altering total',()=>{
 const lines=[line('Variable delivery pay',1000,'DA','Workforce rate card'),line('Vehicle rent · VAN1',800,'Van','Fleet Vehicle Master'),line('Adhoc Van',400),line('Vehicle Service/Maintanace',200),line('Vehicle Repair / Tyre',100),line('Van Fuel',100),line('BPCL fuel',200,'Van','Fuel import'),line('Adhoc Driver',150),line('Other Expenses',50)];
 const sections=expenseSections([day],lines),h=byId(sections);
 assert.equal(h.DA.amount,1150);assert.equal(h.VanRent.amount,800);assert.equal(h.AdhocVan.amount,400);assert.equal(h.VanMaintenance.amount,300);assert.equal(h.VanFuel.amount,300);assert.equal(h.VanOther.amount,50);
 assert.equal(sections.reduce((s,h)=>s+Math.round(h.amount*100),0),361000);
 assert.equal(sections.flatMap(h=>h.lines).length,lines.length);
});
test('fuel card, cashbook and approved van fuel combine while DA allowances stay in associate payout',()=>{
 for(const source of ['Cashbook','Approved payment requests','Fuel import'])assert.equal(costHead(line('Van Fuel',100,'Van',source)),'VanFuel');
 assert.equal(costHead(line('DA fuel',100,'DA','Workforce rate card')),'DA');
 assert.equal(costHead(line('Facility maintenance',100,'Rent','Rent Master')),'Rent');
 assert.equal(costHead(line('Other Expenses',100)),'VanOther');
});
test('ad hoc approvals group once and retain every dated amount, including reversals',()=>{
 const groups=groupCostLines([line('Adhoc Van',100),line('Adhoc Van',200,'Van','Approved payment requests','2026-10-02'),line('Adhoc Van',-50,'Van','Approved payment requests','2026-10-03')]);
 assert.equal(groups.length,1);assert.equal(groups[0].amount,250);assert.equal(groups[0].entries.length,3);
});
test('XPT source stations and exact dates prevent cross-model or cross-period detail leakage',()=>{
 const days=[{...day,sourceStation:'XPT1',van:100,da:0,utr:0,rent:0,other:0}];
 const inside={...line('Van Fuel',100),sourceStation:'XPT1'};
 const out=expenseSections(days,[inside,line('Van Fuel',9999),{...inside,date:'2026-10-02',amount:8888},{...inside,sourceStation:'XPT2',amount:7777}]);
 assert.equal(out.reduce((s,h)=>s+h.amount,0),100);assert.deepEqual(out.flatMap(h=>h.lines),[inside]);
});
test('contract settlement is not counted again and unknown source differences are kept visible',()=>{
 const out=expenseSections([day],[line('Security contract',500,'Other','Finance contract'),line('Vehicle rent · VAN1',800,'Van','Fleet Vehicle Master')]);
 assert.equal(out.reduce((s,h)=>s+h.amount,0),3610);assert.equal(byId(out).VanOther.residual,1200);assert.equal(byId(out).VanRent.amount,800);
});
test('rounding and zero blocked days preserve the canonical cost exactly',()=>{
 const lines=[line('Vehicle rent · VAN1',483.87,'Van','Fleet Vehicle Master'),line('Vehicle rent · VAN1',0,'Van','Fleet Vehicle Master','2026-10-02')];
 const out=expenseSections([{...day,da:0,utr:0,rent:0,other:0,van:483.87},{...day,date:'2026-10-02',da:0,utr:0,rent:0,other:0,van:0}],lines);
 assert.equal(byId(out).VanRent.amount,483.87);assert.equal(groupCostLines(out.flatMap(h=>h.lines))[0].entries.length,2);
});
test('cost drilldown renders one group total, with no duplicate source-ledger total',()=>{
 const {CostSourceGroups}=compile('../../app/finance/profitability/expense-details.tsx',{'@/lib/finance/pnl-cost-heads':costs});
 const html=renderToStaticMarkup(CostSourceGroups({lines:[line('Adhoc Van',100),line('Adhoc Van',200)]}));
 assert.equal((html.match(/<details/g)||[]).length,1);assert.match(html,/₹300.00/);assert.match(html,/₹100.00/);assert.match(html,/₹200.00/);assert.doesNotMatch(html,/Daily source ledger/);
});
test('fuel transactions replace aggregate rows only when their sum matches the included cost',()=>{
 const {CostSourceGroups}=compile('../../app/finance/profitability/expense-details.tsx',{'@/lib/finance/pnl-cost-heads':costs});
 const lines=[line('BPCL fuel',200,'Van','Fuel import')],fuel=[{id:'f1',station_code:'QLDA',transaction_date:day.date,provider:'BPCL',transaction_id:'TXN1',amount:125,litres:1},{id:'f2',station_code:'QLDA',transaction_date:day.date,provider:'BPCL',transaction_id:'TXN2',amount:75,litres:1}];
 const html=renderToStaticMarkup(CostSourceGroups({lines,evidence:{fuel,vehicles:[]}}));assert.match(html,/TXN1/);assert.match(html,/TXN2/);assert.equal((html.match(/<tbody><tr/g)||[]).length,1);
 const stale=renderToStaticMarkup(CostSourceGroups({lines,evidence:{fuel:fuel.slice(0,1),vehicles:[]}}));assert.doesNotMatch(stale,/TXN1/);assert.match(stale,/₹200.00/);
});

test('a head with one item expands straight to dates without another identical total row',()=>{
 const {CostSourceGroups}=compile('../../app/finance/profitability/expense-details.tsx',{'@/lib/finance/pnl-cost-heads':costs});
 const html=renderToStaticMarkup(CostSourceGroups({lines:[line('Adhoc Van',100),line('Adhoc Van',200)],flattenSingle:true}));
 assert.doesNotMatch(html,/<details|₹300.00/);assert.match(html,/₹100.00/);assert.match(html,/₹200.00/);
});
