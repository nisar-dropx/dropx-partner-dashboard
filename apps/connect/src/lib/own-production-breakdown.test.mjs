import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createRequire} from 'node:module';import ts from 'typescript';import {createElement} from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {ownProductionBreakdown,reconcileOwnProduction} from './own-production-breakdown.ts';
const day=(x={})=>({id:'a',date:'2026-09-01',baseAmount:133.33,incentiveAmount:30,amount:163.33,deliveries:10,calculationSource:'workforce_rate_card',payType:'fixed_daily',...x});
const days=()=>[day(),day({id:'b',baseAmount:666.67,incentiveAmount:150,amount:816.67,deliveries:50})];
test('two own IDs explain one daily guarantee and one incentive total',()=>{
 const result=ownProductionBreakdown(days());assert.equal(result.baseAmount,800);assert.equal(result.incentiveAmount,180);assert.equal(result.amount,980);assert.equal(result.deliveries,60);assert.equal(result.workDays,1);
 assert.deepEqual(result.groups,[{key:'fixed_daily',label:'Fixed daily pay',amount:800,days:1}]);
});
test('different effective pay types remain explicit without multiplying old mapping rates',()=>{
 const result=ownProductionBreakdown([day({payType:'fixed_monthly'}),day({id:'b',date:'2026-09-02',payType:'hybrid'}),day({id:'c',date:'2026-09-03',calculationSource:'provider_mapping',payType:'provider_mapping'})]);
 assert.equal(result.groups.length,3);assert.ok(result.groups.some(g=>g.label.includes('calendar-day')));assert.ok(result.groups.some(g=>g.label.includes('Daily guarantee')));
});
test('monthly adjustments stay outside daily production and rows sort newest first',()=>{
 const input=[{daily:days()},{daily:[day({id:'c',date:'2026-09-02',baseAmount:20,incentiveAmount:0,amount:20})]}];
 const result=reconcileOwnProduction(input,{baseAmount:820,incentiveAmount:180,additions:200,deductionAmount:25,netAmount:1175});
 assert.deepEqual(result.map(d=>d.date),['2026-09-02','2026-09-01']);assert.equal(result.reduce((sum,d)=>sum+d.amount,0),1000);
});
test('duplicates, bad dates, invalid amounts, quantities and unknown pay basis fail closed',()=>{
 assert.throws(()=>ownProductionBreakdown([day(),day()]));
 for(const x of [{date:'2026-09-31'},{baseAmount:NaN},{baseAmount:-1},{baseAmount:133.331},{amount:999},{deliveries:1.5},{payType:'mystery'},{payType:'toString'},{calculationSource:'unknown'}])assert.throws(()=>ownProductionBreakdown([day(x)]));
 assert.throws(()=>ownProductionBreakdown([null]));
});
test('monthly mismatch fails while legitimate negative net and empty production remain explicit',()=>{
 const summary={baseAmount:800,incentiveAmount:180,additions:200,deductionAmount:25,netAmount:1155};
 for(const x of [{baseAmount:801},{incentiveAmount:181},{netAmount:1156},{netAmount:1155.001},{netAmount:NaN}])assert.throws(()=>reconcileOwnProduction([{daily:days()}],{...summary,...x}));
 assert.deepEqual(reconcileOwnProduction([],{baseAmount:0,incentiveAmount:0,additions:0,deductionAmount:25,netAmount:-25}),[]);
});
test('rendered breakdown uses calculated amounts and a compact combined-ID basis',()=>{
 const source=readFileSync(new URL('../components/connect-production-breakdown.tsx',import.meta.url),'utf8');
 const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,module={exports:{}},require=createRequire(import.meta.url);
 new Function('require','exports',output)(name=>name==='@/lib/own-production-breakdown'?{ownProductionBreakdown}:name.endsWith('.module.css')?{}:require(name),module.exports);
 const html=renderToStaticMarkup(createElement(module.exports.ConnectProductionBreakdown,{days:days()}));
 for(const text of ['Fixed daily pay','₹800','₹180','₹980','combined across IDs'])assert.ok(html.includes(text),text);
 for(const repeatedHelp of ['not paid once per ID','not a paid balance'])assert.ok(!html.includes(repeatedHelp),repeatedHelp);
 assert.doesNotMatch(html,/×/);
 for(const path of ['../components/connect-workforce-payments.tsx','../components/connect-my-earnings.tsx']){
  const ui=readFileSync(new URL(path,import.meta.url),'utf8');assert.match(ui,/ConnectProductionBreakdown/);assert.match(ui,/reconcileOwnProduction/);assert.doesNotMatch(ui,/rateLines\.map|production\.map/);
 }
});
test('daily detail stacks below its header despite legacy ledger styles',()=>{
 const ui=readFileSync(new URL('../components/connect-workforce-payments.tsx',import.meta.url),'utf8');
 const css=readFileSync(new URL('../components/connect-workforce-payments.module.css',import.meta.url),'utf8');
 assert.match(ui,/dx-workforce-ledger \$\{paymentStyles\.ledger\}/);
 assert.match(css,/\.ledger\.ledger\s*>\s*div\s*>\s*article\s*\{\s*display:\s*block;\s*padding:\s*0;/);
 assert.match(css,/:focus-visible/);
});
