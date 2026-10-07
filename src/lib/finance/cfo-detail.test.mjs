import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url);
function compile(path,mocks={}){const m={exports:{}};new Function('require','exports','module',ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>id in mocks?mocks[id]:require(id),m.exports,m);return m.exports;}
const pricing=compile('./pricing.ts');const now=compile('./now.ts',{'./pricing':pricing});const cps=compile('../ops-pulse/cps.ts');const pnl=compile('./pnl.ts',{'./pricing':pricing,'../ops-pulse/cps':cps});const cfo=compile('./cfo.ts',{'./now':now});
const {chartReport,evidenceRows,filterCfoDays,cfoComparison}=compile('./cfo-detail.ts',{'./pnl':pnl,'./cfo':cfo});
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
