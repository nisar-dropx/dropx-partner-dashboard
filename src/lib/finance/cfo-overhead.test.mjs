import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const m={exports:{}};new Function('exports','module',ts.transpileModule(readFileSync(new URL('./cfo-overhead.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(m.exports,m);
const {weightedShares,regionalPolicy,regionalShares,corporateShares}=m.exports;
const day=(station,volume,revenue=100,unit='shipments')=>({station,sourceStation:station,date:'2026-10-01',model:unit==='units'?'Amazon Now MFC':'EDSP',unit,volume,revenue,cost:50});
test('regional HO follows delivered weights, not equal stations; signed paise are conserved',()=>{
 const result=regionalShares({date:'2026-10-01',amount:100.01,recipients:['A','B']},[day('A',10),day('B',30)]);
 assert.deepEqual(result.shares,{A:25,B:75.01});assert.equal(result.basis,'delivered volume');
 assert.equal(Object.values(weightedShares(-100.01,{A:10,B:30})).reduce((n,v)=>Math.round((n+v)*100)/100,0),-100.01);
});
test('Amazon Now regional HO uses revenue even when units are unavailable',()=>{
 assert.deepEqual(regionalShares({date:'2026-10-01',amount:100,recipients:['A','B']},[day('A',null,200,'units'),day('B',null,800,'units')]).shares,{A:20,B:80});
});
test('missing recipients or incompatible units keep HO unallocated',()=>{
 assert.match(regionalShares({date:'2026-10-01',amount:100,recipients:['A','B']},[day('A',10)]).issue,/Missing/);
 assert.match(regionalShares({date:'2026-10-01',amount:100,recipients:['A','B']},[day('A',10),day('B',20,100,'units')]).issue,/Mixed/);
});
test('XPT shares preserve original source station and month boundaries',()=>{
 const result=regionalShares({date:'2026-10-01',amount:100,recipients:['A','XPT']},[day('A',30),{...day('XPT',10),station:'A'},{...day('A',1000),date:'2026-09-01'}]);
 assert.deepEqual(result.shares,{A:75,XPT:25});
});
test('regional topology excludes HO/hidden and corporate remains separate',()=>{
 const locations=[{station_code:'A',state:'Kerala'},{station_code:'X',state:'KL',hide_from_location_list:true},{station_code:'HO_CLT',state:'Kerala',is_ho:true},{station_code:'B',state:'Odisha'}];
 assert.deepEqual(regionalPolicy('HO_KL','2026-10-01',locations,[]),{mode:'regional',recipients:['A']});
 assert.equal(regionalPolicy('HO_MJR','2026-10-01',locations,[]).mode,'corporate');
});
test('corporate revenue split uses all verticals once and reports unavailable revenue',()=>{
 const rows=[day('A',10,750),day('B',null,250,'units')],overhead=[{date:'2026-10-01',mode:'corporate',amount:100},{date:'2026-10-01',mode:'regional',amount:200}];
 const result=corporateShares(rows,overhead);assert.deepEqual(Object.fromEntries(result.shares.map(s=>[s.model,s.amount])),{'Amazon Now':25,EDSP:75});
 const missing=corporateShares([rows[0],{...rows[1],revenue:null}],overhead);assert.equal(missing.shares.length,0);assert.match(missing.issues[0],/unavailable/);
});
