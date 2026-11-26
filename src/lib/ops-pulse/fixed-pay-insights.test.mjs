import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const m={exports:{}};
new Function('exports','module',ts.transpileModule(readFileSync(new URL('./fixed-pay-insights.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(m.exports,m);
const {fixedPayRows,filterFixedPay,fixedPayChoices,fixedPayTotals}=m.exports;
const clear=()=>({region:[],cluster:[],code:[],payType:[]});
const row=(worker,station,extras={})=>({worker_id:worker,name:worker,dropx_id:worker,station_code:station,cohort:'guarantee',pay_type:'FIXED',provider_ids:[],work_dates:['2026-11-01'],cost_dates:[],periods:[],salary:100,variable:0,fuel:0,deliveries:10,customer_returns:0,...extras});
const locs=[{code:'A',name:'Alpha',region:'KL',cluster:'Manager A'},{code:'B',name:'Beta',region:'AP',cluster:'Manager B'}];
test('only fixed/MG rows in permitted stations enter the view',()=>{
 const r=fixedPayRows([row('1','A'),row('2','B',{cohort:'variable'}),row('3','PRIVATE')],locs);
 assert.equal(r.length,1);assert.equal(r[0].stationName,'Alpha');
});
test('facets use other selections and search, preserving selected zero matches',()=>{
 const r=fixedPayRows([row('1','A'),row('2','B')],locs);
 const f={...clear(),region:['KL'],code:['B']};
 assert.equal(filterFixedPay(r,f,'').length,0);
 assert.deepEqual(fixedPayChoices(r,f,'','code'),['A','B']);
 assert.deepEqual(fixedPayChoices(r,{...clear(),region:['KL']},'','cluster'),['Manager A']);
 assert.equal(filterFixedPay(r,clear(),'alpha').length,1);
 assert.equal(filterFixedPay(r,{...clear(),region:['KL','AP']},'').length,2);
});
test('weighted CPS includes returns, excludes van rent and deduplicates workers and days',()=>{
 const r=fixedPayRows([row('1','A',{salary:100,van:999,deliveries:0}),row('1','A',{pay_type:'MG',salary:200,deliveries:20,customer_returns:10}),row('2','B',{salary:300,deliveries:10})],locs);
 const t=fixedPayTotals(r);assert.equal(t.cost,600);assert.equal(t.cps,15);assert.equal(t.associates,2);assert.equal(t.workDays,2);assert.equal(t.noVolume,0);
});
test('missing inputs and zero volume never appear as zero CPS',()=>{
 assert.equal(fixedPayTotals(fixedPayRows([row('1','A',{pending_fixed_dates:['2026-11-01']})],locs)).cps,null);
 const t=fixedPayTotals(fixedPayRows([row('1','A',{deliveries:0})],locs));assert.equal(t.cps,null);assert.equal(t.noVolume,1);
});
test('facets include choices beyond the first display page',()=>{
 const r=fixedPayRows(Array.from({length:120},(_,i)=>row(String(i),i===119?'B':'A')),locs);
 assert.deepEqual(fixedPayChoices(r,clear(),'','code'),['A','B']);
});
