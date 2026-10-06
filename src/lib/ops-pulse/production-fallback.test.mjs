import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const m={exports:{}};
new Function('exports','module',ts.transpileModule(readFileSync(new URL('./production-fallback.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(m.exports,m);
const estimate=m.exports.historicalProductionEstimate;
const policy={field_code:'KM_RUN',mode:'associate_then_station',lookback_months:3,minimum_history_days:1,effective_from:'2026-09-01'};
const h={id:'1',workforce_id:'w',station_id:'s',payment_field_id:'f',field_code_snapshot:'KM_RUN',units:1500,period_from:'2026-09-01',period_to:'2026-09-30',work_days:25};
const input={policies:[policy],history:[h],workforceId:'w',stationId:'s',fieldCode:'KM_RUN',date:'2026-10-05',worked:true};
test('monthly total uses worked days, not upload day or calendar days',()=>assert.equal(estimate(input).units,60));
test('station fallback is weighted by worked days and remains station-scoped',()=>{
 const result=estimate({...input,workforceId:'new',history:[h,{...h,id:'2',workforce_id:'w2',units:1000,work_days:10},{...h,id:'3',station_id:'elsewhere',units:50000}]});
 assert.equal(result.basis,'station average');assert.equal(result.units,2500/35);
});
test('no future or overlapping-current-period leakage',()=>{
 assert.equal(estimate({...input,date:'2026-09-10'}),undefined);
 assert.equal(estimate({...input,history:[{...h,period_from:'2026-11-01',period_to:'2026-11-30'}]}),undefined);
});
test('no work, no policy, disabled, insufficient and ambiguous history stay missing',()=>{
 for(const patch of [{worked:false},{policies:[]},{policies:[{...policy,mode:'disabled'}]},{history:[{...h,work_days:0}]},{history:[h,{...h,id:'duplicate'}]},{stationId:'unknown'}]) assert.equal(estimate({...input,...patch}),undefined);
});
test('actual zero history is a valid zero average',()=>assert.equal(estimate({...input,history:[{...h,units:0}]}).units,0));
test('effective revision can disable fallback and associate-only cannot borrow station',()=>{
 assert.equal(estimate({...input,policies:[policy,{...policy,mode:'disabled',effective_from:'2026-10-01'}]}),undefined);
 assert.equal(estimate({...input,workforceId:'new',policies:[{...policy,mode:'associate_average'}]}),undefined);
});

test('overall average is opt-in and works when station history is absent',()=>{
 const result=estimate({...input,stationId:'new-station',policies:[{...policy,mode:'associate_station_company'}]});
 assert.equal(result.basis,'company average');assert.equal(result.units,60);
});
