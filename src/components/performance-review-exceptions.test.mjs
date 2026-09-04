import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require=createRequire(import.meta.url);
const compiled=ts.transpileModule(readFileSync(new URL('./performance-review-exceptions.tsx',import.meta.url),'utf8'),{
  compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
}).outputText;
const mod={exports:{}};
new Function('require','exports','module',compiled)(name=>name.startsWith('@/')?{}:require(name),mod.exports,mod);
const render=props=>renderToStaticMarkup(React.createElement(mod.exports.PerformanceReviewExceptions,props));
const review={id:'review',status:'in_review',current_step_order:1,source_date:'2026-09-03',station_code:'TEST'};
const steps=[{id:'step',step_order:1,status:'pending',reviewer_name:'Manager'}];
const base={review,steps,canAccessBypass:true,canAccessProxy:true,canBypass:true,canProxy:true,canStart:true,hasRoute:true};
test('unstarted station shows both disabled tools, guidance and no mutation form',()=>{
  const html=render({...base,review:null,steps:[],canProxy:false});
  assert.match(html,/Conduct proxy review/);assert.match(html,/Skip a level/);
  assert.equal((html.match(/disabled=""/g)||[]).length,2);
  assert.match(html,/Start review first for this station and date/);
  assert.match(html,/href="#start-station-review"/);assert.ok(!html.includes('<form'));
});
test('active review enables both authorised tools',()=>{
  const html=render(base);assert.ok(!html.includes('disabled='));assert.match(html,/Conduct proxy review/);assert.match(html,/Skip a level/);
});
test('completed review stays discoverable but cannot be changed',()=>{
  const html=render({...base,review:{...review,status:'closed'},steps:[]});
  assert.equal((html.match(/disabled=""/g)||[]).length,2);assert.match(html,/Review completed/);
});
test('missing manager explains the issue without suggesting start',()=>{
  const html=render({...base,review:null,steps:[],hasRoute:false});
  assert.match(html,/Contact HR/);assert.ok(!html.includes('href="#start-station-review"'));
});
test('own assigned level explains why proxy is not needed while skip is available',()=>{
  const html=render({...base,canProxy:false});
  assert.equal((html.match(/disabled=""/g)||[]).length,1);assert.match(html,/This is your assigned review level/);
});
test('read-only station accounts never see exception tools',()=>{
  assert.equal(render({...base,canAccessProxy:false,canAccessBypass:false,canProxy:false,canBypass:false}),'');
});
