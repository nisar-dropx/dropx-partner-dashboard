import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url);
function compile(path,mocks={}){const m={exports:{}};new Function('require','exports','module',ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>id in mocks?mocks[id]:require(id),m.exports,m);return m.exports;}
const pricing=compile('./pricing.ts');const now=compile('./now.ts',{'./pricing':pricing});const cps=compile('../ops-pulse/cps.ts');const pnl=compile('./pnl.ts',{'./pricing':pricing,'../ops-pulse/cps':cps});const cfo=compile('./cfo.ts',{'./now':now});
const {chartReport,evidenceRows,filterCfoDays,cfoComparison,cfoViewHref}=compile('./cfo-detail.ts',{'./pnl':pnl,'./cfo':cfo});
const d={station:'A',sourceStation:'A',name:'Station A',model:'EDSP',region:'North',city:'Different city',cluster:'Team',date:'2026-10-01',unit:'shipments',volume:10,revenue:1000,cost:700,regional:20,da:200,utr:100,van:150,rent:100,other:100,contracts:50,issues:[]};
test('restored chart totals reconcile with operating P&L including contracts and HO exactly once',()=>{
 const days=[d,{...d,station:'B',sourceStation:'B',date:'2026-10-02'}],ho=[{mode:'corporate',date:'2026-10-01',amount:30},{mode:'unallocated',date:'2026-10-02',amount:10}];
 const out=chartReport(days,ho,true),total=cfo.totalCfo(days,40);
 assert.equal(out.total.revenue,total.revenue);assert.equal(out.total.cost,total.expense);assert.equal(out.total.profit,total.profit);
 assert.equal(out.costItems.reduce((s,c)=>s+c.value,0),total.expense);assert.equal(out.daily.reduce((s,c)=>s+c.cost,0),total.expense);
 assert.equal(chartReport(days,ho,false).total.cost,1440);
});
test('Amazon Now categories share one model, region filters do not depend on city, and mixed units stay separate',()=>{
 const days=[d,{...d,station:'N1',model:'Amazon Now M2',unit:'units',volume:25},{...d,station:'N2',model:'Amazon Now M3',unit:'units',volume:30}];
 const picked=filterCfoDays(days,{model:'Amazon Now',region:'North',cluster:'Team',station:''});assert.equal(picked.length,2);assert.equal(cfoComparison(days,'model').length,2);
 assert.equal(cfo.totalCfo(days).volume,null);assert.equal(cfo.totalCfo(picked).volume,55);
});
test('grouped XPT detail preserves source station so individual cost evidence remains scoped',()=>{
 assert.equal(evidenceRows([{...d,sourceStation:'XPT1'}])[0].station,'XPT1');
});
test('missing revenue and cost remain unavailable in the restored charts',()=>{
 const out=chartReport([{...d,revenue:null,cost:null,volume:null,da:0,utr:0,van:0,rent:0,other:0,contracts:0,regional:0}],[],false);assert.equal(out.total.revenue,null);assert.equal(out.total.cost,null);assert.equal(out.total.profit,null);
});
test('region mapping requires an explicit station and region without changing a rate card',()=>{
 assert.deepEqual(now.validateMaster('reporting_region',{station_code:'A',region:' North '}),{station_code:'A',region:'North'});
 assert.throws(()=>now.validateMaster('reporting_region',{station_code:'A',region:''}));
});

test('direct model profitability excludes all HO while the business result deducts it once',()=>{
 const other={...d,station:'N',model:'Amazon Now MFC',unit:'units',revenue:500,cost:600,regional:30};
 const selected=filterCfoDays([d,other],{model:'EDSP',region:'',cluster:'',station:''});
 const model=cfo.totalCfo(selected),business=cfo.totalCfo([d,other],100);
 assert.deepEqual(cfo.profitabilityView(model,false),{expense:700,profit:300,margin:30,cpu:70});
 assert.deepEqual(cfo.profitabilityView(model,true),{expense:720,profit:280,margin:28,cpu:72});
 assert.equal(business.directProfit,200);assert.equal(business.profit,50);
 assert.equal(cfo.profitabilityView(business,false).cpu,null);
 assert.equal(model.directProfit-model.regional,model.profit);
});
test('before-HO charts, daily totals and cost mix agree with direct profit',()=>{
 const out=chartReport([d],[{mode:'corporate',date:d.date,amount:40}],false,false);
 assert.equal(out.total.cost,700);assert.equal(out.total.profit,300);
 assert.equal(out.daily[0].profit,300);assert.equal(out.costItems.reduce((s,c)=>s+c.value,0),700);
 assert.equal(out.costItems.some(c=>/overhead|HO/.test(c.label)),false);
});
test('model, period and HO basis survive refresh URLs, quick dates and escaped model names',()=>{
 const dates={period:'month',month:'2026-09',from:'2026-09-01',to:'2026-09-30'};
 const filters={model:'EDSP & XPT',region:'KL',cluster:'A/B',station:'S1'};
 const q=new URL(cfoViewHref(dates,filters,false),'https://fin.dropxlogistics.com').searchParams;
 assert.equal(q.get('model'),filters.model);assert.equal(q.get('month'),'2026-09');assert.equal(q.get('location'),'S1');assert.equal(q.get('overhead'),'0');
 const refresh=pnl.pnlFilters(Object.fromEntries(q),'2026-10-07');
 assert.equal(refresh.from,'2026-09-01');assert.equal(refresh.to,'2026-09-30');
 const quick=new URL(cfoViewHref({...dates,period:'mtd'},filters,true),'https://fin.dropxlogistics.com').searchParams;
 assert.equal(quick.get('overhead'),'1');assert.equal(quick.get('model'),filters.model);
 assert.equal(pnl.pnlFilters(Object.fromEntries(quick),'2026-10-07').from,'2026-10-01');
});
test('missing direct inputs and zero-volume costs never become fictitious profits or unit rates',()=>{
 const total=cfo.totalCfo([{...d,revenue:null,cost:null,volume:0}],500);
 assert.equal(cfo.profitabilityView(total,false).profit,null);
 assert.equal(cfo.profitabilityView(total,true).profit,null);
 assert.equal(cfo.profitabilityView(total,false).cpu,null);
});
