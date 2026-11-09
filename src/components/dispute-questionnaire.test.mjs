import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as guide from '../lib/payout-dispute-guide.ts';
import * as presentation from '../lib/dispute-presentation.ts';

const require=createRequire(import.meta.url), mod={exports:{}};
const code=ts.transpileModule(readFileSync(new URL('./dispute-questionnaire.tsx',import.meta.url),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
}).outputText;
new Function('require','module','exports',code)(name=>{
  if(name==='../lib/payout-dispute-guide')return guide;
  if(name==='../lib/dispute-presentation')return presentation;
  if(name.endsWith('.css'))return {default:{}};
  return require(name);
},mod,mod.exports);

function fixture(schedule) {
  const production=[{code:'DELIVERY',label:'Delivery',componentType:'production',count:35,rate:13,amount:455},
    {code:'CRETURN',label:'C-return',componentType:'production',count:2,rate:13,amount:26},
    {code:'SELLER_PICKUP',label:'MFN',componentType:'production',count:0,rate:3,amount:0}];
  const lines=schedule?[...production,{code:'MG',label:'MG',schedule,rate:800,count:1,amount:800}]:production;
  return {item:{work_days:1},worksheet:{production_breakdown:lines},lines:[{source_type:'worksheet',work_date:'2026-10-01',calculation_snapshot:{workDayUnits:1,paymentLines:lines,counts:{totalDelivery:35}}}]};
}
function render(snapshot,value={}) {
  return renderToStaticMarkup(React.createElement(mod.exports.DisputeQuestionnaire,{
    items:guide.disputeItems(snapshot),days:guide.associateDisputeDays(snapshot),value,onChange(){},
  }));
}

test('per-packet form shows production and no work-day option',()=>{
  const html=render(fixture());
  assert.match(html,/Delivery \/ pickup count/);
  assert.doesNotMatch(html,/Missing \/ incorrect work day|Wrong attendance|Work days/);
});
test('selected production date renders real published counts and an editable zero',()=>{
  const s=fixture(),items=guide.productionItems(guide.disputeItems(s));
  const html=render(s,{issue:'production',component:items[0].key,concern:'Count is incorrect',dates:['2026-10-01'],counts:items.map((item,i)=>({date:'2026-10-01',component:item.key,value:[35,2,0][i]}))});
  assert.doesNotMatch(html,/Not in payout/);
  assert.match(html,/<b>35<\/b>/);assert.match(html,/<b>2<\/b>/);assert.match(html,/<b>0<\/b>/);
  assert.match(html,/aria-label="Your MFN count 2026-10-01"[^>]*value="0"/);
});
test('MG/fixed forms retain work days but do not offer half-day complaints without half days',()=>{
  for(const schedule of ['per_day','per_month']){
    const s=fixture(schedule);
    const html=render(s,{issue:'attendance',component:'attendance'});
    assert.match(html,/Missing \/ incorrect work day/);assert.match(html,/Wrong attendance/);
    assert.doesNotMatch(html,/Full day shown as half day/);
    s.lines[0].calculation_snapshot.workDayUnits=.5;
    assert.match(render(s,{issue:'attendance',component:'attendance'}),/Full day shown as half day/);
  }
});
test('production rate dates show delivery evidence, never attendance labels',()=>{
  const s=fixture(),item=guide.productionItems(guide.disputeItems(s))[0];
  const html=render(s,{issue:'production',component:item.key,concern:'Wrong rate'});
  assert.match(html,/35 deliveries/);assert.doesNotMatch(html,/Present|Half day|Not counted/);
});
